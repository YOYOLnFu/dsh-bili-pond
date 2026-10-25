/**
 * 点赞 / 收藏的闸门与记账测试（不碰网络：用一个假 MCP 顶替真正的 python MCP）。
 *
 * 用法：node tools/test-likes.mjs [插件目录]
 *   · 假 MCP 就是 `stateDir/mcp_server.py` —— 内容是**一段 Node 脚本**（测试里把 pythonPath 指到 node），
 *     协议照 lib/mcp.mjs：一行一个 JSON-RPC，只认 initialize / tools/call。
 *   · 它回什么由 `stateDir/fake-mcp.json` 决定，调用轨迹写 `stateDir/fake-mcp-calls.jsonl`。
 */
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { tmpdir } from 'node:os'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { dayKey } from '../lib/state.mjs'
import { readLikeEvents, currentLike, countToday, listForUi, appendLikeEvent } from '../lib/likes.mjs'

const PLUGIN = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..')
let failures = 0
const ok = (c, l, e) => {
  if (c) console.log('  ✓ ' + l)
  else { failures++; console.log('  ✗ ' + l + (e !== undefined ? '  → ' + JSON.stringify(e).slice(0, 300) : '')) }
}

const FAKE_MCP = String.raw`
const fs = require('node:fs')
const wrap = (p) => ({ content: [{ type: 'text', text: JSON.stringify(p) }] })
const reply = (id, result) => { if (id !== undefined) process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n') }
let buf = ''
process.stdin.setEncoding('utf8')
process.stdin.on('data', (c) => {
  buf += c
  let i
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1)
    if (!line) continue
    let msg; try { msg = JSON.parse(line) } catch { continue }
    if (msg.method === 'initialize') { reply(msg.id, { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fake', version: '0' } }); continue }
    if (msg.method === 'notifications/initialized') continue
    if (msg.method !== 'tools/call') { reply(msg.id, {}); continue }
    const name = msg.params && msg.params.name
    const args = (msg.params && msg.params.arguments) || {}
    fs.appendFileSync('fake-mcp-calls.jsonl', JSON.stringify({ name, args, at: Date.now() }) + '\n')
    let payload = { ok: true, bvid: args.bvid, like: args.like !== false }
    try {
      const table = JSON.parse(fs.readFileSync('fake-mcp.json', 'utf8') || '{}')
      const v = table[name]
      if (Array.isArray(v)) {
        payload = v.length ? v.shift() : { ok: false, error: 'fake: queue empty' }
        fs.writeFileSync('fake-mcp.json', JSON.stringify(table))
      } else if (v && typeof v === 'object') payload = v
    } catch (e) { /* 没有 fake-mcp.json 就用默认成功 */ }
    reply(msg.id, wrap(payload))
  }
})
`

