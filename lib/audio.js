// Audio helpers: RIFF parsing, resampling, and ffmpeg transcoding.
// Kept dependency-free on purpose: the only external tool is ffmpeg.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

export const TARGET_RATE = 16000

/** Parse a RIFF/WAVE buffer into mono Float32 samples in [-1, 1]. */
export function decodeWav(buf) {
  if (buf.length < 12 || buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error('not a RIFF/WAVE file')
  }
  let off = 12
  let fmt = null
  let data = null
  while (off + 8 <= buf.length) {
    const id = buf.toString('ascii', off, off + 4)
    const size = buf.readUInt32LE(off + 4)
    const body = off + 8
    if (id === 'fmt ') {
      const format = buf.readUInt16LE(body)
      fmt = {
        format,
        channels: buf.readUInt16LE(body + 2),
        sampleRate: buf.readUInt32LE(body + 4),
        bits: buf.readUInt16LE(body + 14),
      }
    } else if (id === 'data') {
      data = buf.subarray(body, Math.min(body + size, buf.length))
    }
    off = body + size + (size % 2)
  }
  if (!fmt || !data) throw new Error('bad wav: missing fmt or data chunk')
  const { channels, sampleRate, bits, format } = fmt
  const frames = Math.floor(data.length / ((bits / 8) * channels))
  const out = new Float32Array(frames)
  const isFloat = format === 3 || bits === 32
  for (let i = 0; i < frames; i++) {
    let acc = 0
    for (let c = 0; c < channels; c++) {
      const o = (i * channels + c) * (bits / 8)
      if (bits === 16) acc += data.readInt16LE(o) / 32768
      else if (bits === 32 && isFloat) acc += data.readFloatLE(o)
      else if (bits === 32) acc += data.readInt32LE(o) / 2147483648
      else if (bits === 8) acc += data[o] / 128 - 1
      else throw new Error(`unsupported wav bit depth: ${bits}`)
    }
    out[i] = acc / channels
  }
  return { samples: out, sampleRate, channels, bits }
}

/** Longest single clip we will hold in memory (30 min at 16 kHz ≈ 29 M samples). */
export const MAX_SAMPLES = TARGET_RATE * 60 * 30

/**
 * Cheap linear resampler; speech ASR tolerates it and it avoids a dependency.
 * The guards are not paranoia: a bogus sample rate (0, 1, a string) used to
 * multiply the buffer by 16000 and try to allocate tens of GB.
 */
export function resample(samples, from, to = TARGET_RATE) {
  const fromRate = Number(from)
  const toRate = Number(to)
  if (!Number.isFinite(fromRate) || !Number.isFinite(toRate) || fromRate < 1000 || toRate < 1000 || fromRate > 384000 || toRate > 384000) {
    throw new Error(`resample: 采样率不合理（from=${from}, to=${to}）`)
  }
  if (fromRate === toRate) return samples
  const ratio = fromRate / toRate
  const n = Math.max(1, Math.floor(samples.length / ratio))
  if (!Number.isFinite(n) || n > MAX_SAMPLES) {
    throw new Error(`resample: 结果过长（${n} 个采样点，上限 ${MAX_SAMPLES}）`)
  }
  const out = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    const x = i * ratio
    const i0 = Math.floor(x)
    const i1 = Math.min(i0 + 1, samples.length - 1)
    const t = x - i0
    out[i] = samples[i0] * (1 - t) + samples[i1] * t
  }
  return out
}

