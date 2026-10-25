// 抽 index.js 里真实的 INTENT_LINE / parseLikeIntents 来单测（不 import 整个插件）
// 用法：node tools/tmp-parse-test.mjs   （临时用，不进提交）
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'index.js'), 'utf8')
const i = src.indexOf('const INTENT_LINE')
const j = src.indexOf('/** 轮末把报告里的点赞/收藏意图')
if (i < 0 || j < 0) throw new Error(`抽不到代码段 i=${i} j=${j}`)
const block = src.slice(i, j)
const mod = await import(`data:text/javascript,${encodeURIComponent(block + '\nexport { parseLikeIntents }')}`)
const parseLikeIntents = mod.parseLikeIntents

let bad = 0
const cases = [
  ['- ✅ 赞 · BV1YAHG6LEAp · 讲了 n-gram 基线怎么建', 'like', 'BV1YAHG6LEAp'],
  ['✅ 赞 · BV1YTHN6bE6Y · 省钱套路能直接用', 'like', 'BV1YTHN6bE6Y'],
  ['⭐ 藏 · BV1AgHK6jEEW · 下次调 prompt 翻回来对照', 'fav', 'BV1AgHK6jEEW'],
  ['赞 · BV1BznH6mE61 · 没有前缀也认', 'like', 'BV1BznH6mE61'],
  ['* ✅ 赞: BV1aBCdEf12G · 半角冒号也认', 'like', 'BV1aBCdEf12G'],
]
for (const [line, kind, bvid] of cases) {
  const list = parseLikeIntents(line)
  const ok = list.length === 1 && list[0].kind === kind && list[0].bvid === bvid
  if (!ok) { bad++; console.log('✗', line, JSON.stringify(list)) } else console.log('✓', kind, bvid, '理由:', list[0].reason.slice(0, 14))
}

const noise = [
  '今天挑了 3 条：BV1YAHG6LEAp、BV1YTHN6bE6Y',
  '- 评论区在吵架，不赞',
  '| `BV1YAHG6LEAp` | 挑了 | 时长 12 分钟 |',
  '✅ 赞 · BV1YAHG6LEAp',   // 没理由：行本身解析出来，理由为空 ⇒ 交给 interact 拦（这里只验解析）
]
for (const line of noise.slice(0, 3)) {
  const n = parseLikeIntents(line).length
  if (n) { bad++; console.log('✗ 误判:', line, '→', n) } else console.log('✓ 没误判:', line.slice(0, 22))
}
const noReason = parseLikeIntents(noise[3])
console.log(noReason.length === 1 && noReason[0].reason === '' ? '✓ 无理由行解析出来、理由为空（等 interact 拒）' : '✗ 无理由行解析异常')
console.log(bad ? `FAIL ${bad}` : 'ALL PASS')
process.exitCode = bad ? 1 : 0