/** 起一份插件（临时家目录），返回工具表、路由、以及"往假 MCP 里下一条回复"的钩子 */
async function withPlugin({ cfg = {}, seed = [], cooldown = null, mcp = {} } = {}) {
  const HOME = mkdtempSync(join(tmpdir(), 'likes-'))
  const STATE = join(HOME, 'bili-duty')
  mkdirSync(STATE, { recursive: true })
  writeFileSync(join(STATE, 'config.json'), JSON.stringify({ likeOn: true, pythonPath: process.execPath, ...cfg }), 'utf8')
  writeFileSync(join(STATE, 'bili_credential.json'), JSON.stringify({ SESSDATA: 'x', bili_jct: 'y', DedeUserID: '1' }), 'utf8')
  if (cooldown) writeFileSync(join(STATE, 'like-cooldown.json'), JSON.stringify(cooldown), 'utf8')
  if (seed.length) writeFileSync(join(STATE, 'likes.jsonl'), seed.map((e) => JSON.stringify(e)).join('\n') + '\n', 'utf8')
  const mod = await import(pathToFileURL(join(PLUGIN, 'index.js')).href + '?t=' + Date.now())
  const tools = new Map()
  const routes = []
  const disposers = []
  const ctx = {
    get: (n) => (n === 'dshHomePath' ? (name) => join(HOME, name) : undefined),
    effect: (f) => { try { const d = f(); if (typeof d === 'function') disposers.push(d); return () => {} } catch { return () => {} } },
    logger: { info() {}, warn() {}, error() {}, debug() {} },
    on: () => {}, debounce: (f) => f,
    settings: { describe: () => [], update: async () => {} },
    tools: { register: (t) => { tools.set(t.name, t); return () => { tools.delete(t.name) } } },
    webServer: { register: (r) => { routes.push(r); return () => {} } },
  }
  const ret = mod.apply(ctx, {})
  if (typeof ret === 'function') disposers.push(ret)
  /* ⚠️ apply() 里 ensureHomeFiles 会把 vendor 的真 mcp_server.py 铺进来 —— 铺完再换成假的 */
  writeFileSync(join(STATE, 'mcp_server.py'), FAKE_MCP, 'utf8')
  writeFileSync(join(STATE, 'fake-mcp.json'), JSON.stringify(mcp), 'utf8')
  const route = routes[0]
  const req = async (method, url, body) => {
    const res = { body: '', writeHead() {}, end(b) { this.body = b } }
    await route.handler({
      method, url,
      on: (ev, cb) => {
        if (ev === 'data' && body !== undefined) cb(Buffer.from(JSON.stringify(body)))
        if (ev === 'end') cb()
      },
    }, res)
    return JSON.parse(res.body || '{}')
  }
  const callTool = (name, args) => tools.get(name).execute(args, {})
  const mcpCalls = () => (existsSync(join(STATE, 'fake-mcp-calls.jsonl'))
    ? readFileSync(join(STATE, 'fake-mcp-calls.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l))
    : [])
  /* 假 MCP 是**子进程**，cwd 就在临时目录里 ⇒ 不先把它停掉，Windows 上删目录会 EPERM */
  const cleanup = () => {
    for (const d of disposers) { try { d() } catch { /* 忽略 */ } }
    try { rmSync(HOME, { recursive: true, force: true, maxRetries: 20, retryDelay: 50 }) } catch { /* 删不掉就留给系统清 */ }
  }
  return { HOME, STATE, tools, req, callTool, mcpCalls, cleanup }
}

const today = () => dayKey()
const ago = (ms) => Date.now() - ms
const oldIso = () => new Date(ago(3 * 3600_000)).toISOString()
const WHY = '这条我回头照着试一次'          // ≥6 字，过闸门
const WHY2 = '这条也有用啊真的'

/* ════════════ ① lib/likes.mjs 本身 ════════════ */
console.log('=== ① 记账模块（追加 / 当前状态 / 今日计数 / 撤销） ===')
{
  const HOME = mkdtempSync(join(tmpdir(), 'likeslib-'))
  appendLikeEvent(HOME, { ts: Date.now(), day: today(), kind: 'like', bvid: 'BV1xx411c7mD', like: true, reason: '有用' })
  appendLikeEvent(HOME, { ts: Date.now() + 1, day: today(), kind: 'like', bvid: 'BV1xx411c7mD', like: false, reason: '后悔了' })
  ok(readLikeEvents(HOME).length === 2, '两条事件都留下（撤销不删行）')
  ok(currentLike(HOME, 'like', 'BV1xx411c7mD')?.like === false, '当前状态 = 最后一条（已撤销）')
  ok(countToday(HOME, 'like', today()) === 1, '今日计数只数 like:true', countToday(HOME, 'like', today()))
  const ui = listForUi(HOME)
  ok(ui.like.length === 1 && ui.like[0].undone === true, '面板形状：一条 + undone=true', ui.like)
  appendLikeEvent(HOME, { ts: Date.now(), day: today(), kind: 'fav', bvid: 'BV1yy411c7mE', like: true, reason: '回头查' })
  ok(listForUi(HOME).fav.length === 1 && listForUi(HOME).like.length === 1, '赞和收分开算')
  // 坏行不该让整份读崩
  writeFileSync(join(HOME, 'likes.jsonl'), '{"kind":"like","bvid":"bad"}\nnot json\n' + JSON.stringify({ ts: Date.now(), day: today(), kind: 'like', bvid: 'BV1zz411c7mF', like: true }) + '\n', 'utf8')
  ok(readLikeEvents(HOME).length === 1, '坏行/半行跳过，好行照读', readLikeEvents(HOME).length)
  rmSync(HOME, { recursive: true, force: true })
}

/* ════════════ ② 写入钳制（HTTP /config） ════════════ */
console.log('\n=== ② 配置钳制：硬顶 / 非法值 / 0 不回落 ===')
{
  const s = await withPlugin({ cfg: { likeOn: false } })
  let r = await s.req('POST', '/api/bili-pond/config', { likePerDay: 999, favPerDay: 99, likePerRound: 9, likeRule: '乱写', likeRuleExtra: 'x'.repeat(400) })
  ok(r.config.likePerDay === 10, 'likePerDay 999 ⇒ 硬顶 10', r.config.likePerDay)
  ok(r.config.favPerDay === 8, 'favPerDay 99 ⇒ 硬顶 8', r.config.favPerDay)
  ok(r.config.likePerRound === 5, 'likePerRound 9 ⇒ 硬顶 5', r.config.likePerRound)
  ok(r.config.likeRule === 'standard', '非法档位回落到 standard', r.config.likeRule)
  ok(r.config.likeRuleExtra.length === 300, '自定义判据截到 300 字', r.config.likeRuleExtra.length)
  r = await s.req('POST', '/api/bili-pond/config', { likePerDay: 0, likePerRound: 0, favPerDay: 0 })
  ok(r.config.likePerDay === 0 && r.config.likePerRound === 0 && r.config.favPerDay === 0, '0 原样保留（不被默认值顶掉）', [r.config.likePerDay, r.config.likePerRound, r.config.favPerDay])
  r = await s.req('POST', '/api/bili-pond/config', { likeRule: 'strict' })
  ok(r.config.likeRule === 'strict', '合法档位照存', r.config.likeRule)
  s.cleanup()
}

/* ════════════ ③ 闸门（全在"拒绝"那一侧，不需要网络） ════════════ */
console.log('\n=== ③ 闸门：开关 / 理由 / bvid / 登录 / 额度 / 熔断 / 幂等 ===')
{
  const s = await withPlugin({ cfg: { likeOn: false } })
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: WHY })
  ok(r.ok === false && r.blocked === true, '开关关着 ⇒ 拒（blocked）', r)
  ok(s.mcpCalls().length === 0, '被拒时**没有**请求 MCP')
  s.cleanup()
}
{
  const s = await withPlugin({ cfg: { likeOn: true, likePerDay: 3 } })
  let r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: '短的' })
  ok(r.ok === false && /理由/.test(r.error), '理由 <6 字 ⇒ 拒', r)
  r = await s.callTool('bili_like', { bvid: '这不是BV', reason: WHY })
  ok(r.ok === false && /bvid/.test(r.error), 'bvid 非法 ⇒ 拒', r)
  ok(s.mcpCalls().length === 0, '两种拒都发生在调 MCP 之前')
  s.cleanup()
}
{
  const s = await withPlugin({ cfg: { likeOn: true } })
  rmSync(join(s.STATE, 'bili_credential.json'))
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: WHY })
  ok(r.ok === false && /登录/.test(r.error), '没凭证 ⇒ 拒并说"去登录"', r)
  s.cleanup()
}
{
  const seed = [1, 2, 3].map((n) => ({ ts: ago(n * 1000), day: today(), kind: 'like', bvid: `BV1xx411c7m${n}`, like: true, reason: 'seed' }))
  const s = await withPlugin({ cfg: { likeOn: true, likePerDay: 3, likePerRound: 5 }, seed })
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: WHY })
  ok(r.ok === false && /上限/.test(r.error), '今天到 3 条 ⇒ 拒', r)
  ok(s.mcpCalls().length === 0, '到上限时没有请求 MCP')
  s.cleanup()
}
{
  // 每轮上限：种子事件发生在"上一轮开始"之后 ⇒ 算在"这一轮"里
  const seed = [{ ts: ago(60_000), day: today(), kind: 'like', bvid: 'BV1xx411c7mA', like: true, reason: 'seed' }]
  const s = await withPlugin({ cfg: { likeOn: true, likePerDay: 5, likePerRound: 1 }, seed })
  writeFileSync(join(s.STATE, 'state.json'), JSON.stringify({ lastRunAt: oldIso() }), 'utf8')
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: WHY })
  ok(r.ok === false && /这一轮/.test(r.error), '每轮 1 条已用掉 ⇒ 拒', r)
  s.cleanup()
}
{
  const seed = [{ ts: ago(3600_000), day: today(), kind: 'like', bvid: 'BV1xx411c7mD', like: true, reason: 'seed' }]
  const s = await withPlugin({ cfg: { likeOn: true, likePerDay: 5 }, seed })
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: WHY })
  ok(r.ok === true && r.already === true, '已经赞过 ⇒ already:true', r)
  ok(s.mcpCalls().length === 0, '幂等时没有重复请求')
  const r2 = await s.callTool('bili_like', { bvid: 'BV1xx411c7mZ', like: false })
  ok(r2.ok === false && /撤销/.test(r2.error), '撤一条没赞过的 ⇒ 拒', r2)
  s.cleanup()
}
{
  const s = await withPlugin({ cfg: { likeOn: true }, cooldown: { until: Date.now() + 600_000, why: '-352 风控' } })
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: WHY })
  ok(r.ok === false && /风控/.test(r.error), '冷却期内 ⇒ 拒', r)
  ok(s.mcpCalls().length === 0, '冷却期没有请求 MCP')
  s.cleanup()
}