/** Encode 16 kHz mono Float32 samples as a PCM16 wav buffer (for cloud upload). */
export function encodeWav16k(samples, sampleRate = TARGET_RATE) {
  const dataSize = samples.length * 2
  const buf = Buffer.alloc(44 + dataSize)
  buf.write('RIFF', 0, 'ascii')
  buf.writeUInt32LE(36 + dataSize, 4)
  buf.write('WAVE', 8, 'ascii')
  buf.write('fmt ', 12, 'ascii')
  buf.writeUInt32LE(16, 16)
  buf.writeUInt16LE(1, 20)
  buf.writeUInt16LE(1, 22)
  buf.writeUInt32LE(sampleRate, 24)
  buf.writeUInt32LE(sampleRate * 2, 28)
  buf.writeUInt16LE(2, 32)
  buf.writeUInt16LE(16, 34)
  buf.write('data', 36, 'ascii')
  buf.writeUInt32LE(dataSize, 40)
  for (let i = 0; i < samples.length; i++) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    buf.writeInt16LE(Math.round(clamped * 32767), 44 + i * 2)
  }
  return buf
}

/** Duration in seconds of a wav buffer, or null when the header is unusable. */
export function wavDuration(buf) {
  try {
    const wav = decodeWav(buf)
    return wav.samples.length / wav.sampleRate
  } catch {
    return null
  }
}

/** Resolve an ffmpeg executable: configured path, PATH, then the common WinGet install. */
export function resolveFfmpeg(configured) {
  if (configured && fs.existsSync(configured)) return configured
  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg'
  const fromPath = process.env.PATH?.split(path.delimiter).map((dir) => path.join(dir, exe)) ?? []
  for (const candidate of fromPath) {
    try {
      if (candidate && fs.existsSync(candidate)) return candidate
    } catch {
      /* ignore */
    }
  }
  const wingetRoot = path.join(process.env.LOCALAPPDATA ?? '', 'Microsoft', 'WinGet', 'Packages')
  try {
    for (const entry of fs.readdirSync(wingetRoot)) {
      if (!entry.toLowerCase().startsWith('gyan.ffmpeg')) continue
      const dir = path.join(wingetRoot, entry)
      for (const sub of fs.readdirSync(dir)) {
        const candidate = path.join(dir, sub, 'bin', exe)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  } catch {
    /* ignore */
  }
  return null
}

function run(cmd, args, { timeoutMs = 180_000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true })
    let stderr = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error(`${path.basename(cmd)} timed out after ${timeoutMs}ms`))
    }, timeoutMs)
    child.stderr?.on('data', (d) => {
      stderr += d.toString()
      if (stderr.length > 8000) stderr = stderr.slice(-8000)
    })
    child.on('error', (err) => {
      clearTimeout(timer)
      reject(err)
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      if (code === 0) resolve()
      else reject(new Error(`${path.basename(cmd)} exited ${code}: ${stderr.trim().split('\n').slice(-3).join(' | ')}`))
    })
  })
}

/** Transcode any ffmpeg-readable input into a 16 kHz mono wav file. */
export async function toWav16k(inputPath, { ffmpegPath } = {}) {
  const ffmpeg = resolveFfmpeg(ffmpegPath)
  if (!ffmpeg) throw new Error('ffmpeg not found: set the ffmpeg path in Little Ears settings or install ffmpeg')
  const out = path.join(os.tmpdir(), `little-ears-${process.pid}-${Date.now()}.wav`)
  await run(ffmpeg, ['-hide_banner', '-loglevel', 'error', '-y', '-i', inputPath, '-vn', '-ac', '1', '-ar', String(TARGET_RATE), '-f', 'wav', out])
  return out
}

/** Read any audio file into 16 kHz mono samples. */
export async function loadSamples(inputPath, opts = {}) {
  if (inputPath.toLowerCase().endsWith('.wav')) {
    const buf = fs.readFileSync(inputPath)
    try {
      const wav = decodeWav(buf)
      return { samples: resample(wav.samples, wav.sampleRate), sampleRate: TARGET_RATE }
    } catch {
      /* fall through to ffmpeg for exotic wav layouts */
    }
  }
  const wavPath = await toWav16k(inputPath, opts)
  try {
    const wav = decodeWav(fs.readFileSync(wavPath))
    return { samples: wav.samples, sampleRate: wav.sampleRate }
  } finally {
    fs.rm(wavPath, { force: true }, () => {})
  }
}
