// 改动校验（2026-10-30，补 PR #1 的回归）：设置页没选线路时，跟随**宿主自己**的默认模型。
//
// 背景（PR #1 作者 Wine90 报告 + 本机复现）：桌面版是账号登录（provider `deepseek-account`），
// headless bundle 自带的默认线路却是 `deepseek-official`（API Key 那条）。本机没存
// `DEEPSEEK_API_KEY` ⇒ 那一轮必然死在 `MISSING_CREDENTIAL`；更糟的是**被误报成「B站 没登录」**，
// 用户反复扫码也不会有用。所以要做两件事：① 抄宿主的 `agent-default-model` 进 overlay；
// ② 把 `MISSING_CREDENTIAL` 归类到模型线路，而不是登录。
//
// ⚠️ 和 test-reuse-routes.mjs 一样，这里不是"源码里有没有这句话"的字符串检查：
//    把 `hostDefaultModelYml` / `classifyRunFailure` 的**真源码**切出来塞进沙箱里跑，用临时文件当宿主。
// ⚠️ hostPatchFile() 自己那套"宿主 profile 在哪"的解析规则由 tools/test-reuse-routes.mjs 覆盖
//    （含 Electron 里没有 DSH_* 环境变量的情形），这里只喂桩，专心验「抄什么、不抄什么」。

import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const P = join(dirname(fileURLToPath(import.meta.url)), '..')
const idx = readFileSync(join(P, 'index.js'), 'utf8')

const fail = []
let total = 0
const ok = (cond, msg) => { total++; if (!cond) fail.push(msg) }

// ── 切出真源码（按声明起止切，不写死行号） ──
const between = (from, to) => {
  const a = idx.indexOf(from)
  const b = idx.indexOf(to, a)
  ok(a > 0, `index.js 里找不到 ${from}（这块逻辑没了？）`)
  ok(b > a, `index.js 里找不到 ${to}（切不出 ${from} 的边界）`)
  return idx.slice(a, b)
}
const src = [
  between('const splitPatchBlocks', 'const routeOverlayYml'),
  between('const hostDefaultModelYml', 'const writeRouteOverlay'),
  between('const classifyRunFailure', 'const runDuty'),
].join('\n')

const dir = mkdtempSync(join(tmpdir(), 'pond-host-model-'))
const hostFile = join(dir, 'cordis.patch.yml')
const runLog = join(dir, 'run.log')
writeFileSync(runLog, '', 'utf8')

/** 造一个沙箱：hostText 写进"宿主 profile 的 patch 层"，noHostFile=true 模拟宿主没这文件 */
function build({ hostText = '', noHostFile = false, runlog = '' } = {}) {
  const logs = []
  if (!noHostFile) writeFileSync(hostFile, hostText, 'utf8')
  writeFileSync(runLog, runlog, 'utf8')
  const api = new Function(
    'hostPatchFile', 'readFileSync', 'log', 'runLogFile',
    src + '\nreturn { splitPatchBlocks, hostDefaultModelYml, classifyRunFailure }',
  )(
    () => (noHostFile ? '' : hostFile),
    readFileSync,
    (m) => logs.push(String(m)),
    runLog,
  )
  api.logs = logs
  return api
}

const ymlOf = (hostText) => build({ hostText }).hostDefaultModelYml()
const eq = (name, got, want) => ok(JSON.stringify(got) === JSON.stringify(want),
  `${name}：得到 ${JSON.stringify(got)}，期望 ${JSON.stringify(want)}`)

// ── ① 账号登录那条路（PR 报的现场）：照抄 provider/model，且只写这 4 行 ──
{
  const host = `- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: deepseek-account
    model: deepseek-flash
- id: ui-chat
  config:
    provider: whatever
`
  const s = build({ hostText: host })
  const got = s.hostDefaultModelYml()
  eq('账号登录场景要抄成 overlay', got, [
    '- id: agent-default-model', '  config:', '    provider: deepseek-account', '    model: deepseek-flash',
  ])
  ok(got.length === 4, 'overlay 只能写 id + config 这 4 行（多写会把宿主的其它配置一起覆盖掉）')
  ok(!got.join('\n').includes('ui-chat'), '只认 agent-default-model，别的 entry 一概不碰')
  ok(s.logs.some((m) => m.includes('deepseek-account') && m.includes('deepseek-flash')),
    '抄到了要在 duty.log 里说清楚（不然线上没法排错）')
}

// ── ② 自定义线路（本机就是这条：宿主默认线路是 blts） ──
eq('自定义线路', ymlOf(`- id: agent-default-model
  config:
    provider: blts
    model: deepseek-v4.1-flash
`), ['- id: agent-default-model', '  config:', '    provider: blts', '    model: deepseek-v4.1-flash'])

// ── ③ 宿主那边本来就 disabled: true ⇒ 不抄（别把人关掉的东西硬打开） ──
eq('disabled: true 不抄', ymlOf(`- id: agent-default-model
  disabled: true
  config:
    provider: deepseek-account
    model: deepseek-flash
`), [])

// ── ④ 宿主写的是 disabled: false ⇒ 照抄（只拦 true） ──
eq('disabled: false 照抄', ymlOf(`- id: agent-default-model
  disabled: false
  config:
    provider: blts
    model: hy3
`), ['- id: agent-default-model', '  config:', '    provider: blts', '    model: hy3'])

