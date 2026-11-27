// Daily cloud quota bookkeeping. One small JSON file, seven days retained.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

const KEEP_DAYS = 7

function todayKey() {
  const now = new Date()
  const local = new Date(now.getTime() - now.getTimezoneOffset() * 60_000)
  return local.toISOString().slice(0, 10)
}

export class Quota {
  constructor({ file, enabled = false, dailyCalls = 20, dailySeconds = 300, onExceed = 'local' }) {
    this.file = file
    this.enabled = enabled
    this.dailyCalls = Math.max(0, Number(dailyCalls) || 0)
    this.dailySeconds = Math.max(0, Number(dailySeconds) || 0)
    this.onExceed = onExceed === 'reject' ? 'reject' : 'local'
    this.data = this.#read()
  }

  #read() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'))
      if (raw && typeof raw === 'object' && raw.days && typeof raw.days === 'object') return raw
    } catch {
      /* first run */
    }
    return { days: {} }
  }

  async #write() {
    const cutoff = Date.now() - KEEP_DAYS * 86_400_000
    for (const [day, value] of Object.entries(this.data.days)) {
      const ts = Date.parse(`${day}T00:00:00`)
      if (Number.isFinite(ts) && ts < cutoff) delete this.data.days[day]
    }
    await fsp.mkdir(path.dirname(this.file), { recursive: true })
    await fsp.writeFile(this.file, JSON.stringify(this.data, null, 2), 'utf8')
  }

  today() {
    const key = todayKey()
    const entry = this.data.days[key] ?? { calls: 0, seconds: 0 }
    return {
      day: key,
      calls: entry.calls ?? 0,
      seconds: entry.seconds ?? 0,
      tokens: entry.tokens ?? 0,
      inTokens: entry.inTokens ?? 0,
      outTokens: entry.outTokens ?? 0,
      audioTokens: entry.audioTokens ?? 0,
    }
  }

  /** Decide whether the next cloud call may spend `seconds` of audio. */
  check(seconds) {
    if (!this.enabled) return { ok: true, unlimited: true }
    const { calls, seconds: used } = this.today()
    if (this.dailyCalls > 0 && calls >= this.dailyCalls) {
      return { ok: false, reason: `今天云端已经用了 ${calls}/${this.dailyCalls} 次`, onExceed: this.onExceed }
    }
    if (this.dailySeconds > 0 && used + seconds > this.dailySeconds) {
      return { ok: false, reason: `今天云端已用 ${Math.round(used)}/${this.dailySeconds} 秒，这段要 ${Math.round(seconds)} 秒`, onExceed: this.onExceed }
    }
    return { ok: true }
  }

  /** Drop every recorded day; used by the settings page reset button. */
  async reset() {
    this.data = { days: {} }
    await this.#write().catch(() => {})
  }

  /**
   * Record one cloud call: `seconds` of audio plus the token usage the provider
   * reported (方舟 / OpenAI 都给 usage；没给就只记次数和秒数).
   */
  async spend(seconds, usage = null) {
    if (!this.enabled) return
    const key = todayKey()
    const entry = this.data.days[key] ?? { calls: 0, seconds: 0 }
    entry.calls = (entry.calls ?? 0) + 1
    entry.seconds = Math.round((entry.seconds ?? 0) + Math.max(0, seconds))
    if (usage && typeof usage === 'object') {
      const total = Number(usage.total) || (Number(usage.input) || 0) + (Number(usage.output) || 0)
      entry.tokens = (entry.tokens ?? 0) + total
      entry.inTokens = (entry.inTokens ?? 0) + (Number(usage.input) || 0)
      entry.outTokens = (entry.outTokens ?? 0) + (Number(usage.output) || 0)
      entry.audioTokens = (entry.audioTokens ?? 0) + (Number(usage.audio) || 0)
    }
    this.data.days[key] = entry
    await this.#write().catch(() => {})
  }

  status() {
    const { day, calls, seconds, tokens, inTokens, outTokens, audioTokens } = this.today()
    return {
      enabled: this.enabled,
      day,
      calls,
      callLimit: this.dailyCalls,
      seconds: Math.round(seconds),
      secondLimit: this.dailySeconds,
      tokens,
      inTokens,
      outTokens,
      audioTokens,
      onExceed: this.onExceed,
    }
  }
}
