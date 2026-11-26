// Local ASR model registry: tiers, on-demand download, and legacy reuse.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

export const MIRROR = 'https://hf-mirror.com'

export const TIERS = {
  low: {
    id: 'low',
    label: '低 · Paraformer 小',
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-small-2024-03-09',
    kind: 'paraformer',
    approximateSize: '82 MB',
    files: { model: 'model.int8.onnx', tokens: 'tokens.txt' },
  },
  mid: {
    id: 'mid',
    label: '中 · SenseVoice Small',
    repo: 'csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17',
    kind: 'senseVoice',
    approximateSize: '228 MB',
    files: { model: 'model.int8.onnx', tokens: 'tokens.txt' },
  },
  high: {
    id: 'high',
    label: '高 · Paraformer 大',
    repo: 'csukuangfj/sherpa-onnx-paraformer-zh-2023-09-14',
    kind: 'paraformer',
    approximateSize: '232 MB',
    files: { model: 'model.int8.onnx', tokens: 'tokens.txt' },
  },
}

/** Where local models live when the user leaves the directory blank. */
export function defaultModelRoot() {
  return path.join(os.homedir(), '.dsh', 'fish-ears', 'models')
}

/** Known existing installs we can reuse instead of downloading again. */
function legacyCandidates(tierId) {
  if (tierId !== 'low') return []
  return [
    path.join(os.homedir(), 'surfcore', 'state', 'asr', 'paraformer-zh-small'),
    path.join(os.homedir(), '.dsh', 'surfcore', 'asr', 'paraformer-zh-small'),
  ]
}

export function tierDir(root, tierId) {
  return path.join(root, tierId)
}

export function modelPaths(root, tierId) {
  const spec = TIERS[tierId]
  const dir = tierDir(root, tierId)
  return {
    dir,
    model: path.join(dir, spec.files.model),
    tokens: path.join(dir, spec.files.tokens),
  }
}

export function hasModel(root, tierId) {
  const p = modelPaths(root, tierId)
  return fs.existsSync(p.model) && fs.existsSync(p.tokens)
}

export function modelSize(root, tierId) {
  const p = modelPaths(root, tierId)
  try {
    return fs.statSync(p.model).size + fs.statSync(p.tokens).size
  } catch {
    return 0
  }
}

/** Copy an existing local install into our model root (fast, no network). */
async function seedFromLegacy(root, tierId, log) {
  for (const dir of legacyCandidates(tierId)) {
    const model = path.join(dir, TIERS[tierId].files.model)
    const tokens = path.join(dir, TIERS[tierId].files.tokens)
    if (!fs.existsSync(model) || !fs.existsSync(tokens)) continue
    const target = modelPaths(root, tierId)
    await fsp.mkdir(target.dir, { recursive: true })
    await fsp.copyFile(model, target.model)
    await fsp.copyFile(tokens, target.tokens)
    log?.(`复用了已有的本地模型：${dir}`)
    return true
  }
  return false
}

async function downloadFile(url, dest, log) {
  const res = await fetch(url, { redirect: 'follow' })
  if (!res.ok || !res.body) throw new Error(`下载失败 ${res.status} ${url}`)
  const total = Number(res.headers.get('content-length') ?? 0)
  const tmp = `${dest}.part`
  await fsp.mkdir(path.dirname(dest), { recursive: true })
  const handle = await fsp.open(tmp, 'w')
  let written = 0
  let lastLog = 0
  try {
    for await (const chunk of res.body) {
      await handle.write(chunk)
      written += chunk.length
      const now = Date.now()
      if (log && now - lastLog > 4000) {
        lastLog = now
        const pct = total ? Math.round((written / total) * 100) : 0
        log(`下载中 ${path.basename(dest)} ${(written / 1048576).toFixed(1)}/${total ? (total / 1048576).toFixed(1) : '?'} MB (${pct}%)`)
      }
    }
  } finally {
    await handle.close()
  }
  await fsp.rename(tmp, dest)
  return written
}

/**
 * Make sure the selected tier is on disk. Returns { ok, dir, downloaded }.
 * Downloading is skipped when `allowDownload` is false.
 */
export async function ensureModel({ root, tierId, allowDownload = true, log } = {}) {
  const spec = TIERS[tierId]
  if (!spec) throw new Error(`unknown model tier: ${tierId}`)
  const target = modelPaths(root, tierId)
  if (hasModel(root, tierId)) return { ok: true, ...target, downloaded: false, tier: tierId }
  if (await seedFromLegacy(root, tierId, log)) return { ok: true, ...target, downloaded: false, tier: tierId, seeded: true }
  if (!allowDownload) return { ok: false, ...target, tier: tierId, reason: '模型未安装，且已关闭自动下载' }
  await fsp.mkdir(target.dir, { recursive: true })
  for (const [key, name] of Object.entries(spec.files)) {
    const url = `${MIRROR}/${spec.repo}/resolve/main/${name}`
    log?.(`开始下载 ${spec.label} · ${name}`)
    await downloadFile(url, target[key], log)
  }
  if (!hasModel(root, tierId)) throw new Error('下载完成但文件不完整')
  log?.(`${spec.label} 就绪：${target.dir}`)
  return { ok: true, ...target, downloaded: true, tier: tierId }
}
