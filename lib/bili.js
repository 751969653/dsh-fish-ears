// Bilibili audio extraction: BV id -> cid -> dash audio stream -> local file.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36'

const HEADERS = {
  'user-agent': UA,
  referer: 'https://www.bilibili.com/',
  origin: 'https://www.bilibili.com',
}

/** True when the string looks like a Bilibili reference rather than a file path. */
export function looksLikeBili(source) {
  const s = String(source ?? '').trim()
  return /BV[0-9A-Za-z]{10}/.test(s) || /b23\.tv\//.test(s) || /^(av\d+)$/i.test(s) || /bilibili\.com\/video\//.test(s)
}

/** Build a Cookie header from a SurfCore credential file when the user has one. */
function autoCookie() {
  const candidates = [path.join(os.homedir(), '.dsh', 'surfcore', 'bili', 'credentials.json')]
  for (const file of candidates) {
    try {
      const raw = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (raw?.sessdata) {
        const parts = [`SESSDATA=${raw.sessdata}`]
        if (raw.bili_jct) parts.push(`bili_jct=${raw.bili_jct}`)
        if (raw.buvid3) parts.push(`buvid3=${raw.buvid3}`)
        return parts.join('; ')
      }
    } catch {
      /* ignore */
    }
  }
  return ''
}

export function resolveCookie(configured) {
  const value = String(configured ?? '').trim()
  if (value) return value.includes('=') ? value : `SESSDATA=${value}`
  return autoCookie()
}

async function getJson(url, { cookie } = {}) {
  const res = await fetch(url, {
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}) },
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`Bilibili 接口返回 ${res.status}`)
  const json = await res.json()
  if (json?.code !== 0) throw new Error(`Bilibili 接口错误 ${json?.code}: ${json?.message ?? ''}`)
  return json.data
}

/** Turn a BV id, av number, b23 short link or full URL into { bvid, cid, title, duration }. */
export async function resolveVideo(source, { cookie } = {}) {
  let text = String(source ?? '').trim()
  if (/b23\.tv\//.test(text) || /^https?:\/\//.test(text)) {
    const res = await fetch(text, { headers: HEADERS, redirect: 'follow', signal: AbortSignal.timeout(20_000) })
    text = res.url || text
  }
  let bvid = text.match(/BV[0-9A-Za-z]{10}/)?.[0]
  let aid
  if (!bvid) {
    const av = text.match(/av(\d+)/i)?.[1]
    if (av) aid = av
  }
  if (!bvid && !aid) throw new Error('无法从输入里识别视频（需要 BV 号、av 号或视频链接）')
  const query = bvid ? `bvid=${bvid}` : `aid=${aid}`
  const view = await getJson(`https://api.bilibili.com/x/web-interface/view?${query}`, { cookie })
  return {
    bvid: view.bvid,
    cid: view.cid,
    title: view.title,
    duration: view.duration,
    owner: view.owner?.name ?? '',
  }
}

/** Pick the highest-bandwidth audio track from a dash payload. */
function bestAudio(dash) {
  const list = [...(dash?.audio ?? []), ...(dash?.dolby?.audio ?? []), ...(dash?.flac?.audio ? [dash.flac.audio] : [])]
  if (!list.length) return null
  return list.sort((a, b) => (b.bandwidth ?? 0) - (a.bandwidth ?? 0))[0]
}

/** Download the best audio track of a video into a temp file. Returns { file, info }. */
export async function downloadAudio(source, { cookie, log } = {}) {
  const video = await resolveVideo(source, { cookie })
  const play = await getJson(
    `https://api.bilibili.com/x/player/playurl?bvid=${video.bvid}&cid=${video.cid}&fnval=16&fourk=1`,
    { cookie },
  )
  const track = bestAudio(play?.dash)
  if (!track?.baseUrl && !track?.base_url) throw new Error('这个视频没有可用的音频流（可能是付费/大会员限定）')
  const url = track.baseUrl || track.base_url
  log?.(`B站 ${video.bvid}「${video.title}」音轨 ${Math.round((track.bandwidth ?? 0) / 1000)}kbps`)
  const res = await fetch(url, {
    headers: { ...HEADERS, ...(cookie ? { cookie } : {}), range: 'bytes=0-' },
    redirect: 'follow',
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok || !res.body) throw new Error(`音轨下载失败 ${res.status}`)
  const ext = url.includes('.m4s') || url.includes('m4a') ? 'm4a' : 'bin'
  const file = path.join(os.tmpdir(), `little-ears-bili-${video.bvid}-${Date.now()}.${ext}`)
  const handle = await fsp.open(file, 'w')
  try {
    for await (const chunk of res.body) await handle.write(chunk)
  } finally {
    await handle.close()
  }
  return { file, video }
}