// ── ⑤ 🔴 只写了一半 ⇒ 一行都不写 ──
//    （2026-10-22 实测：agent-default-model 的 model 是必填，只写 provider 会让插件激活失败、
//     整个值班 exit 1 `$.model missing required value`）
eq('只有 provider 没有 model ⇒ []', ymlOf(`- id: agent-default-model
  config:
    provider: deepseek-account
`), [])
eq('只有 model 没有 provider ⇒ []', ymlOf(`- id: agent-default-model
  config:
    model: deepseek-flash
`), [])

// ── ⑥ 抄不到就静默跳过（绝不硬写半条），值班照旧跟随 headless 默认模型 ──
eq('宿主没有这条 ⇒ []', ymlOf(`- id: ui-chat
  config:
    provider: whatever
`), [])
eq('宿主 patch 是空文件 ⇒ []', ymlOf('   \n'), [])
eq('宿主 patch 只有注释 ⇒ []', ymlOf('# 什么都没有\n'), [])
eq('找不到宿主 patch 文件 ⇒ []', build({ noHostFile: true }).hostDefaultModelYml(), [])

// ── ⑦ 引号 / 行尾注释都要摘干净（写进 YAML 的值不能带引号和注释） ──
eq('引号与行尾注释', ymlOf(`# provider: 这是注释，不能被当成值
- id: agent-default-model
  config:
    provider: "workbuddy"   # 本地反代
    model: 'glm-5.3'
`), ['- id: agent-default-model', '  config:', '    provider: workbuddy', '    model: glm-5.3'])

// ── ⑧ 同一条 entry 出现两次也只抄一份（和 routeOverlayYml 的 seen 去重保持一致） ──
{
  const got = ymlOf(`- id: agent-default-model
  config:
    provider: a
    model: b
- id: agent-default-model
  config:
    provider: c
    model: d
`)
  ok(got.filter((l) => l === '- id: agent-default-model').length === 1, '同一条 entry 抄了两份会叠两层配置')
  eq('重复 entry 取第一份', got, ['- id: agent-default-model', '  config:', '    provider: a', '    model: b'])
}

// ── ⑨ 失败归类：模型线路缺凭据不许再被报成「B站 没登录」 ──
const why = (runlog, code = 1, took = 90) => {
  const r = build({ runlog }).classifyRunFailure(code, took)
  return r ? r.code : null
}
ok(why('MISSING_CREDENTIAL: llm-deepseek 没有可用的 API key') === 'model',
  'MISSING_CREDENTIAL 被归成了别的类别（界面又会让人去扫码）')
ok(why('NO_ADAPTER: buddy') === 'model', 'NO_ADAPTER 应归模型线路')
ok(why('ACCOUNT_SIGN_IN_REQUIRED') === 'model', 'ACCOUNT_SIGN_IN_REQUIRED 应归模型线路')
ok(why('未登录B站！请先调用 bili_login') === 'login', 'B站 没登录要归 login')
ok(why('凭证失效，请重新扫码') === 'login', 'B站 凭证失效要归 login')
ok(why('登录失效') === 'login', 'B站 登录失效要归 login')
ok(why('HTTP 401 Unauthorized') === 'model', '旧的 401 归类别动（模型线路那边的典型报错）')
ok(why('ETIMEDOUT') === 'network', '网络错误应归 network')
ok(why('### BV1xx 报告已写 out/2026-10-30.md', 0, 106) === null, '正常跑完不该报失败')
ok(why('nothing here', 0, 3) === 'too_fast', '一睁眼就退出应归 too_fast')
/* 🔴 顺序红线：模型线路的关键字必须比「未登录」先判 —— 反过来的话，
 *    MISSING_CREDENTIAL 里那个 "credential" 又会被 B站 的登录分支抢走。 */
{
  const iModel = idx.indexOf('MISSING_CREDENTIAL|NO_ADAPTER')
  const iLogin = idx.indexOf('未登录|登录失效|凭证失效')
  ok(iModel > 0 && iLogin > 0 && iModel < iLogin, 'classifyRunFailure 里「模型线路」分支必须排在「登录」分支前面')
}

// ── ⑩ 接线：没选线路时真的会走到这一步（不接上，前面全对也白搭） ──
ok(/let modelYml = modelOverrideYml\(\)/.test(idx), 'ensureOverlay 不再用 modelOverrideYml 起头（接线断了）')
ok(/if \(!modelYml\.length\) modelYml = hostDefaultModelYml\(\)/.test(idx),
  'ensureOverlay 没在「没选线路」时回退到宿主默认模型（这个功能等于没接）')
ok(/if \(modelYml\.length\) yml\.push\(\.\.\.modelYml, ''\)/.test(idx), 'modelYml 没写进 overlay')
/* ⭐ 复制进 overlay 的必须是「设置页选的」或「宿主默认的」，二者不能同时出现两份 */
ok(/const ROUTE_SKIP_IDS[\s\S]{0,200}agent-default-model/.test(idx),
  'agent-default-model 得留在 ROUTE_SKIP_IDS 里，否则 routeOverlayYml 会再抄一份（叠两层配置）')

// 收尾
rmSync(dir, { recursive: true, force: true })

if (fail.length) {
  console.error('❌ 宿主默认模型校验失败：')
  for (const f of fail) console.error('   - ' + f)
  process.exit(1)
}
console.log(`✅ 宿主默认模型校验通过（${total} 条断言）`)
