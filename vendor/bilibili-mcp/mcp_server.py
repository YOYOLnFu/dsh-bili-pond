#!/usr/bin/env python3
"""
Bilibili MCP Server
B站数据采集 MCP 服务，支持 OpenClaw / Claude Code / Cursor / Cline

功能：搜索视频、抓取评论、获取字幕、弹幕、回复评论
首次运行需扫码登录B站，凭证自动保存复用
"""

# ⭐ 这个文件是从上游 AGI_Ananas/bilibili-mcp（MIT，见同目录 LICENSE）vendor 进来的。
#    本插件在它上面只加了下面这几处 —— **将来重新 vendor 时，这几处要原样补回来**（漏一处就少一道闸 ✗）：
#      ① `_ALLOWED` + `tool()` 白名单替身：工具按名单注册，名单外的连名字都不出现（见下）
#      ② `load_credential` 读取容错 + encoding="utf-8" + isinstance(data, dict) 校验
#      ③ 登录成功后凭证**原子写**（先写 .tmp 再 os.replace）
#      ④ `bili_comments` 把抓取异常带进返回（风控 -412 不再伪装成"这条视频 0 条评论"）
#      ⑤ `bili_reply` 回执带上 `rpid` / `rpid_str` / `root` / `parent`（判重表与评论复核要用）
#      ⑥ `bili_comments` 加 `order`（time/like）+ 每条评论补 `mid`、子评论补 `rpid/root/parent/mid`
#         （守护评论区要拿 id 精准回复；按热度排看不见新评论）
#      ⑦ 新增 `bili_guard_scan`：@ 通道 + 指定视频新评论的增量扫描，一次给全值班轮要的字段
#      ⑧ `_guard_log()` + `bili_reply` 落记录：真发出去的回复写进 `BILI_GUARD_LOG`（jsonl），
#         给界面「守护记录」用 —— 模型的自我汇报不能当证据，这一层才知道成没成
#      ⑨ 新增 `bili_like` / `bili_fav`：Video 只给了 like/has_liked，收藏得走原始 HTTP（`_bili_api`）
#      ⑩ `_comment_state()` 单查评论存活：`bili_reply` 发送前、`bili_circle_reply` 找不到目标时用它分清
#         「已删」和「掉出前 100 条窗口」，不再把两种原因混成一句话
import asyncio
import json
import base64
import os
import re
import sys
import tempfile
import time
from pathlib import Path
from mcp.server.fastmcp import FastMCP

from bilibili_api import video, search, comment, Credential, dynamic, opus
from bilibili_api import hot, rank, user, session, favorite_list
from bilibili_api.video_uploader import (
    VideoUploader, VideoUploaderPage, VideoMeta, Lines,
)
from bilibili_api.utils.picture import Picture
from bilibili_api.login_v2 import QrCodeLogin, QrCodeLoginEvents

# ========== 初始化 ==========

CRED_FILE = Path(__file__).parent / "bili_credential.json"

mcp = FastMCP("bilibili-mcp")

# ⭐ 工具白名单（2026-10-17 审查里的 H3）：宿主通过 overlay 的 env 下发 BILI_MCP_TOOLS（逗号分隔）。
#    · 不给这个变量 ⇒ **全放**（手工跑、或老配置，行为一点不变 ✓）
#    · 给了 ⇒ 只注册名单里的；不在名单里的工具**连名字都不会出现在 list_tools 里**，
#      模型那边等于根本不存在 —— 这才是真的闸门（光靠提示词说"别用"不算）✓
_ALLOWED = {t.strip() for t in os.environ.get("BILI_MCP_TOOLS", "").split(",") if t.strip()}


def tool():
    """@tool() 的替身：白名单里没有这个函数名，就原样返回、**不注册**。"""
    def deco(fn):
        if _ALLOWED and fn.__name__ not in _ALLOWED:
            return fn
        return mcp.tool()(fn)
    return deco


def load_credential() -> Credential:
    """从文件加载凭证"""
    if not CRED_FILE.exists():
        return None
    try:
        with open(CRED_FILE, encoding="utf-8") as f:
            data = json.load(f)
    except (OSError, ValueError) as e:
        # ⚠️ 文件写坏一次（上一次写被打断）会让**所有**工具一起 JSONDecodeError：
        #    这里退化成「没登录」，重新扫一次码就能恢复。（2026-10-16 审查修）
        print(f"[bili-mcp] 凭证读不了（{type(e).__name__}: {e}）：{CRED_FILE}", file=sys.stderr)
        return None
    if not isinstance(data, dict):
        return None
    return Credential(
        sessdata=data.get("sessdata", ""),
        bili_jct=data.get("bili_jct", ""),
        buvid3=data.get("buvid3") or "",
        dedeuserid=data.get("dedeuserid", ""),
    )


# ========== 登录会话（进程级缓存） ==========

_login_session: QrCodeLogin | None = None


def get_cred() -> Credential:
    """获取凭证，未登录时引导用户调用 bili_login"""
    cred = load_credential()
    if not cred:
        raise Exception("未登录B站！请先调用 bili_login 工具获取登录二维码，让用户扫码登录。")
    return cred


# ========== 原始 HTTP：SDK 没有的能力（收藏、单条评论核对） ==========

_BILI_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
            "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36")


_RISK_CODES = (-352, -412, -799, -509)  # 连点/风控常见码，宿主靠文案里的 code 熔断


def _risk_text(code, msg: str = "") -> str:
    """code + message 一行；风控码额外带「风控」二字，宿主要靠它停 30 分钟。"""
    code = int(code or 0)
    return f"{'风控拦截 ' if code in _RISK_CODES else ''}code={code} {msg or ''}".strip()


def _brief_error(e: Exception) -> str:
    """异常压成一行短文案：模型要的是「为什么没成」，不是栈。"""
    code = getattr(e, "code", None)
    if code is None:
        return f"{type(e).__name__}: {e}"
    return _risk_text(code, getattr(e, "msg", "") or str(e))


def _norm_bvid(bvid: str) -> str:
    """统一成 BV 开头再去打接口：粘贴带来的空格、小写前缀都忍，不像 BV 号就回空串。"""
    v = re.sub(r"\s+", "", str(bvid or ""))
    return "BV" + v[2:] if re.match(r"(?i)^bv[0-9a-z]{10}$", v) else ""


async def _bili_api(method: str, url: str, cred: Credential, params: dict = None, data: dict = None) -> dict:
    """带登录态打 B站 web 接口（cookie 直接取 cred.get_cookies()，csrf 由调用方填 bili_jct）。"""
    import aiohttp
    async with aiohttp.ClientSession() as sess:
        async with sess.request(
            method, url,
            params=params, data=data,
            headers={"User-Agent": _BILI_UA, "Referer": "https://www.bilibili.com/"},
            cookies=cred.get_cookies(),
            timeout=aiohttp.ClientTimeout(total=15),
        ) as resp:
            try:
                return await resp.json(content_type=None)
            except Exception:
                return {"code": -1, "message": f"HTTP {resp.status} 返回非 JSON"}


async def _comment_state(rpid: int, aid: int, cred: Credential) -> str:
    """单查一条评论还在不在，返回 gone / exists / unknown。

    x/v2/reply/reply 传 root=rpid：一级评论回它自己，楼中楼回它所在的楼 ——
    所以 exists 只证明「这一楼还在」，删子评论不会报 12006，不能反证那条楼中楼还在。
    """
    try:
        resp = await _bili_api("GET", "https://api.bilibili.com/x/v2/reply/reply", cred,
                               params={"type": 1, "oid": int(aid), "root": int(rpid), "pn": 1, "ps": 1})
    except Exception:
        return "unknown"
    data = resp.get("data") if isinstance(resp.get("data"), dict) else {}
    root = data.get("root") if isinstance(data.get("root"), dict) else {}
    if resp.get("code") == 0 and int(root.get("rpid") or 0) > 0:
        return "exists"
    if resp.get("code") == 12006:  # 接口原文：没有该评论
        return "gone"
    return "unknown"


# ========== Tool: 扫码登录（生成二维码） ==========

@tool()
async def bili_login() -> str:
    """
    生成B站登录二维码，返回二维码图片（base64）供用户扫码。
    用户扫码后，调用 bili_login_check 检查登录状态。

    Returns:
        包含二维码base64图片数据的JSON，前端可直接渲染为图片展示给用户
    """
    global _login_session

    # 如果已有凭证，直接返回
    cred = load_credential()
    if cred:
        return json.dumps({
            "status": "already_logged_in",
            "message": "已登录B站，无需重复登录",
        }, ensure_ascii=False)

    # 生成新的登录会话
    _login_session = QrCodeLogin()
    await _login_session.generate_qrcode()

    # 获取二维码图片的 base64（无损PNG）
    pic = _login_session.get_qrcode_picture()
    img_base64 = base64.b64encode(pic.content).decode("utf-8")

    # 保存二维码图片到项目根目录
    qr_file = Path(__file__).parent / "qrcode_login.png"
    with open(qr_file, "wb") as f:
        f.write(pic.content)

    # 获取终端文本版二维码（纯文本客户端备用）
    terminal_qr = _login_session.get_qrcode_terminal()

    # 获取原始扫码URL（用户也可以手动在B站App打开）
    qr_url = getattr(_login_session, "_QrCodeLogin__qr_link", "")

    return json.dumps({
        "status": "qrcode_ready",
        "message": "请用B站App扫描二维码登录（180秒内有效）",
        "qrcode_image": f"data:image/png;base64,{img_base64}",
        "qrcode_file": str(qr_file),
        "qrcode_terminal": terminal_qr,
        "qrcode_url": qr_url,
        "next_step": "用户扫码后，请调用 bili_login_check 检查登录状态",
    }, ensure_ascii=False)


# ========== Tool: 检查登录状态 ==========

