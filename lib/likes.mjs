/**
 * 点赞 / 收藏记账（`<stateDir>/likes.jsonl`，一行一个事件）
 *
 * 为什么不复用 `history.jsonl`：那份按 (date,bvid) 去重、存的是"看过什么"；
 * 点赞是可反复变的状态（赞了能撤），塞进同一套去重会把撤销记录吃掉 ⇒ 额度也算不准。
 *
 * 事件字段：`{ ts, day, kind:'like'|'fav', bvid, like:bool, reason, title?, owner? }`
 *   当前状态 = 同一 (kind,bvid) 的最后一条事件；`like:false` 就是撤销。
 */
import { appendFileSync, existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const likesFile = (stateDir) => join(stateDir, 'likes.jsonl')
export const isBvid = (s) => /^BV[0-9A-Za-z]{10}$/.test(String(s || ''))
export const KINDS = ['like', 'fav']

const lineOk = (e) => e && isBvid(e.bvid) && KINDS.includes(e.kind) && typeof e.like === 'boolean'

/** 全部事件（坏的半行跳过，不报错） */
export const readLikeEvents = (stateDir) => {
  const p = likesFile(stateDir)
  if (!existsSync(p)) return []
  const out = []
  for (const line of readFileSync(p, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue
    try {
      const e = JSON.parse(line)
      if (lineOk(e)) out.push({ ...e, ts: Number(e.ts) || 0, day: String(e.day || '') })
    } catch { /* 半行跳过 */ }
  }
  return out.sort((a, b) => a.ts - b.ts)
}

export const appendLikeEvent = (stateDir, ev) => {
  const p = likesFile(stateDir)
  // 2MB 轮转到 .1：这文件只追加，长期跑会一直长
  try {
    if (existsSync(p) && statSync(p).size > 2 * 1024 * 1024) renameSync(p, p + '.1')
  } catch { /* 轮转失败不影响写入 */ }
  appendFileSync(p, JSON.stringify(ev) + '\n')
  return ev
}

/** 同一 (kind,bvid) 的当前状态；没记录返回 null */
export const currentLike = (stateDir, kind, bvid) => {
  const list = readLikeEvents(stateDir).filter((e) => e.kind === kind && e.bvid === bvid)
  const last = list[list.length - 1]
  return last ? { like: last.like, ts: last.ts, reason: last.reason || '' } : null
}

/**
 * 今天"真的点出去"了几条 —— 只数 like:true 的事件。
 * `sinceTs` 用来算"这一轮"：传本轮开始时间，撤销不返还额度（防止赞了撤、撤了赞地刷）。
 */
export const countToday = (stateDir, kind, day, sinceTs = 0) => readLikeEvents(stateDir)
  .filter((e) => e.kind === kind && e.day === day && e.like && e.ts >= sinceTs).length

/** 面板要的形状：每个 bvid 一条，最近的在前 */
export const listForUi = (stateDir) => {
  const byKey = new Map()
  for (const e of readLikeEvents(stateDir)) byKey.set(`${e.kind}|${e.bvid}`, e)
  const mk = (kind) => [...byKey.values()]
    .filter((e) => e.kind === kind)
    .sort((a, b) => b.ts - a.ts)
    .map((e) => ({
      bvid: e.bvid, ts: e.ts, day: e.day,
      title: String(e.title || ''), owner: String(e.owner || ''),
      reason: String(e.reason || ''), undone: !e.like,
    }))
  return { like: mk('like'), fav: mk('fav') }
}

/** 撤销时把报告/历史里能补上的元信息（标题、UP）写回一行，界面才不是一片光秃秃的 BV 号 */
export const describeFromHistory = (stateDir, bvid, entries = []) => {
  const hit = (entries || []).find((e) => e.bvid === bvid)
  return hit ? { title: String(hit.title || ''), owner: String(hit.owner || '') } : { title: '', owner: '' }
}

/** 给测试/修复用：整份重写 */
export const replaceLikeEvents = (stateDir, events) => {
  const ok = (events || []).filter(lineOk)
  writeFileSync(likesFile(stateDir), ok.length ? ok.map((e) => JSON.stringify(e)).join('\n') + '\n' : '')
  return ok.length
}