/* ════════════ ④ 成功路径（走假 MCP）+ 记账 + 面板接口 ════════════ */
console.log('\n=== ④ 真点出去：记账 / 今日计数 / 失败熔断 / 面板接口 ===')
{
  const s = await withPlugin({ cfg: { likeOn: true, likePerDay: 3, likePerRound: 1 } })
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: '看完能直接照着重装一次' })
  ok(r.ok === true && r.like === true && r.today === 1, '第一次点赞成功并记 1 条', r)
  const calls = s.mcpCalls()
  ok(calls.length === 1 && calls[0].name === 'bili_like' && calls[0].args.like === true, 'MCP 收到 {bvid, like:true}', calls)
  const ev = readLikeEvents(s.STATE)
  ok(ev.length === 1 && ev[0].reason.includes('重装'), '事件里有理由（给使用者看得懂）', ev)
  const r2 = await s.callTool('bili_like', { bvid: 'BV1yy411c7mE', reason: WHY2 })
  ok(r2.ok === false && /这一轮/.test(r2.error), '同一轮再点一条 ⇒ 被每轮上限拒', r2)
  s.cleanup()
}
{
  const s = await withPlugin({
    cfg: { likeOn: true },
    seed: [{ ts: ago(3600_000), day: today(), kind: 'like', bvid: 'BV1xx411c7mD', like: true, reason: 'seed' }],
  })
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', like: false })
  ok(r.ok === true && r.undone === true, '撤销成功（真的发了 like:false 请求）', r)
  const calls = s.mcpCalls()
  ok(calls.length === 1 && calls[0].args.like === false, 'MCP 收到 like:false', calls)
  ok(currentLike(s.STATE, 'like', 'BV1xx411c7mD').like === false, '记账里当前状态变成"没赞"')
  ok(countToday(s.STATE, 'like', today()) === 1, '撤销不返还额度（今天仍算用过 1 条）', countToday(s.STATE, 'like', today()))
  s.cleanup()
}
{
  const s = await withPlugin({
    cfg: { likeOn: false },
    seed: [{ ts: ago(3600_000), day: today(), kind: 'like', bvid: 'BV1xx411c7mD', like: true, reason: 'seed' }],
  })
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', like: false })
  ok(r.ok === true, '开关关着也能撤销自己赞过的（点错了要能收回来）', r)
  s.cleanup()
}
{
  const s = await withPlugin({ cfg: { likeOn: true, likePerDay: 5, likePerRound: 5 }, mcp: { bili_like: { ok: false, error: '接口返回 -352 风控校验失败' } } })
  const r = await s.callTool('bili_like', { bvid: 'BV1xx411c7mD', reason: WHY })
  ok(r.ok === false && /风控/.test(r.error), 'MCP 报 -352 ⇒ 失败并把原因带回', r)
  ok(existsSync(join(s.STATE, 'like-cooldown.json')), '撞风控后写了冷却文件')
  const r2 = await s.callTool('bili_like', { bvid: 'BV1yy411c7mE', reason: WHY2 })
  ok(r2.ok === false && /风控/.test(r2.error), '冷却期内第二条直接被拒', r2)
  ok(readLikeEvents(s.STATE).length === 0, '失败的尝试不记账（不然额度会被白白吃掉）')
  s.cleanup()
}
{
  const s = await withPlugin({ cfg: { favOn: true, favPerDay: 2 }, mcp: { bili_fav: { ok: true, bvid: 'BV1xx411c7mD', fav: true, folder: '默认收藏夹' } } })
  const r = await s.callTool('bili_fav', { bvid: 'BV1xx411c7mD', reason: '下次配环境时翻回来' })
  ok(r.ok === true && r.fav === true && r.folder === '默认收藏夹', '收藏成功并带回收藏夹名', r)
  const calls = s.mcpCalls()
  ok(calls.length === 1 && calls[0].name === 'bili_fav' && calls[0].args.fav === true, 'MCP 收到 {bvid, fav:true}', calls)
  const r2 = await s.callTool('bili_fav', { bvid: 'BV1yy411c7mE', reason: WHY2 })
  ok(r2.ok === true, '第二条收藏也成功（每天上限 2）', r2)
  const r3 = await s.callTool('bili_fav', { bvid: 'BV1zz411c7mF', reason: WHY2 })
  ok(r3.ok === false && /上限/.test(r3.error), '第 3 条收藏被每天上限拒', r3)
  s.cleanup()
}
{
  const seed = [
    { ts: ago(7200_000), day: today(), kind: 'like', bvid: 'BV1xx411c7mD', like: true, reason: 'seed', title: '标题A', owner: 'UP_A' },
    { ts: ago(3600_000), day: today(), kind: 'fav', bvid: 'BV1yy411c7mE', like: true, reason: 'seed2' },
  ]
  const s = await withPlugin({ cfg: { likeOn: true, likePerDay: 3, favOn: true, favPerDay: 2 }, seed })
  let g = await s.req('GET', '/api/bili-pond/likes')
  ok(g.ok === true && g.like.today === 1 && g.like.perDay === 3, 'GET /likes：今日 1 / 上限 3', g.like)
  ok(g.like.items.length === 1 && g.like.items[0].bvid === 'BV1xx411c7mD', 'items 里有那条赞', g.like.items)
  ok(g.fav.today === 1 && g.fav.perDay === 2, '收藏计数独立', g.fav)
  const u = await s.req('POST', '/api/bili-pond/likes/undo', { bvid: 'BV1xx411c7mD', kind: 'like' })
  ok(u.ok === true && u.undone === true, 'POST /likes/undo 撤销成功', u)
  g = await s.req('GET', '/api/bili-pond/likes')
  ok(g.like.items[0].undone === true, '撤销后 items 标 undone（卡片角标会消失）', g.like.items)
  const u2 = await s.req('POST', '/api/bili-pond/likes/undo', { bvid: 'BV1zz411c7mF', kind: 'like' })
  ok(u2.ok === false, '撤销没赞过的 ⇒ 面板拿到失败原因', u2)
  s.cleanup()
}

console.log('\n' + (failures === 0 ? '全部通过 ✓' : failures + ' 项失败 ✗'))
process.exit(failures === 0 ? 0 : 1)
