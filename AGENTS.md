# 给 AI 助手看的（本仓库 = 一个 DSH 插件）

`dsh-bili-pond`（中文名「**B站鱼塘**」）：每天派鱼去 B站 捞几条值得看的 ——
搜、**读字幕原文**判断（没字幕可本地转写）、写一份日报，特别值得的会发一条评论 **@ 用户**。

> ⚠️ 本项目**基于** `dsh-bili-scroll` 0.1.10 衍生，但**不是 fork**：调度、模型选择、
> 报告渲染、内容筛选、投递逻辑与安全闸都已重写，配置字段 / 条目 id / API 路径全部改过，
> 与原项目**不兼容**，也**不跟随**其版本。详见 README 的「与原版的差异」。

## 帮用户安装时，按这个顺序

1. **前提**：机器上有 `Python 3.10+` **或** `uv`（有一个即可）。
   两个都没有**也不用让用户先装** —— 插件点「装依赖」时会**自己下一份 `uv` 到自己的数据目录**
   （`~/.dsh/bili-duty`，免管理员、不用 PATH）；只有它自己也下不动时（网络到不了 GitHub / 加速代理 / PyPI 镜像），
   才需要引导用户手动装。
   · 它是**直连 GitHub → 国内加速代理 → PyPI 镜像**依次试的，并且会**核对官方 sha256** ✓
   · ⚠️ 若用户机器上的**杀软拦了这次下载**：让他把 `%USERPROFILE%\.dsh\bili-duty\bin\` 加白，
     或干脆自己装 uv / Python 3.10+ ✓
   · ⭐ **万一下载链路都不通**：**手动放一份 `uv.exe` 到 `~/.dsh/bili-duty/bin/` 就行** ——
     插件会**用那一份、跳过下载** ✓
2. `dsh plugin --profile desktop add dsh-bili-pond`（npm，推荐）
   · 备选：`dsh plugin --profile desktop add github:YOYOLnFu/dsh-bili-pond`
3. ⚠️ **提醒用户重启一次 dsh**（必须，bundle 层要重启才组装）。
4. 让用户进 **设置 → B站鱼塘**：点「**安装运行环境**」→ 点「**扫码登录**」
   （手机扫码，选"记住我 / 长期"）。
   · 装完可以用「**测一下**」自检：它真跑一次登录检查 + 一次搜索，直接回答"能不能用"。
5. **别擅自打开「自动发布评论」** —— 那是拿用户的号说话；要用得让用户自己填「在评论里 @ 谁」。
6. **别擅自开「自动运行」** —— 先让用户手动跑一轮看看效果，再决定要不要定时。

## 🔴 安全闸（改代码时必须守住）

- **私信只能发给设置里那个 `dmUid`**：模型传别的 UID 一律拒绝（`bili_send_message` 的硬闸）。
  包括视频 UP 主、评论区里的人 —— 都不能发。
- **评论必须真读内容**：字幕原文或转写结果，不许拿标题简介硬编。
- **评论默认关**：`autoComment` + `mentionName` 两个都成立才发（工具层还有一道 `commentOn` 闸）。
- **转写熔断**：`transcribePerDay` 到上限后只挑有字幕的视频，不再转写。
- **点赞 / 收藏默认关，且必须带理由**：`likeOn` / `favOn` 默认 false；`bili_like` / `bili_fav`
  工具层硬闸要求 `reason` ≥ 6 字、bvid 合法、有凭证；额度硬顶（每轮 5、每天点赞 10 / 收藏 8），
  撞 `-352` / `-412` 写 `like-cooldown.json` 冷却 30 分钟；撤销只能撤自己赞过的，且撤销不返还额度。

## 已知环境差异

- ⭐⭐ **桌面版 DSH（Electron，不是 npm 全局安装）上"跑一轮 0.17 秒就结束、code=0、什么都没干"**：
  根因是 Electron 里 spawn 的 node 少了 `ELECTRON_RUN_AS_NODE=1`，且 `dsh` CLI 不在 PATH 上。
  现在会带那个环境变量、并去应用目录里找 dsh；**还找不到就在 `duty.log` 里明说**
  "请在设置里把 dsh 路径指过去"（不再静默失败）。
- ⭐⭐ **桌面版值班提示词被 `cmd.exe` 截断**：旧回退用 `shell:true` 启动 `dsh`，多行 prompt 只保留第一行，
  配额、圈地、私信等本轮指令都送不到模型。现在直接启动 `app.asar/dsh/.../dsh-desktop-host/lib/cli.js`
  并保持 `shell:false`；任何多行 prompt 再走 shell 都会拒绝启动。
- **桌面版上"自动跑会卡"**：跑那一轮是 `dsh --profile headless --patch <overlay> <prompt>` ——
  先确认 dsh 版本与 profile，别硬跑；跑不起来就先只用手动「立即运行一轮」。
- **别让用户自己去装环境** ✗：插件自带 uv 与依赖安装能力，先照上面第 1 条处理。

## 仓库结构（改代码时看这里）

- `index.js` —— host 半端：
  - 14 个工具（搜/字幕/评论/发评论/点赞/收藏/发私信/状态/跑一轮/登录/装环境/配置…）
  - **自动排班** `tick()`：五级闸门（总开关 → 每天挑选配额 → 每天轮数配额 → 两轮间隔 → 谷时窗口）
    + 中午保底（夜间最后一轮留给中午）
  - HTTP 接口（`/api/bili-pond/*`）：状态 / 配置 / 模型目录 / UID 解析昵称 / 跑一轮 / 安装 / 登录 / 报告
  - 配置：`config.json` 与 DSH 原生设置页**逐字段对账**（`loadCfg` / `saveCfgHost` / `persistCfg`）
    - ⚠️ **本地优先**：插件面板保存的键以 `config.json` 为准（`local-override.json` 记账）
    - ⚠️ 老配置迁移 `migrateCfg(c, savedRaw)`：`perDay` → `perDayMax`、`peakValley` → `autoRun`
      （判据必须看**磁盘原始 JSON 有没有那个键**，不能看 normalize 后的值）
  - 值班轮的工具白名单 `mcpWhitelist()` → 写进 overlay 的 `BILI_MCP_TOOLS`
- `client.js` —— 浏览器半端：设置页（注册在 `settings.section`）
  - 极简 markdown 渲染器 `renderMarkdown()`（报告用，无依赖，全走 React 元素不做 HTML 注入）
  - 可折叠日志 `LogFold()`
- `lib/` —— 状态目录（即数据目录）与配置文件 / 极小的 MCP stdio 客户端 / 扫码登录 /
  `hostdeps.mjs`（从宿主树取 `@deepseek-ai/*`，拿不到就退到自己依赖 / 本地等价实现）/
  `verify.mjs`（评论发出后复核）
- `prompts/duty.md` —— 一轮要做的事（判定口径 + 红线，**用户可以改**）；
  升级规矩见 `lib/state.mjs` 的 `ensureCharter`（用户改过 ⇒ 保留他那份、新版落 `duty.md.new`）
- `vendor/bilibili-mcp/` —— 内置的 Python MCP（MIT，AGI_Ananas）
- `selfcheck.mjs` + `tools/` —— 本地预检

## 约定

- 配置与运行数据都在用户的 `$DSH_HOME/bili-duty/`，**不写进插件包目录**
  - ⚠️ 目录名沿用 `bili-duty`（继承自上游）：改名会丢判重表 / 凭证 / 历史报告
- 谷时窗口按 DeepSeek 官方口径：工作日 9–12 / 14–18 是高峰，其余（含周末）都是谷时
- **默认值必须自洽**：`autoRunsPerDay × perRoundMax ≤ perDayMax`
  （否则每天上限先触发，「每天几轮」就是空头支票）
- 改完代码要重启 DSH（HMR 不监视 node_modules）
- **提交信息是写给仓库读者的**（这是公开仓库）：
  - 格式 `fix: …` / `feat: …` / `docs: …` / `chore: …`，**一句话说清改了什么**
  - 不写本地实验过程（「干净安装」「横幅会亮 11 项」「不打码」这类只有作者看得懂的现场记录）
  - 不写"我"、不写情绪、不写理由 —— 理由属于 PR 描述和代码注释
  - 同一个主题的多次调整，合并成一条提交再推