@tool()
async def bili_login_check() -> str:
    """
    检查B站扫码登录状态。在用户扫码后调用此工具。
    如果返回 "scanning" 或 "confirming"，请等待几秒后再次调用。
    如果返回 "done"，登录成功，可以使用其他工具了。
    如果返回 "timeout"，需要重新调用 bili_login 生成新二维码。

    Returns:
        当前登录状态
    """
    global _login_session

    if not _login_session:
        # 没有登录会话，检查是否已登录
        cred = load_credential()
        if cred:
            return json.dumps({
                "status": "already_logged_in",
                "message": "已登录B站",
            }, ensure_ascii=False)
        return json.dumps({
            "status": "no_session",
            "message": "没有进行中的登录，请先调用 bili_login 生成二维码",
        }, ensure_ascii=False)

    state = await _login_session.check_state()

    if state == QrCodeLoginEvents.SCAN:
        return json.dumps({
            "status": "scanning",
            "message": "已扫码，等待用户在手机上确认...",
            "next_step": "请等待3秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.CONF:
        return json.dumps({
            "status": "confirming",
            "message": "用户已确认，正在处理...",
            "next_step": "请等待2秒后再次调用 bili_login_check",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.TIMEOUT:
        _login_session = None
        # 清理二维码文件
        qr_file = Path(__file__).parent / "qrcode_login.png"
        if qr_file.exists():
            qr_file.unlink()
        return json.dumps({
            "status": "timeout",
            "message": "二维码已过期，请重新调用 bili_login 生成新二维码",
        }, ensure_ascii=False)

    elif state == QrCodeLoginEvents.DONE:
        # 登录成功，保存凭证
        cred = _login_session.get_credential()
        # ⚠️ 原子写：原来直接 open(w) 先截断再 dump，写到一半被打断就毁掉旧凭证，
        #    此后所有工具都读不了。（2026-10-16 审查修）
        tmp_cred = CRED_FILE.with_name(CRED_FILE.name + ".tmp")
        with open(tmp_cred, "w", encoding="utf-8") as f:
            json.dump({
                "sessdata": cred.sessdata,
                "bili_jct": cred.bili_jct,
                "buvid3": cred.buvid3,
                "dedeuserid": cred.dedeuserid,
            }, f)
        os.replace(tmp_cred, CRED_FILE)
        _login_session = None
        # 清理二维码文件
        qr_file = Path(__file__).parent / "qrcode_login.png"
        if qr_file.exists():
            qr_file.unlink()
        return json.dumps({
            "status": "done",
            "message": "登录成功！凭证已保存，现在可以使用所有B站功能了",
        }, ensure_ascii=False)

    return json.dumps({
        "status": "unknown",
        "message": f"未知状态: {state}",
    }, ensure_ascii=False)


# ========== Tool: 登录状态查询 ==========

@tool()
async def bili_check_credential() -> str:
    """
    检查当前B站登录凭证是否有效

    Returns:
        登录状态信息
    """
    cred = load_credential()
    if not cred:
        return json.dumps({
            "logged_in": False,
            "message": "未登录，请调用 bili_login 进行扫码登录",
        }, ensure_ascii=False)

    # 尝试用凭证请求一下，验证是否过期
    try:
        my_info = await user.User(
            uid=int(cred.dedeuserid), credential=cred
        ).get_user_info()
        return json.dumps({
            "logged_in": True,
            "uid": cred.dedeuserid,
            "username": my_info.get("name", ""),
            "message": "凭证有效",
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "logged_in": False,
            "message": f"凭证可能已过期: {str(e)}，请重新调用 bili_login 登录",
        }, ensure_ascii=False)


# ========== Tool 1: 搜索视频 ==========

@tool()
async def bili_search(keyword: str, num: int = 10, order: str = "totalrank") -> str:
    """
    搜索B站视频

    Args:
        keyword: 搜索关键词，如"AI Agent"、"大模型教程"
        num: 返回视频数量，默认10，最大50
        order: 排序方式 totalrank=综合 click=播放量 pubdate=最新 dm=弹幕
    
    Returns:
        JSON格式的视频列表，包含标题、BV号、播放量、评论数、UP主等
    """
    order_map = {
        "totalrank": search.OrderVideo.TOTALRANK,
        "click": search.OrderVideo.CLICK,
        "pubdate": search.OrderVideo.PUBDATE,
        "dm": search.OrderVideo.DM,
    }
    order_enum = order_map.get(order, search.OrderVideo.TOTALRANK)

    result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=order_enum,
    )

    videos = []
    for item in result.get("result", [])[:num]:
        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        videos.append({
            "bvid": item.get("bvid", ""),
            "aid": item.get("aid", 0),
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
            "danmaku": item.get("video_review", 0),
            "duration": item.get("duration", ""),
            "description": item.get("description", "")[:200],
        })

    return json.dumps({"keyword": keyword, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 2: 获取评论 ==========

@tool()
async def bili_comments(bvid: str, num: int = 30, order: str = "like") -> str:
    """
    获取B站视频的评论（可按热度或按时间）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
        num: 获取评论数量，默认30
        order: 排序方式："like"=按点赞热度（默认），"time"=按时间倒序（最新在前）。
               值班轮要"发现新评论"时必须用 "time" —— 按热度排的话，一条刚发出、
               还没人点赞的新评论会排到很后面，翻多少页都看不见。非法值按 "like" 处理。

    Returns:
        JSON格式的评论列表，包含用户名、评论内容、点赞数、回复数
        （另带每条评论的 mid / rpid，以及 top_replies 里子评论的 rpid/root/parent/mid，
          —— 值班轮要拿这些 id 去 bili_reply 精准回复，不能靠昵称猜）
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    # ⚠️ 别把 order 直接透传给 SDK：comment.OrderType 是枚举，传个不认识的字符串会在
    #    SDK 内部抛错，把「排序参数写错」伪装成「抓评论失败」。这里显式映射、兜底 LIKE。
    order_map = {
        "like": comment.OrderType.LIKE,
        "time": comment.OrderType.TIME,
    }
    order_enum = order_map.get((order or "").strip().lower(), comment.OrderType.LIKE)

    comments = []
    page = 1
    fetch_error = None
    while len(comments) < num:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=order_enum,
                credential=cred,
            )
            replies = resp.get("replies") or []
            if not replies:
                break

            for r in replies:
                member = r.get("member", {})
                content = r.get("content", {})
                c = {
                    "rpid": r.get("rpid", 0),
                    "user": member.get("uname", ""),
                    "content": content.get("message", ""),
                    "like": r.get("like", 0),
                    "reply_count": r.get("rcount", 0),
                    # "time" 是老字段（= ctime），别改名：老调用方还在按 "time" 读，
                    # 改名等于把它们的判重/时间窗静默清零。
                    "time": r.get("ctime", 0),
                    # mid 是评论者的 uid：回复/去重/黑名单都得靠 id，昵称会重名、会改。
                    "mid": int(member.get("mid", 0) or 0),
                }
                # 子评论
                # ⚠️ 原来只取 2 条且只留 user/content/like —— 值班轮要靠 rpid/root/parent
                #    才能回楼中楼（bili_reply 的 rpid/root 就是这三个值），丢了就只能新发一条评论。
                #    取 3 条是因为常见"UP 主回复 + 两条追问"的形态，2 条会漏掉最新那条。
                sub_replies = []
                for sub in (r.get("replies") or [])[:3]:
                    sub_member = sub.get("member") or {}
                    sub_replies.append({
                        "user": sub_member.get("uname", ""),
                        "content": (sub.get("content") or {}).get("message", ""),
                        "like": sub.get("like", 0),
                        "rpid": sub.get("rpid", 0),
                        "root": sub.get("root", 0),
                        "parent": sub.get("parent", 0),
                        "mid": int(sub_member.get("mid", 0) or 0),
                    })
                if sub_replies:
                    c["top_replies"] = sub_replies
                comments.append(c)

            page += 1
            await asyncio.sleep(0.5)
        except Exception as e:
            # ⚠️ 抓取失败（风控 -412 / 网络错）不能吞成「这条视频 0 条评论」：
            #    调用方必须能分辨「真没评论」和「没抓到」，否则日报静默失真。（2026-10-16 审查修）
            fetch_error = f"{type(e).__name__}: {e}"
            break

    owner = info.get("owner") or {}
    out = {
        "bvid": bvid,
        "count": len(comments[:num]),
        "comments": comments[:num],
        "owner": owner.get("name", ""),
        "owner_mid": int(owner.get("mid", 0) or 0),
    }
    if fetch_error:
        out["error"] = fetch_error
    return json.dumps(out, ensure_ascii=False)


# ========== 圈地自萌：只回 UP 主主动邀请的楼中楼 ==========
# 规则（用户 2026-10-23 定）：
#   · 开启后绝不发新楼；
#   · 只认视频 UP 主本人发的一级评论；
#   · 多条鱼可以回同一个邀请，不做跨用户唯一性协调；
#   · 同一个账号对同一个 (BV, 邀请 rpid) 只回一次。

_CIRCLE_NEG = re.compile(r"别来|不要来|不用来|别刷|不要刷|别评论|不要评论|别回|不要回|不欢迎|禁止|滚")
_CIRCLE_POS = (
    re.compile(r"(?:大肥鱼|鱼塘(?:的鱼)?)[^。！？!?\n]{0,16}(?:快来|来评论|来玩|过来|来)(?!了|过|着|没|吗)"),
    re.compile(r"(?:^|[\s@])(?:快来|来)[^。！？!?\n]{0,12}(?:大肥鱼|鱼塘)"),
    re.compile(r"(?:^|[\s@])鱼(?:快来|来)(?:评论区|楼中楼|玩)?(?!了|过|着|没|吗)(?:[\s，,。.!！?？]|$)"),
)


def _circle_invite_match(text: str) -> tuple[bool, str]:
    """判断评论是否是对大肥鱼的邀请。否定语义优先级最高。"""
    value = re.sub(r"\s+", " ", str(text or "")).strip()
    if not value:
        return False, "empty"
    if _CIRCLE_NEG.search(value):
        return False, "negative"
    if any(p.search(value) for p in _CIRCLE_POS):
        return True, "invite"
    return False, "not-invite"


async def _circle_scan_raw(bvid: str, num: int = 100, order: str = "time") -> dict:
    """抓一级评论，并带上视频 UP 的 mid；圈地自萌只认这个 mid。"""
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = int(info.get("aid", 0) or 0)
    owner = info.get("owner") or {}
    owner_mid = int(owner.get("mid", 0) or 0)
    order_enum = comment.OrderType.TIME if str(order).lower() == "time" else comment.OrderType.LIKE
    limit = max(1, min(int(num or 100), 100))
    comments = []
    error = None
    page = 1
    while len(comments) < limit:
        try:
            resp = await comment.get_comments(
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                page_index=page,
                order=order_enum,
                credential=cred,
            )
            replies = resp.get("replies") or []
            if not replies:
                break
            for r in replies:
                member = r.get("member") or {}
                content = r.get("content") or {}
                comments.append({
                    "rpid": int(r.get("rpid", 0) or 0),
                    "mid": int(member.get("mid", 0) or 0),
                    "user": member.get("uname", ""),
                    "content": content.get("message", ""),
                    "time": int(r.get("ctime", 0) or 0),
                    "reply_count": int(r.get("rcount", 0) or 0),
                })
            page += 1
            await asyncio.sleep(0.5)
        except Exception as e:
            error = f"{type(e).__name__}: {e}"
            break
    return {
        "aid": aid,
        "owner": owner.get("name", ""),
        "owner_mid": owner_mid,
        "comments": comments[:limit],
        "error": error,
    }


def _circle_has_replied(bvid: str, rpid: int) -> bool:
    try:
        f = _DUTY_HOME / "circle-log.jsonl"
        if not f.exists():
            return False
        for line in f.read_text(encoding="utf-8").splitlines():
            try:
                e = json.loads(line)
                if e.get("ok") is True and str(e.get("bvid")) == str(bvid) and int(e.get("rpid") or 0) == int(rpid):
                    return True
            except Exception:
                continue
    except Exception:
        pass
    return False


def _circle_log_append(entry: dict) -> None:
    try:
        f = _DUTY_HOME / "circle-log.jsonl"
        f.parent.mkdir(parents=True, exist_ok=True)
        with open(f, "a", encoding="utf-8", newline="\n") as fh:
            fh.write(json.dumps({**entry, "ts": int(time.time() * 1000)}, ensure_ascii=False) + "\n")
    except Exception:
        pass


@tool()
async def bili_circle_scan(bvid: str, num: int = 60) -> str:
    """圈地自萌：只扫描视频 UP 主本人发出的一级邀请评论。

    不会发任何评论。返回的 invites 可直接交给 bili_circle_reply。
    普通用户说的「鱼来」不算；带否定语义的也不算。
    """
    data = await _circle_scan_raw(bvid, num=num, order="time")
    invites = []
    for c in data["comments"]:
        if c["mid"] != data["owner_mid"] or data["owner_mid"] <= 0:
            continue
        ok, why = _circle_invite_match(c["content"])
        if ok:
            invites.append({**c, "match": why, "already_replied": _circle_has_replied(bvid, c["rpid"])})
    return json.dumps({
        "bvid": bvid,
        "owner": data["owner"],
        "owner_mid": data["owner_mid"],
        "scanned": len(data["comments"]),
        "invites": invites,
        "error": data.get("error") or "",
    }, ensure_ascii=False)


@tool()
async def bili_circle_reply(bvid: str, rpid: int, text: str) -> str:
    """圈地自萌专用：只回复 UP 主邀请评论的楼中楼（硬闸）。

    rpid 必须是视频 UP 主本人发的一级评论，且正文是邀请；否则拒绝。
    永远不使用新楼。同一个账号对同一 (BV, rpid) 只允许成功回复一次。
    """
    target = int(rpid or 0)
    body = str(text or "").strip()
    if target <= 0:
        return json.dumps({"success": False, "error": "圈地自萌拒绝新楼：rpid 必须指向 UP 邀请评论"}, ensure_ascii=False)
    if not body:
        return json.dumps({"success": False, "error": "回复正文不能为空"}, ensure_ascii=False)
    if _circle_has_replied(bvid, target):
        return json.dumps({"success": False, "error": "这个邀请已经回复过，跳过"}, ensure_ascii=False)

    found = None
    data = await _circle_scan_raw(bvid, num=100, order="time")
    for c in data["comments"]:
        if int(c.get("rpid") or 0) == target:
            found = c
            break
    if found is None:
        # 置顶邀请可能比较早，再按热度扫一遍。
        data2 = await _circle_scan_raw(bvid, num=100, order="like")
        for c in data2["comments"]:
            if int(c.get("rpid") or 0) == target:
                found = c
                if not data.get("owner_mid"):
                    data = data2
                break
    if found is None:
        # 两种原因要分开：删了（重试无用）vs 掉出前 100 条窗口（评论可能还在）。
        try:
            state = await _comment_state(target, int(data.get("aid") or 0), get_cred())
        except Exception:
            state = "unknown"
        if state == "gone":
            return json.dumps({"success": False, "reason": "gone",
                               "error": "目标评论已不存在（可能已被删除），未发送"}, ensure_ascii=False)
        out_err = ("目标评论在，但不在前 100 条一级评论窗口里，未发送" if state == "exists"
                   else "目标评论不在前 100 条一级评论窗口里，存活状态未能确认，未发送")
        return json.dumps({"success": False, "reason": "out-of-window", "error": out_err}, ensure_ascii=False)
    if int(found.get("mid") or 0) != int(data.get("owner_mid") or 0) or int(data.get("owner_mid") or 0) <= 0:
        return json.dumps({"success": False, "error": "目标评论不是视频 UP 主本人发的，拒绝"}, ensure_ascii=False)
    ok, why = _circle_invite_match(found.get("content", ""))
    if not ok:
        return json.dumps({"success": False, "error": "目标评论不是邀请（" + why + "），拒绝"}, ensure_ascii=False)
    ctime = int(found.get("time") or 0)
    if ctime and time.time() - ctime > 7 * 86400:
        return json.dumps({"success": False, "error": "邀请超过 7 天，按安全闸拒绝"}, ensure_ascii=False)

    cred = get_cred()
    try:
        result = await comment.send_comment(
            text=body,
            oid=int(data["aid"]),
            type_=comment.CommentResourceType.VIDEO,
            root=target,
            parent=target,
            credential=cred,
        )
        out = {"success": True, "message": "已回到 UP 邀请的楼中楼", "bvid": bvid, "rpid": target}
        if isinstance(result, dict):
            for key in ("rpid", "rpid_str", "root", "parent"):
                val = result.get(key)
                if isinstance(val, (int, str)) and str(val).strip() and str(val) != "0":
                    out[key] = val
        _circle_log_append({"ok": True, "bvid": bvid, "rpid": target, "new_rpid": out.get("rpid"), "text": body,
                            "invite": found.get("content", ""), "owner_mid": data.get("owner_mid")})
        _guard_log({"type": "circle-reply", "ok": True, "bvid": bvid, "rpid": target,
                    "new_rpid": out.get("rpid"), "text": body})
        return json.dumps(out, ensure_ascii=False)
    except Exception as e:
        _circle_log_append({"ok": False, "bvid": bvid, "rpid": target, "text": body,
                            "invite": found.get("content", ""), "error": str(e)})
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 3: 获取字幕 ==========

@tool()
async def bili_subtitle(bvid: str) -> str:
    """
    获取B站视频的AI字幕（语音转文字）

    Args:
        bvid: 视频BV号，如"BV1uNk1YxEJQ"
    
    Returns:
        视频的完整字幕文本
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    info = await v.get_info()
    cid = info.get("cid", 0)
    if not cid and info.get("pages"):
        cid = info["pages"][0].get("cid", 0)

    if not cid:
        return json.dumps({"error": "无法获取cid"}, ensure_ascii=False)

    subtitle_list = await v.get_subtitle(cid=cid)
    subtitles = subtitle_list.get("subtitles", [])

    if not subtitles:
        return json.dumps({"message": "该视频没有字幕"}, ensure_ascii=False)

    # 优先AI中文字幕
    target = None
    for s in subtitles:
        if s.get("lan") in ["ai-zh", "zh-CN", "zh"]:
            target = s
            break
    if not target:
        target = subtitles[0]

    # 下载字幕
    import aiohttp
    sub_url = target.get("subtitle_url", "")
    if sub_url.startswith("//"):
        sub_url = "https:" + sub_url

    async with aiohttp.ClientSession() as session:
        async with session.get(sub_url) as resp:
            sub_data = await resp.json()

    texts = [item.get("content", "") for item in sub_data.get("body", [])]
    full_text = "\n".join(texts)

    return json.dumps({
        "bvid": bvid,
        "title": info.get("title", ""),
        "language": target.get("lan_doc", ""),
        "segments": len(texts),
        "text": full_text,
    }, ensure_ascii=False)


# ========== Tool 4: 获取弹幕 ==========

@tool()
async def bili_danmaku(bvid: str, num: int = 100) -> str:
    """
    获取B站视频的弹幕

    Args:
        bvid: 视频BV号
        num: 获取弹幕数量，默认100
    
    Returns:
        弹幕列表，包含弹幕文本和出现时间
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)

    danmakus = await v.get_danmakus(page_index=0)
    result = []
    for d in danmakus[:num]:
        result.append({
            "text": d.text,
            "time": d.dm_time,
        })

    return json.dumps({"bvid": bvid, "count": len(result), "danmakus": result}, ensure_ascii=False)


# ========== Tool 5: 视频详情 ==========

@tool()
async def bili_video_info(bvid: str) -> str:
    """
    获取B站视频的详细信息

    Args:
        bvid: 视频BV号
    
    Returns:
        视频标题、描述、UP主、播放量、评论数、收藏数等详细数据
    """
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    stat = info.get("stat", {})

    return json.dumps({
        "bvid": info.get("bvid"),
        "aid": info.get("aid"),
        "title": info.get("title"),
        "description": info.get("desc"),
        "author": info.get("owner", {}).get("name"),
        "duration": info.get("duration"),
        "pages": len(info.get("pages", [])),
        "tags": [t.get("tag_name") for t in info.get("tag", []) if t.get("tag_name")],
        "stat": {
            "view": stat.get("view", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "favorite": stat.get("favorite", 0),
            "coin": stat.get("coin", 0),
            "like": stat.get("like", 0),
            "share": stat.get("share", 0),
        },
    }, ensure_ascii=False)


# ========== 点赞 / 收藏（Video 只有 like，收藏 SDK 没给，得自己打接口） ==========

@tool()
async def bili_like(bvid: str, like: bool = True) -> str:
    """给视频点赞 / 取消点赞（用登录的那个号）。

    Args:
        bvid: 视频BV号
        like: True 点赞，False 取消点赞（真去接口取消，不只是改本地状态）

    Returns:
        {"ok", "bvid", "like", "has_liked"}；has_liked 是发完再查一次的真实状态
    """
    bv = _norm_bvid(bvid)
    if not bv:
        return json.dumps({"ok": False, "error": f"不是 BV 号：{bvid}"}, ensure_ascii=False)
    cred = load_credential()
    if not cred or not cred.sessdata or not cred.bili_jct:
        return json.dumps({"ok": False, "error": "还没登录 B站（去设置页扫码登录）"}, ensure_ascii=False)
    try:
        v = video.Video(bvid=bv, credential=cred)
        await v.like(status=bool(like))
        has = await v.has_liked()
        return json.dumps({"ok": True, "bvid": bv, "like": bool(like), "has_liked": bool(has)}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": _brief_error(e)}, ensure_ascii=False)


@tool()
async def bili_fav(bvid: str, fav: bool = True, media_id: int | None = None) -> str:
    """收藏 / 取消收藏视频；不给 media_id 就进默认收藏夹。

    Args:
        bvid: 视频BV号
        fav: True 收藏，False 取消收藏（真发 del_medias）
        media_id: 目标收藏夹 id，None 表示默认收藏夹

    Returns:
        {"ok", "bvid", "fav", "media_id", "folder"}
    """
    bv = _norm_bvid(bvid)
    if not bv:
        return json.dumps({"ok": False, "error": f"不是 BV 号：{bvid}"}, ensure_ascii=False)
    cred = load_credential()
    if not cred or not cred.sessdata or not cred.bili_jct:
        return json.dumps({"ok": False, "error": "还没登录 B站（去设置页扫码登录）"}, ensure_ascii=False)
    try:
        v = video.Video(bvid=bv, credential=cred)
        aid = int(v.get_aid() or 0)  # bvid 构造时就地算出 aid，不用再请求一次视频信息
        if aid <= 0:
            return json.dumps({"ok": False, "error": "拿不到该视频的 aid"}, ensure_ascii=False)

        nav = await _bili_api("GET", "https://api.bilibili.com/x/web-interface/nav", cred)
        if nav.get("code") != 0:
            return json.dumps({"ok": False, "error": _risk_text(nav.get("code"), nav.get("message"))}, ensure_ascii=False)
        mid = int((nav.get("data") or {}).get("mid") or 0)
        folders = await _bili_api("GET", "https://api.bilibili.com/x/v3/fav/folder/created/list-all",
                                  cred, params={"up_mid": mid})
        items = ((folders.get("data") or {}).get("list") or []) if folders.get("code") == 0 else []
        # 顺手把收藏夹名字带回去：界面要显示「进了哪个夹」，只给 id 人看不懂。
        target = int(media_id or 0)
        folder = ""
        pick = next((it for it in items if int(it.get("id") or 0) == target), None) if target else (items[0] if items else None)
        if pick:
            target = int(pick.get("id") or 0)
            folder = str(pick.get("title") or "")
        if target <= 0:
            return json.dumps({"ok": False,
                               "error": _risk_text(folders.get("code"), folders.get("message") or "没找到默认收藏夹")},
                              ensure_ascii=False)

        field = "add_medias" if fav else "del_medias"
        resp = await _bili_api("POST", "https://api.bilibili.com/x/v3/fav/resource/deal", cred,
                               data={"rid": aid, "type": 2, field: target, "csrf": cred.bili_jct})
        if resp.get("code") != 0:
            return json.dumps({"ok": False, "error": _risk_text(resp.get("code"), resp.get("message"))},
                              ensure_ascii=False)
        return json.dumps({"ok": True, "bvid": bv, "fav": bool(fav), "media_id": target,
                           "folder": folder or f"收藏夹 {target}"}, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": _brief_error(e)}, ensure_ascii=False)


# ========== Tool 6: 回复评论 ==========

def _guard_log(entry: dict) -> None:
    """守护记录：往 BILI_GUARD_LOG（宿主注入的路径）追加一行 JSON。

    为什么在这一层记：回复到底有没有真发出去，只有真正调 B站 接口的这里知道；
    模型的自我汇报靠不住（它会说「回了」，也可能实际被风控挡了）。
    写不进去就算了 —— 记录是给人看的，绝不能因为它影响回复本身。

    🔴 2026-10-22 实测事故：这个函数当初插在 `@tool()` 与 `async def bili_reply` **之间**，
       把 bili_reply 的装饰器「抢」走了 —— bili_reply 从此不再注册，值班那一轮模型手里
       根本没有这只工具（它说「我没有 bili_reply」是真的，不是幻觉），守护因此永远回不出去。
       教训：装饰器必须紧贴被装饰的函数，插新函数请插在**整段之后**。
    """
    path = os.environ.get("BILI_GUARD_LOG") or ""
    if not path:
        return
    try:
        rec = {"ts": int(time.time() * 1000)}
        rec.update(entry)
        with open(path, "a", encoding="utf-8") as f:
            f.write(json.dumps(rec, ensure_ascii=False) + "\n")
    except Exception:
        pass


@tool()
async def bili_reply(bvid: str, text: str, rpid: int = 0, root: int = 0) -> str:
    """
    在B站视频下发表评论或回复某条评论

    Args:
        bvid: 视频BV号
        text: 评论/回复的文本内容
        rpid: 要回复的目标评论ID（0表示发表新评论）
        root: 楼层根评论ID（回复一级评论时不用填，回复楼中楼时填根评论ID）
    
    Returns:
        发表结果
    """
    if rpid == 0 and os.environ.get("BILI_CIRCLE_MODE") == "1":
        return json.dumps({"success": False, "error": "圈地自萌开启：禁止发表任何新楼评论"}, ensure_ascii=False)
    cred = get_cred()
    v = video.Video(bvid=bvid, credential=cred)
    info = await v.get_info()
    aid = info["aid"]

    if rpid > 0:
        # 目标评论已被删还硬发，只会换回一个看不懂的风控报错；先单查一次再决定发不发。
        state = await _comment_state(int(rpid), int(aid), cred)
        if state == "gone":
            return json.dumps({"success": False, "error": "目标评论已不存在（可能已被删除），未发送"}, ensure_ascii=False)

    try:
        if rpid == 0:
            # 发表新评论
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                credential=cred,
            )
        else:
            # 回复评论
            # root=0 表示回复一级评论，root=rpid
            # root!=0 表示回复楼中楼，root=根评论，parent=目标评论
            actual_root = root if root != 0 else rpid
            result = await comment.send_comment(
                text=text,
                oid=aid,
                type_=comment.CommentResourceType.VIDEO,
                root=actual_root,
                parent=rpid,
                credential=cred,
            )

        # ⭐ 把回执里的 rpid 带回去：判重表要靠它记「我们发过哪条」，宿主的评论复核
        #    （lib/verify.mjs）也要拿它去 B站 查公开可见性。只回 success 的话那条链是断的。
        #（2026-10-16 审查修：原实现把上面的 result 丢掉了）
        out = {"success": True, "message": "评论发送成功"}
        if isinstance(result, dict):
            for key in ("rpid", "rpid_str", "root", "parent"):
                val = result.get(key)
                if isinstance(val, (int, str)) and str(val).strip() and str(val) != "0":
                    out[key] = val
        _guard_log({"type": "reply", "ok": True, "bvid": bvid, "rpid": rpid,
                    "new_rpid": out.get("rpid"), "text": text})
        return json.dumps(out, ensure_ascii=False)
    except Exception as e:
        _guard_log({"type": "reply", "ok": False, "bvid": bvid, "rpid": rpid,
                    "text": text, "error": str(e)})
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 7: 批量采集 ==========

@tool()
async def bili_crawl(keyword: str, max_videos: int = 5, comments_per_video: int = 20, get_subtitles: bool = True) -> str:
    """
    批量采集：搜索B站视频并抓取每个视频的评论和字幕

    Args:
        keyword: 搜索关键词
        max_videos: 最多采集视频数，默认5
        comments_per_video: 每个视频采集评论数，默认20
        get_subtitles: 是否获取字幕，默认True
    
    Returns:
        包含视频信息、评论和字幕的完整采集数据
    """
    cred = get_cred()

    # 搜索
    search_result = await search.search_by_type(
        keyword=keyword,
        search_type=search.SearchObjectType.VIDEO,
        page=1,
        order_type=search.OrderVideo.TOTALRANK,
    )

    results = []
    for item in search_result.get("result", [])[:max_videos]:
        bvid = item.get("bvid", "")
        if not bvid:
            continue

        title = item.get("title", "").replace('<em class="keyword">', "").replace("</em>", "")
        video_data = {
            "bvid": bvid,
            "title": title,
            "author": item.get("author", ""),
            "play": item.get("play", 0),
            "review": item.get("review", 0),
        }

        # 评论
        comments_json = await bili_comments(bvid=bvid, num=comments_per_video)
        comments_data = json.loads(comments_json)

        # 字幕
        subtitle_text = ""
        if get_subtitles:
            try:
                subtitle_json = await bili_subtitle(bvid=bvid)
                subtitle_data = json.loads(subtitle_json)
                subtitle_text = subtitle_data.get("text", "")
            except:
                pass

        results.append({
            "video": video_data,
            "comments": comments_data.get("comments", []),
            "subtitle_text": subtitle_text,
        })

        await asyncio.sleep(1)

    return json.dumps({
        "keyword": keyword,
        "video_count": len(results),
        "total_comments": sum(len(r["comments"]) for r in results),
        "results": results,
    }, ensure_ascii=False)


# ========== 辅助：封面处理 ==========

import subprocess


def _extract_cover_from_video(video_path: str) -> Picture:
    """从视频第3秒截取一帧作为封面，返回 Picture 对象"""
    tmp_cover = os.path.join(tempfile.gettempdir(), f"bili_cover_{os.getpid()}.png")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "3", "-i", video_path,
             "-vframes", "1", "-q:v", "2", tmp_cover],
            capture_output=True, timeout=30,
        )
        if os.path.isfile(tmp_cover) and os.path.getsize(tmp_cover) > 0:
            return Picture.from_file(tmp_cover)
    finally:
        if os.path.isfile(tmp_cover):
            os.remove(tmp_cover)
    # fallback: 第0秒
    tmp_cover2 = os.path.join(tempfile.gettempdir(), f"bili_cover2_{os.getpid()}.png")
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", "0", "-i", video_path,
             "-vframes", "1", "-q:v", "2", tmp_cover2],
            capture_output=True, timeout=30,
        )
        if os.path.isfile(tmp_cover2) and os.path.getsize(tmp_cover2) > 0:
            return Picture.from_file(tmp_cover2)
    finally:
        if os.path.isfile(tmp_cover2):
            os.remove(tmp_cover2)
    raise RuntimeError(f"无法从视频截取封面: {video_path}")




@tool()
async def bili_send_dynamic(
    text: str,
    images: list[str] | None = None,
    topic_id: int = 0,
    schedule_time: int = 0,
) -> str:
    """
    发布B站图文动态

    Args:
        text: 动态文本内容，支持@和表情（如 [doge]）
        images: 图片列表，每项可以是本地文件路径或图片URL，最多9张。为空则发布纯文字动态
        topic_id: 话题ID（可选，0表示不关联话题）
        schedule_time: 定时发布的Unix时间戳（可选，0表示立即发布）

    Returns:
        发布结果，包含动态ID
    """
    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    cred = get_cred()

    dyn = dynamic.BuildDynamic.empty()
    dyn.add_plain_text(text.strip())
    # 上传图片
    if images:
        for img_path in images[:9]:
            try:
                if not img_path or not img_path.strip():
                    continue
                img_path = img_path.strip()
                if img_path.startswith(("http://", "https://")):
                    pic = await Picture.async_from_url(img_path)
                else:
                    if not os.path.isfile(img_path):
                        return json.dumps({"success": False, "error": f"图片文件不存在: {img_path}"}, ensure_ascii=False)
                    pic = Picture.from_file(img_path)
                dyn.add_image(pic)
            except Exception as e:
                return json.dumps({"success": False, "error": f"图片处理失败: {img_path} - {str(e)}"}, ensure_ascii=False)

    if topic_id:
        dyn.set_topic(topic_id)

    if schedule_time > 0:
        dyn.set_send_time(schedule_time)

    try:
        result = await dynamic.send_dynamic(info=dyn, credential=cred)
        return json.dumps({
            "success": True,
            "message": "动态发布成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 9: 上传视频 ==========

@tool()
async def bili_upload_video(
    video_path: str,
    title: str,
    desc: str = "",
    tid: int = 124,
    tags: str = "AI",
    cover_path: str = "",
    source: str = "",
    dynamic_text: str = "",
    no_reprint: bool = True,
) -> str:
    """
    上传视频到B站

    Args:
        video_path: 视频文件的本地路径
        title: 视频标题（最多80字）
        desc: 视频简介描述
        tid: 分区ID，默认124（趣味科普人文-社科·法律·心理）。
             常用分区：17=单机游戏 21=日常 95=数码 122=野生技术协会
             124=社科 160=生活记录 171=电子竞技 183=影视杂谈
             188=科技资讯 201=科学 207=财经商业 208=科技 209=手工
             230=其他(生活) 231=美食 234=健身 32=完结动画
        tags: 标签，逗号分隔，如"AI,教程,编程"（至少1个标签）
        cover_path: 封面图片路径（可选，不填则B站自动截取）
        source: 转载来源URL（非原创时必填）
        dynamic_text: 粉丝动态文本（可选，投稿时同步发布的动态内容）
        no_reprint: 是否启用未经作者授权禁止转载，默认True

    Returns:
        上传结果，包含BV号
    """
    # ---- 参数校验 ----
    if not video_path or not video_path.strip():
        return json.dumps({"success": False, "error": "video_path 不能为空，请提供视频文件的本地路径"}, ensure_ascii=False)

    video_path = video_path.strip()
    if not os.path.isfile(video_path):
        return json.dumps({"success": False, "error": f"视频文件不存在: {video_path}"}, ensure_ascii=False)

    if not title or not title.strip():
        return json.dumps({"success": False, "error": "title 不能为空"}, ensure_ascii=False)

    cred = get_cred()

    try:
        # 准备分P
        page = VideoUploaderPage(
            path=video_path,
            title=title.strip()[:80],
            description=(desc or "")[:250],
        )

        # 标签处理
        tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()]
        if not tag_list:
            tag_list = ["视频"]

        # 判断原创/转载
        is_original = not bool(source and source.strip())

        # 封面：用户提供 > 自动从视频截取
        if cover_path and cover_path.strip() and os.path.isfile(cover_path.strip()):
            cover_pic = Picture.from_file(cover_path.strip())
        else:
            cover_pic = _extract_cover_from_video(video_path)

        meta = VideoMeta(
            tid=tid,
            title=title.strip()[:80],
            desc=desc or "",
            cover=cover_pic,
            tags=tag_list,
            original=is_original,
            source=source.strip() if source and source.strip() else None,
            no_reprint=no_reprint if is_original else False,
            dynamic=dynamic_text.strip() if dynamic_text and dynamic_text.strip() else None,
        )

        uploader = VideoUploader(
            pages=[page],
            meta=meta,
            credential=cred,
        )

        # 上传事件回调（记录进度）
        progress_info = {"phase": "初始化"}

        @uploader.on("__ALL__")
        async def on_event(data: dict):
            progress_info["phase"] = str(data)

        result = await uploader.start()
        return json.dumps({
            "success": True,
            "message": "视频上传成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({
            "success": False,
            "error": str(e),
            "last_phase": progress_info.get("phase", "unknown") if "progress_info" in dir() else "init",
        }, ensure_ascii=False)


# ========== Tool 10: 上传多P视频 ==========

@tool()
async def bili_upload_video_multi(
    video_paths: list[str],
    page_titles: list[str],
    title: str,
    desc: str = "",
    tid: int = 124,
    tags: str = "AI",
    cover_path: str = "",
    source: str = "",
) -> str:
    """
    上传多P视频到B站（多个分P合并为一个投稿）

    Args:
        video_paths: 视频文件路径列表，如["/path/p1.mp4", "/path/p2.mp4"]
        page_titles: 各分P标题列表，与video_paths一一对应
        title: 视频总标题
        desc: 视频简介
        tid: 分区ID，默认124
        tags: 标签，逗号分隔
        cover_path: 封面图片路径（可选）
        source: 转载来源URL（非原创时必填）

    Returns:
        上传结果
    """
    cred = get_cred()

    if not video_paths:
        return json.dumps({"success": False, "error": "video_paths 不能为空"}, ensure_ascii=False)
    if not page_titles:
        return json.dumps({"success": False, "error": "page_titles 不能为空"}, ensure_ascii=False)
    if len(video_paths) != len(page_titles):
        return json.dumps({"success": False, "error": "video_paths 和 page_titles 数量必须一致"}, ensure_ascii=False)

    try:
        pages = []
        for i, vp in enumerate(video_paths):
            vp = (vp or "").strip()
            if not vp or not os.path.isfile(vp):
                return json.dumps({"success": False, "error": f"文件不存在: {vp}"}, ensure_ascii=False)
            pages.append(VideoUploaderPage(
                path=vp,
                title=(page_titles[i] or "").strip()[:80] or f"P{i+1}",
                description="",
            ))

        tag_list = [t.strip() for t in (tags or "").split(",") if t.strip()] or ["视频"]
        is_original = not bool(source and source.strip())

        # 封面：用户提供 > 从第一个视频自动截取
        if cover_path and cover_path.strip() and os.path.isfile(cover_path.strip()):
            cover_pic = Picture.from_file(cover_path.strip())
        else:
            cover_pic = _extract_cover_from_video(pages[0].path)

        meta = VideoMeta(
            tid=tid,
            title=(title or "").strip()[:80],
            desc=desc or "",
            cover=cover_pic,
            tags=tag_list,
            original=is_original,
            source=source.strip() if source and source.strip() else None,
        )

        uploader = VideoUploader(pages=pages, meta=meta, credential=cred)

        result = await uploader.start()
        return json.dumps({
            "success": True,
            "message": f"多P视频上传成功（共{len(pages)}P）",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 11: 发布专栏文章 (Opus) ==========

@tool()
async def bili_send_opus(
    title: str,
    content: str,
    images: list[str] | None = None,
    category_id: int = 0,
) -> str:
    """
    发布B站图文（Opus，新版专栏）

    Args:
        title: 文章标题
        content: 文章正文内容（纯文本，段落用换行分隔）
        images: 文章中插入的图片路径或URL列表（可选）
        category_id: 分类ID（可选，0表示不指定）

    Returns:
        发布结果
    """
    cred = get_cred()

    dyn = dynamic.BuildDynamic.empty()

    # 专栏动态以纯文本+图片方式构建
    # 标题作为第一行加粗
    full_text = f"【{title}】\n\n{content}"
    dyn.add_plain_text(full_text)

    if images:
        for img_path in images:
            try:
                if not img_path or not img_path.strip():
                    continue
                img_path = img_path.strip()
                if img_path.startswith(("http://", "https://")):
                    pic = await Picture.async_from_url(img_path)
                else:
                    pic = Picture.from_file(img_path)
                dyn.add_image(pic)
            except Exception as e:
                pass  # 图片失败不阻断发布

    try:
        result = await dynamic.send_dynamic(info=dyn, credential=cred)
        return json.dumps({
            "success": True,
            "message": "图文发布成功",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 12: 查询分区列表 ==========

@tool()
async def bili_video_zones() -> str:
    """
    获取B站视频常用分区ID列表，供上传视频时选择tid参数

    Returns:
        常用分区ID及名称
    """
    zones = {
        "科技": {
            188: "科技资讯", 122: "野生技术协会", 95: "数码",
            208: "科技", 209: "手工",
        },
        "知识": {
            201: "科学", 124: "社科·法律·心理", 207: "财经商业",
            228: "人文历史", 36: "科技(知识)",
        },
        "生活": {
            21: "日常", 160: "生活记录", 230: "其他",
            231: "美食", 234: "健身", 161: "搞笑",
        },
        "游戏": {
            17: "单机游戏", 171: "电子竞技", 172: "手机游戏",
            65: "网络游戏",
        },
        "影视": {
            183: "影视杂谈", 138: "搞笑", 182: "影视剪辑",
        },
        "动画": {
            32: "完结动画", 33: "连载动画", 51: "MAD·AMV",
        },
        "音乐": {
            28: "原创音乐", 31: "翻唱", 59: "演奏",
        },
    }
    return json.dumps(zones, ensure_ascii=False)


# ========================================================================
#                        V1.2 — 数据分析 & 互动运营
# ========================================================================


# ========== Tool 13: 热门视频 ==========

@tool()
async def bili_hot_videos(pn: int = 1, ps: int = 20) -> str:
    """
    获取B站当前热门视频列表

    Args:
        pn: 页码，默认1
        ps: 每页数量，默认20，最大50

    Returns:
        热门视频列表，包含标题、播放量、UP主等
    """
    result = await hot.get_hot_videos(pn=pn, ps=min(ps, 50))
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "danmaku": stat.get("danmaku", 0),
            "reply": stat.get("reply", 0),
            "desc": (item.get("desc", "") or "")[:100],
            "duration": item.get("duration", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"page": pn, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 14: 热搜关键词 ==========

@tool()
async def bili_hot_buzzwords(page_num: int = 1, page_size: int = 20) -> str:
    """
    获取B站热搜词/热门关键词

    Args:
        page_num: 页码，默认1
        page_size: 每页数量，默认20

    Returns:
        热搜词列表
    """
    result = await hot.get_hot_buzzwords(page_num=page_num, page_size=page_size)
    return json.dumps(result, ensure_ascii=False)


# ========== Tool 15: 每周必看 ==========

@tool()
async def bili_weekly_hot(week: int = 0) -> str:
    """
    获取B站每周必看视频推荐

    Args:
        week: 期数（0表示获取期数列表，>0表示获取该期的视频）

    Returns:
        每周必看期数列表或指定期的视频列表
    """
    if week <= 0:
        result = await hot.get_weekly_hot_videos_list()
        return json.dumps(result, ensure_ascii=False)
    else:
        result = await hot.get_weekly_hot_videos(week=week)
        return json.dumps(result, ensure_ascii=False)


# ========== Tool 16: 排行榜 ==========

@tool()
async def bili_rank(category: str = "all", day: int = 3) -> str:
    """
    获取B站各分区排行榜

    Args:
        category: 分区名，可选值：
            all=全站 original=原创 rookie=新人
            douga=动画 music=音乐 dance=舞蹈 game=游戏
            knowledge=知识 technology=科技 sports=运动 car=汽车
            life=生活 food=美食 animal=动物 fashion=时尚
            ent=娱乐 cinephile=影视
        day: 时间维度，3=三日 7=七日

    Returns:
        排行榜视频列表
    """
    type_map = {
        "all": rank.RankType.All, "original": rank.RankType.Original,
        "rookie": rank.RankType.Rookie, "douga": rank.RankType.Douga,
        "music": rank.RankType.Music, "dance": rank.RankType.Dance,
        "game": rank.RankType.Game, "knowledge": rank.RankType.Knowledge,
        "technology": rank.RankType.Technology, "sports": rank.RankType.Sports,
        "car": rank.RankType.Car, "life": rank.RankType.Life,
        "food": rank.RankType.Food, "animal": rank.RankType.Animal,
        "fashion": rank.RankType.Fashion, "ent": rank.RankType.Ent,
        "cinephile": rank.RankType.Cinephile,
    }
    day_map = {3: rank.RankDayType.THREE_DAY, 7: rank.RankDayType.WEEK}

    rank_type = type_map.get(category.lower(), rank.RankType.All)
    rank_day = day_map.get(day, rank.RankDayType.THREE_DAY)

    result = await rank.get_rank(type_=rank_type, day=rank_day)
    videos = []
    for item in result.get("list", []):
        stat = item.get("stat", {})
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "author": item.get("owner", {}).get("name", ""),
            "play": stat.get("view", 0),
            "like": stat.get("like", 0),
            "coin": stat.get("coin", 0),
            "score": item.get("score", 0),
            "tname": item.get("tname", ""),
        })
    return json.dumps({"category": category, "day": day, "count": len(videos), "videos": videos}, ensure_ascii=False)


# ========== Tool 17: 用户信息 ==========

@tool()
async def bili_user_info(uid: int) -> str:
    """
    获取B站用户的详细信息

    Args:
        uid: 用户UID

    Returns:
        用户昵称、粉丝数、关注数、签名、等级、视频数等
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)
    info = await u.get_user_info()

    # 尝试获取UP主数据
    up_stat = {}
    try:
        up_stat = await u.get_up_stat()
    except:
        pass

    relation = {}
    try:
        relation = await u.get_relation_info()
    except:
        pass

    return json.dumps({
        "uid": uid,
        "name": info.get("name", ""),
        "sign": info.get("sign", ""),
        "level": info.get("level", 0),
        "face": info.get("face", ""),
        "fans": relation.get("follower", info.get("follower", 0)),
        "following": relation.get("following", info.get("following", 0)),
        "likes": up_stat.get("likes", 0),
        "archive_view": up_stat.get("archive", {}).get("view", 0),
        "article_view": up_stat.get("article", {}).get("view", 0),
        "is_senior_member": info.get("is_senior_member", 0),
        "top_photo": info.get("top_photo", ""),
    }, ensure_ascii=False)


# ========== Tool 18: 用户视频列表 ==========

@tool()
async def bili_user_videos(uid: int, pn: int = 1, ps: int = 30, order: str = "pubdate", keyword: str = "") -> str:
    """
    获取B站用户的投稿视频列表

    Args:
        uid: 用户UID
        pn: 页码，默认1
        ps: 每页数量，默认30
        order: 排序方式 pubdate=最新 click=播放量 stow=收藏
        keyword: 搜索关键词（在该用户视频中搜索）

    Returns:
        视频列表
    """
    cred = get_cred()
    u = user.User(uid=uid, credential=cred)

    order_map = {
        "pubdate": user.VideoOrder.PUBDATE,
        "click": user.VideoOrder.VIEW,
        "stow": user.VideoOrder.FAVORITE,
    }
    order_enum = order_map.get(order, user.VideoOrder.PUBDATE)

    result = await u.get_videos(pn=pn, ps=ps, order=order_enum, keyword=keyword)
    videos = []
    for item in result.get("list", {}).get("vlist", []):
        videos.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("play", 0),
            "comment": item.get("comment", 0),
            "created": item.get("created", 0),
            "length": item.get("length", ""),
            "description": (item.get("description", "") or "")[:100],
        })
    return json.dumps({
        "uid": uid,
        "page": pn,
        "total": result.get("page", {}).get("count", 0),
        "count": len(videos),
        "videos": videos,
    }, ensure_ascii=False)


# ========== Tool 19: 收藏夹列表 ==========

@tool()
async def bili_favorite_lists(uid: int = 0) -> str:
    """
    获取用户的收藏夹列表

    Args:
        uid: 用户UID（0表示获取自己的收藏夹）

    Returns:
        收藏夹列表，包含ID、名称、视频数量
    """
    cred = get_cred()
    if uid == 0:
        # 从凭证获取自己的UID
        import json as _json
        with open(CRED_FILE) as f:
            data = _json.load(f)
        uid = int(data.get("dedeuserid", 0))

    result = await favorite_list.get_video_favorite_list(uid=uid, credential=cred)
    fav_lists = []
    for item in (result.get("list", []) or []):
        fav_lists.append({
            "id": item.get("id", 0),
            "title": item.get("title", ""),
            "media_count": item.get("media_count", 0),
            "fav_state": item.get("fav_state", 0),
        })
    return json.dumps({"uid": uid, "count": len(fav_lists), "lists": fav_lists}, ensure_ascii=False)


# ========== Tool 20: 收藏夹内容 ==========

@tool()
async def bili_favorite_content(media_id: int, page: int = 1, keyword: str = "") -> str:
    """
    获取收藏夹内的视频列表

    Args:
        media_id: 收藏夹ID（从 bili_favorite_lists 获取）
        page: 页码，默认1
        keyword: 搜索关键词（在收藏夹内搜索）

    Returns:
        收藏夹内的视频列表
    """
    cred = get_cred()
    result = await favorite_list.get_video_favorite_list_content(
        media_id=media_id,
        page=page,
        keyword=keyword if keyword else None,
        credential=cred,
    )
    medias = []
    for item in (result.get("medias", []) or []):
        medias.append({
            "bvid": item.get("bvid", ""),
            "title": item.get("title", ""),
            "play": item.get("cnt_info", {}).get("play", 0),
            "collect": item.get("cnt_info", {}).get("collect", 0),
            "author": item.get("upper", {}).get("name", ""),
            "duration": item.get("duration", 0),
            "fav_time": item.get("fav_time", 0),
        })
    return json.dumps({
        "media_id": media_id,
        "page": page,
        "has_more": result.get("has_more", False),
        "count": len(medias),
        "medias": medias,
    }, ensure_ascii=False)


# ========== Tool 21: 发私信 ==========

@tool()
async def bili_send_message(receiver_uid: int, text: str) -> str:
    """
    给B站用户发送私信

    Args:
        receiver_uid: 接收者的UID
        text: 私信文本内容

    Returns:
        发送结果
    """
    cred = get_cred()

    if not text or not text.strip():
        return json.dumps({"success": False, "error": "text 不能为空"}, ensure_ascii=False)

    try:
        result = await session.send_msg(
            credential=cred,
            receiver_id=receiver_uid,
            msg_type=session.EventType.TEXT,
            content=text.strip(),
        )
        return json.dumps({
            "success": True,
            "message": f"私信已发送给UID:{receiver_uid}",
            "data": result if isinstance(result, dict) else str(result),
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"success": False, "error": str(e)}, ensure_ascii=False)


# ========== Tool 22: 未读消息 ==========

@tool()
async def bili_unread_messages() -> str:
    """
    获取B站未读消息数（私信、@、回复、点赞等）

    Returns:
        各类未读消息数量
    """
    cred = get_cred()
    try:
        result = await session.get_unread_messages(credential=cred)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ========== Tool 22.6: 值班轮的「文件出口」（2026-10-22）==========
# 🔴 为什么要有这几只：值班轮现在跑在**使用者工作区**里（会话才会出现在他的会话列表），
#    而那一轮的沙箱是 workspace-write —— 只让写 cwd ⇒ 它写不了插件家目录里的
#    `out/` 报告、`seen.md` 判重表、归档 ✗（实测 `[sandbox: file access denied]`）。
#    这个 MCP 子进程是**宿主起的**，不受那一轮的沙箱限制 ⇒ 由它代写。
#    ⚠️ 刻意不做成通用文件工具：只有「报告 / 判重表 / 归档」三个固定出口，
#       路径由这里算，模型给不了任意路径 ✓
#    目录取 `BILI_DUTY_HOME`（宿主写进 overlay 的 env），没设就取本文件所在目录
#    —— 部署时 mcp_server.py 就铺在值班家目录里，两者等价。

_DUTY_HOME = Path(os.environ.get("BILI_DUTY_HOME") or Path(__file__).resolve().parent)


def _duty_write(rel_parts, text: str, append: bool = False) -> dict:
    try:
        f = _DUTY_HOME.joinpath(*rel_parts)
        f.parent.mkdir(parents=True, exist_ok=True)
        mode = "a" if append else "w"
        with open(f, mode, encoding="utf-8", newline="\n") as fh:
            fh.write(text)
        return {"ok": True, "file": str(f), "chars": len(text), "append": append}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@tool()
async def bili_report_save(markdown: str) -> str:
    """把这一轮的 Markdown 报告整份写到插件家目录的 out/<今天>.md（覆盖写）。

    值班轮跑在工作区里、沙箱只让写工作区，所以报告用这只工具交，别用写文件工具。
    """
    day = time.strftime("%Y-%m-%d", time.localtime())
    return json.dumps(_duty_write(["out", f"{day}.md"], str(markdown or "")), ensure_ascii=False)


@tool()
async def bili_seen_read(limit_chars: int = 20000) -> str:
    """读判重表 seen.md（返回尾部 limit_chars 个字符，够判重就行）。"""
    try:
        f = _DUTY_HOME / "seen.md"
        text = f.read_text(encoding="utf-8") if f.exists() else ""
        n = max(1000, min(int(limit_chars or 20000), 200000))
        return json.dumps({
            "ok": True, "file": str(f), "exists": f.exists(),
            "chars": len(text), "tail": text[-n:],
        }, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False)


@tool()
async def bili_seen_append(lines: str) -> str:
    """往判重表 seen.md 追加记录（一行一条，别重复追加同一行）。"""
    text = str(lines or "")
    if not text.endswith("\n"):
        text += "\n"
    return json.dumps(_duty_write(["seen.md"], text, append=True), ensure_ascii=False)


@tool()
async def bili_archive_append(lines: str) -> str:
    """往归档 out/<YYYY-MM>.md 追加记录（一行一条：日期 · BV · 标题 · UP · 结论 · 链接）。"""
    month = time.strftime("%Y-%m", time.localtime())
    text = str(lines or "")
    if not text.endswith("\n"):
        text += "\n"
    return json.dumps(_duty_write(["out", f"{month}.md"], text, append=True), ensure_ascii=False)


# ========== Tool 26-28: 记忆 / 日记 / 鱼说（2026-10-23，鱼塘大页面的三个 Tab）==========
#     为什么放在 MCP：跟报告/归档同一条管道（值班轮跑在工作区里、沙箱只让写工作区，
#     这些文件都住在家目录里 ⇒ 必须由这只工具代写 ✓）。宿主 /pond 读这三个文件渲染页面。

@tool()
async def bili_memory_append(what: str, why: str = "", bvid: str = "") -> str:
    """往记忆 memory.jsonl 追加一条（值得跨天记住的观察/知识，不是流水账）。

    what：一句话说清记住了什么；why：为什么值得记；bvid：跟哪条视频有关（可空）。
    判据：跟使用者有关、下次值班还用得上（他的项目/工具/口味/踩过的坑）。
    每轮最多记 2~3 条 —— 记忆是「攒给以后用的」，不是把报告抄一遍。
    """
    line = json.dumps({
        "t": str(what or "").strip(),
        "why": str(why or "").strip(),
        "bv": str(bvid or "").strip(),
        "d": time.strftime("%Y-%m-%d %H:%M", time.localtime()),
    }, ensure_ascii=False)
    return json.dumps(_duty_write(["memory.jsonl"], line + "\n", append=True), ensure_ascii=False)


@tool()
async def bili_diary_write(markdown: str) -> str:
    """把今天的日记整份写到 diary/<今天>.md（覆盖写，一天一篇）。

    内容：今天看了什么、挑了哪几条、为什么、有什么感想 —— 用你自己的语气写，
    一两百字就够，写给使用者看的，不是操作日志。一天只有一轮时，就写那一轮的事。
    """
    day = time.strftime("%Y-%m-%d", time.localtime())
    return json.dumps(_duty_write(["diary", f"{day}.md"], str(markdown or "")), ensure_ascii=False)


@tool()
async def bili_say(text: str) -> str:
    """留一句「鱼说的话」（一句话，≤50 字，覆盖上一句）。

    从这一轮里挑一句你真心想对使用者说的 —— 观点、吐槽、今天最大的发现都行，
    它会显示在鱼塘大页面的首页。别写成总结（那是报告的事），要像人说话。
    """
    t = str(text or "").strip()[:60]
    if not t:
        return json.dumps({"ok": False, "error": "空话不说"}, ensure_ascii=False)
    return json.dumps(_duty_write(["say.txt"], t), ensure_ascii=False)


# ========== Tool 22.5: 读私信（私信遥控通道，2026-10-22）==========

# ========== 设置：私信里能改的那几个（A 档） ==========
#    为什么放在 MCP 而不是宿主：私信那一轮里，**模型**才是听懂人话的那一环 ——
#    它把「每天最多回 10 条」映射成 guardDailyCap=10，这里只负责**校验 + 落盘**。
#    ⚠️ 白名单写死在这张表里：不在表里的 key 一律拒绝。
#       收件人（mentionUid/dmUid）、路径（workspace/dutyCwd/headlessProfile）、
#       凭证、白名单（guardWhitelist）**永远改不了** —— 那些改错了会发错人 / 直接坏。
#    ⚠️ 写的是 `$DSH_HOME/bili-duty/config.json`（= BILI_DUTY_HOME/config.json），
#       宿主每轮 refreshCfg() 会重新读 ⇒ **下一轮生效**，不需要重启。

_SETTING_SPEC = {
    # 布尔
    "guardOn": ("bool", None, None),
    "guardOwnAll": ("bool", None, None),
    "guardEmoji": ("bool", None, None),
    "autoRun": ("bool", None, None),
    "peakValleyOnly": ("bool", None, None),
    "noon": ("bool", None, None),
    "night": ("bool", None, None),
    "transcribe": ("bool", None, None),
    "preferSubtitle": ("bool", None, None),
    "autoComment": ("bool", None, None),
    "replyToComments": ("bool", None, None),
    "dmOn": ("bool", None, None),
    # 整数（带范围）
    "guardDailyCap": ("int", 0, 500),
    "guardPerRound": ("int", 1, 20),
    "guardScope": ("int", 1, 10),
    "guardPollMinutes": ("int", 1, 240),
    "autoRunsPerDay": ("int", 0, 48),
    "autoGapMinutes": ("int", 5, 1440),
    "perRoundMax": ("int", 0, 20),
    "perDayMax": ("int", 0, 100),
    "minDurationMin": ("int", 0, 240),
    "maxDurationMin": ("int", 0, 240),
    "transcribePerDay": ("int", 0, 100),
    # 文本
    "keywords": ("csv", None, None),      # 逗号/空格分隔
    "reportLevel": ("enum", None, None),  # full / brief
    "asrModel": ("enum", None, None),     # tiny/base/small/medium/large
}

_SETTING_ENUMS = {
    "reportLevel": ["full", "brief"],
    "asrModel": ["tiny", "base", "small", "medium", "large"],
}

# 这几项会「对外说话」或「开始定时花钱」⇒ 必须**再问一句**才写（防它把「关掉」听成「打开」）
_SETTING_CONFIRM = {
    "autoRun", "autoRunsPerDay", "autoGapMinutes", "peakValleyOnly", "noon", "night",
    "autoComment", "replyToComments", "dmOn",
}

_TRUE = {"1", "true", "yes", "on", "y", "t", "开", "打开", "是", "启用", "开启"}
_FALSE = {"0", "false", "no", "off", "n", "f", "关", "关闭", "否", "停用", "禁用"}


def _setting_file() -> Path:
    return _DUTY_HOME / "config.json"


def _setting_load() -> dict:
    try:
        with open(_setting_file(), "r", encoding="utf-8") as fh:
            d = json.load(fh)
        return d if isinstance(d, dict) else {}
    except FileNotFoundError:
        return {}
    except Exception:
        return {}


def _setting_save(cfg: dict) -> dict:
    f = _setting_file()
    try:
        f.parent.mkdir(parents=True, exist_ok=True)
        tmp = f.with_suffix(".json.tmp")
        with open(tmp, "w", encoding="utf-8", newline="\n") as fh:
            json.dump(cfg, fh, ensure_ascii=False, indent=2)
        os.replace(tmp, f)
        return {"ok": True, "file": str(f)}
    except Exception as e:
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}


@tool()
async def bili_setting_get() -> str:
    """看现在这几个设置是什么值（私信里改设置前先看一眼，别凭记忆）。"""
    cfg = _setting_load()
    out = {}
    for k in _SETTING_SPEC:
        out[k] = cfg.get(k)
    return json.dumps({"ok": True, "settings": out}, ensure_ascii=False)


@tool()
async def bili_setting_set(key: str, value: str, confirm: bool = False) -> str:
    """改一个设置。key 必须是白名单里的（见帮助）；value 传字符串。

    改「会自动跑 / 会对外说话」的那几项（autoRun、autoComment、replyToComments、dmOn…）时，
    第一次调用会返回 need_confirm=true —— 必须**先问使用者**，他同意了再带 confirm=true 调一次。
    """
    k = str(key or "").strip()
    if k not in _SETTING_SPEC:
        return json.dumps({
            "ok": False,
            "error": f"这个设置不能从私信里改：{k}",
            "allowed": sorted(_SETTING_SPEC.keys()),
        }, ensure_ascii=False)
    kind, lo, hi = _SETTING_SPEC[k]
    raw = str(value if value is not None else "").strip()
    try:
        if kind == "bool":
            low = raw.lower()
            if low in _TRUE:
                val = True
            elif low in _FALSE:
                val = False
            else:
                return json.dumps({"ok": False, "error": f"{k} 只接受开/关，收到「{raw}」"}, ensure_ascii=False)
        elif kind == "int":
            val = int(float(raw))
            if lo is not None and val < lo:
                return json.dumps({"ok": False, "error": f"{k} 不能小于 {lo}"}, ensure_ascii=False)
            if hi is not None and val > hi:
                return json.dumps({"ok": False, "error": f"{k} 不能大于 {hi}"}, ensure_ascii=False)
        elif kind == "csv":
            parts = [p for p in re.split(r"[,，\s]+", raw) if p]
            val = parts
        elif kind == "enum":
            allowed = _SETTING_ENUMS.get(k, [])
            low = raw.lower()
            if low not in allowed:
                return json.dumps({"ok": False, "error": f"{k} 只能是 {'/'.join(allowed)}"}, ensure_ascii=False)
            val = low
        else:
            val = raw
    except Exception:
        return json.dumps({"ok": False, "error": f"{k} 的值看不懂：「{raw}」"}, ensure_ascii=False)

    if k in _SETTING_CONFIRM and not confirm:
        return json.dumps({
            "ok": False, "need_confirm": True, "key": k, "to": val,
            "hint": f"这一项会影响「自动跑/对外说话」，先跟使用者确认一句，他同意后再带 confirm=true 调一次",
        }, ensure_ascii=False)

    cfg = _setting_load()
    old = cfg.get(k)
    cfg[k] = val
    r = _setting_save(cfg)
    if not r.get("ok"):
        return json.dumps(r, ensure_ascii=False)
    return json.dumps({"ok": True, "key": k, "from": old, "to": val, "note": "下一轮生效"}, ensure_ascii=False)


@tool()
async def bili_dm_inbox(uid: int = 0, limit: int = 20) -> str:
    """
    读「指定用户 ↔ 本号」的私信内容（最近三十条里取最新的 limit 条）

    用途：私信遥控 —— 主人在手机上给小号发一条「# 状态」，宿主这边扫到就执行并回一条。
    ⚠️ 只有**读**：发私信是 bili_send_message。方向用 dir 区分（in = 他发给我的）。

    Args:
        uid: 对方 UID（必填；读谁和本号的私信）
        limit: 最多返回几条（默认 20）

    Returns:
        {"ok": true, "talker_uid": 123, "count": n, "items": [{"key","ts","dir","text"}]}
    """
    if not uid:
        return json.dumps({"ok": False, "error": "uid 必填（要读谁和本号的私信）"}, ensure_ascii=False)
    cred = get_cred()
    try:
        resp = await session.fetch_session_msgs(talker_id=int(uid), credential=cred, session_type=1)
    except Exception as e:
        return json.dumps({"ok": False, "error": f"{type(e).__name__}: {e}"}, ensure_ascii=False)
    msgs = (resp or {}).get("messages") if isinstance(resp, dict) else None
    items = []
    for m in (msgs or []):
        try:
            raw = m.get("content") or "{}"
            # 私信的 content 是一层 JSON 字符串：{"content": "真正的话"}
            text = json.loads(raw).get("content", "") if isinstance(raw, str) else str(raw)
        except Exception:
            text = ""
        items.append({
            "key": int(m.get("msg_key") or 0),
            "ts": int(m.get("timestamp") or 0),
            "dir": "in" if int(m.get("sender_uid") or 0) == int(uid) else "out",
            "text": str(text or ""),
        })
    items.sort(key=lambda x: x["ts"])
    if limit and len(items) > int(limit):
        items = items[-int(limit):]
    return json.dumps({"ok": True, "talker_uid": int(uid), "count": len(items), "items": items}, ensure_ascii=False)


# ========== Tool 23: 最近收到的回复 ==========

@tool()
async def bili_received_replies() -> str:
    """
    获取最近收到的评论回复通知

    Returns:
        回复列表
    """
    cred = get_cred()
    try:
        result = await session.get_replies(credential=cred)
        return json.dumps(result, ensure_ascii=False)
    except Exception as e:
        return json.dumps({"error": str(e)}, ensure_ascii=False)


# ========== Tool 24: 最近收到的@和点赞 ==========

@tool()
async def bili_received_at_and_likes() -> str:
    """
    获取最近收到的@提及和点赞通知

    Returns:
        包含 at 和 likes 两部分的通知数据
    """
    cred = get_cred()
    result = {}
    try:
        result["at"] = await session.get_at(credential=cred)
    except Exception as e:
        result["at_error"] = str(e)
    try:
        result["likes"] = await session.get_likes(credential=cred)
    except Exception as e:
        result["likes_error"] = str(e)
    return json.dumps(result, ensure_ascii=False)


# ========== Tool 25: 值班扫描（@ 我的 + 新评论） ==========

# BV 号恒为 "BV" + 10 位大小写字母/数字。@ 消息里的 uri 形如
# https://www.bilibili.com/video/BV1NJn665Epm ，但**不能**直接 split("/")[-1]：
# 带参数（?page=2 / &t=30）或末尾带斜杠时会把尾巴一起切出来。抽不到就留空串。
_BV_PATTERN = re.compile(r"BV[0-9A-Za-z]{10}")


@tool()
async def bili_guard_scan(
    bvids: list[str] = None,
    since_at_id: int = 0,
    since_at_time: int = 0,
    since_ctimes: dict = None,
    max_pages: int = 3,
) -> str:
    """
    值班扫描：一次拿回「谁 @ 了我」+「我最近视频下的新评论」，供守护评论区的一轮使用。

    和 bili_received_at_and_likes 的区别：那个只回裸通知（没有 BV / aid / rpid 的可用对应关系，
    也没法增量），这个把每条 @ 归一成"能直接拿去 bili_reply"的形状，并按水位只给新的。

    Args:
        bvids: 要盯评论区的视频 BV 号列表。**只传自己/最近发的几个**，别把整个列表倒进来 ——
               每个 BV 至少要一次 get_info + 一页评论，越界会招风控。传 None/[] 时只扫 @ 通道。
        since_at_id: @ 通道的水位之一，上一轮返回的 at_cursor.id。0 = 从头/按 at_time 算。
        since_at_time: @ 通道的时间水位（unix 秒），上一轮返回的 at_cursor.time。0 = 不限。
        since_ctimes: {bvid: ctime} 的评论水位，只回 ctime 比它新的顶层评论。
                      没给过的视频当 0（= 这一轮把 max_pages 页全给你）。
        max_pages: 每个视频最多翻几页评论（每页 20 条，按时间倒序）。默认 3，即最多 60 条。

    Returns:
        JSON 字符串：
          {
            "at": [{"id","at_time","uid","uname","kind","title","bvid","aid","rpid","root_id","text"}],
            "comments": [{"bvid","rpid","uid","uname","text","ctime","root"}],
            "at_cursor": {"id": int, "time": int},   ← 下一轮原样传回 since_at_id / since_at_time
            "errors": ["at: ...", "BV1xx: ..."]      ← 抓失败的部分；**非空不等于整次失败**
          }

        at[].uid / comments[].uid 都是 int 的 mid（拿不到给 0）；at[].rpid 是被 @ 的那条评论 id，
        可以直接当 bili_reply 的 rpid；at[].aid 是视频 aid（bili_reply 只需要 bvid，aid 用于对账）。
        调用方仍应按 rpid 去重：at_cursor 是「服务端游标」，同一轮里可能同时出现新旧条目。
    """
    cred = get_cred()

    since_ctimes = since_ctimes or {}
    errors = []
    at_list = []
    comments = []

    # ⚠️ 水位先回填成入参：万一 get_at 抛错，返回的 at_cursor 必须还是**旧水位**。
    #    如果这里直接给 {"id":0,"time":0}，调用方存下来就等于把水位清零 ——
    #    下一轮会把历史上的 @ 全捞一遍，重复回复就是这么来的。
    at_cursor = {"id": int(since_at_id or 0), "time": int(since_at_time or 0)}

    # ---------- 通道 1：@ 我的 ----------
    try:
        at_resp = await session.get_at(
            credential=cred,
            last_id=since_at_id or None,
            at_time=since_at_time or None,
        )
    except Exception as e:
        # @ 通道挂了不该拖累评论通道：两个通道的失败要能分开看（errors 里分前缀）。
        errors.append(f"at: {type(e).__name__}: {e}")
        at_resp = None

    if at_resp:
        cursor = at_resp.get("cursor") or {}
        # 服务端没给游标时保留旧水位，理由同上。
        at_cursor = {
            "id": int(cursor.get("id") or 0) or at_cursor["id"],
            "time": int(cursor.get("time") or 0) or at_cursor["time"],
        }

        for it in (at_resp.get("items") or []):
            at_user = it.get("user") or {}
            at_item = it.get("item") or {}
            at_time = int(it.get("at_time") or 0)
            # SDK 已经按 last_id/at_time 做了服务端增量，这里再挡一道：
            # 用 >= 而不是 >，因为 at_time 只到秒，同一秒内的多条 @ 会被 > 误杀；
            # 多回来的那条靠 rpid 去重更稳（调用方做，见 docstring）。
            if at_time and at_time < since_at_time:
                continue
            uri = at_item.get("uri") or ""
            bv_match = _BV_PATTERN.search(uri)
            at_list.append({
                "id": int(it.get("id") or 0),
                "at_time": at_time,
                "uid": int(at_user.get("mid") or 0),
                "uname": at_user.get("nickname", ""),
                "kind": at_item.get("type", ""),
                # title 是视频标题（评论/动态类 @ 也可能为空），只用于让模型判断"要不要回"。
                "title": at_item.get("title", ""),
                "bvid": bv_match.group(0) if bv_match else "",
                # subject_id 就是视频 aid；source_id 是被 @ 的那条评论 rpid ——
                # 这两个不是同一个东西，回复时要用 rpid，对账时要用 aid。
                "aid": int(at_item.get("subject_id") or 0),
                "rpid": int(at_item.get("source_id") or 0),
                "root_id": int(at_item.get("root_id") or 0),
                "text": at_item.get("source_content", ""),
            })

    # ---------- 通道 2：指定视频的新评论 ----------
    page_limit = max(1, int(max_pages or 1))
    for bvid in (bvids or []):
        # 每个 bvid 单独 try：一个视频 -412 或 bvid 写错，不能把整次扫描打成空结果。
        try:
            v = video.Video(bvid=bvid, credential=cred)
            # ⚠️ 必须走 get_info() 拿 aid：Video.get_aid() 只是返回构造时缓存的私有字段，
            #    用 bvid 构造的 Video 上它是 None（不是协程、也不会去请求接口）。
            info = await v.get_info()
            aid = info["aid"]
            since_ctime = int(since_ctimes.get(bvid, 0) or 0)

            for page_index in range(1, page_limit + 1):
                resp = await comment.get_comments(
                    oid=aid,
                    type_=comment.CommentResourceType.VIDEO,
                    page_index=page_index,
                    # 这里**必须**按时间倒序：按热度排的话，刚发出、还没人点赞的新评论
                    # 排到很后面，翻 3 页根本看不见 —— 守护评论区就永远发现不了新评论。
                    order=comment.OrderType.TIME,
                    credential=cred,
                )
                replies = resp.get("replies") or []
                if not replies:
                    break

                matched = 0
                for r in replies:
                    ctime = int(r.get("ctime") or 0)
                    if ctime <= since_ctime:
                        continue
                    member = r.get("member") or {}
                    matched += 1
                    comments.append({
                        "bvid": bvid,
                        "rpid": r.get("rpid", 0),
                        "uid": int(member.get("mid") or 0),
                        "uname": member.get("uname", ""),
                        "text": (r.get("content") or {}).get("message", ""),
                        "ctime": ctime,
                        "root": r.get("root", 0),
                    })

                # 整页都没命中就说明已经翻到水位以下了，再翻只是白烧风控额度。
                # ⚠️ 判据是「整页 0 命中」而不是「第一条就旧」：置顶评论会被 B站 插在页首，
                #    它的 ctime 可能很老，按第一条判断会提前收摊、漏掉整页新评论。
                if matched == 0:
                    break
                if page_index < page_limit:
                    # 页间隔 0.4s 防风控：连续翻页是最容易触发 -412 的地方。
                    await asyncio.sleep(0.4)
        except Exception as e:
            errors.append(f"{bvid}: {type(e).__name__}: {e}")

    return json.dumps({
        "at": at_list,
        "comments": comments,
        "at_cursor": at_cursor,
        "errors": errors,
    }, ensure_ascii=False)


# ========== 启动 ==========

if __name__ == "__main__":
    mcp.run(transport="stdio")