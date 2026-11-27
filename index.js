// dsh-fish-ears: local-first speech transcription for DSH.
//
// Three ways in: the `ears_transcribe` tool, a local HTTP service (for the
// SurfCore bridge and any OpenAI-compatible client), and an optional cloud
// omni fallback for audio the local model cannot carry.

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import z from '@deepseek-ai/schemastery'

import { LocalEngine } from './lib/local.js'
import { defaultModelRoot, ensureModel, hasModel, modelSize, TIERS } from './lib/models.js'
import { cloudConfigured, cloudTranscribe, cloudUnderstand, TRANSCRIBE_PROMPT } from './lib/cloud.js'
import { decodeWav, encodeWav16k, loadSamples, resample, resolveFfmpeg } from './lib/audio.js'
import { downloadAudio, looksLikeBili, resolveCookie } from './lib/bili.js'
import { Quota } from './lib/quota.js'
import { applyCorrections, parseCorrections } from './lib/postprocess.js'
import { startServer } from './lib/server.js'

export const inject = ['tools', 'webServer']

export const Config = z.object({
  mode: z
    .union(['auto', 'local', 'cloud'])
    .default('auto')
    .description('引擎模式：auto 本地优先、云端兜底；local 只用本地；cloud 只用云端'),
  tier: z.union(['low', 'mid', 'high']).default('mid').description('本地模型强度：low 82MB / mid SenseVoice 228MB（带标点、能听情绪）/ high 232MB'),
  modelDir: z.string().default('').description('模型目录，留空使用 ~/.dsh/fish-ears/models'),
  autoDownload: z.boolean().default(true).description('缺模型时自动下载（关掉则只用心已装好的模型与云端）'),
  ffmpegPath: z.string().default('').description('ffmpeg 路径，留空自动查找 PATH 与 WinGet 安装'),
  serverEnabled: z.boolean().default(true).description('开启本机 HTTP 服务（桥接和其它插件用）'),
  serverPort: z.number().default(8771).description('本机 HTTP 服务端口'),
  cloudBaseUrl: z
    .string()
    .default('')
    .description('云端 Base URL，例如 https://dashscope.aliyuncs.com/compatible-mode/v1'),
  cloudApiKey: z.string().default('').description('云端 API Key'),
  cloudModel: z.string().default('').description('云端模型名，例如 qwen3.8-omni-flash / doubao-seed-1-6-flash-250928'),
  cloudAllowUpload: z.boolean().default(false).description('允许把音频上传到云端（关掉则完全不联网）'),
  cloudOnUnderstand: z.boolean().default(true).description('需要理解语气、情绪、评价时交给云端'),
  cloudLongAudioSec: z.number().default(120).description('超过多少秒的音频交给云端'),
  cloudMinChars: z.number().default(2).description('本地结果少于多少字时改问云端'),
  cloudFallbackLocal: z.boolean().default(true).description('云端失败时退回本地'),
  cloudFast: z
    .boolean()
    .default(true)
    .description('方舟低延迟队列（service_tier=fast）：同样质量下快约 40%，需在控制台开通 fast 模式'),
  cloudThink: z
    .boolean()
    .default(false)
    .description('理解时让模型先思考：说得更细，但慢 4–5 倍'),
  biliCookie: z.string().default('').description('B站 Cookie，留空自动读取 SurfCore 的凭据'),
  corrections: z
    .string()
    .default('本鲸=本亲|本金|本京|本惊|本君')
    .description('同音字修正：写「正确的=听错的」，多个错法用 | 隔开，多条用分号，例如 本鲸=本亲|本金|本京'),
  quotaEnabled: z.boolean().default(false).description('开启云端额度管理'),
  quotaDailyCalls: z.number().default(20).description('每天云端调用上限（0 表示不限）'),
  quotaDailySeconds: z.number().default(300).description('每天云端音频秒数上限（0 表示不限）'),
  quotaOnExceed: z.union(['local', 'reject']).default('local').description('额度用尽后：local 降级本地，reject 直接拒绝'),
})

const stringOutput = {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: value }],
}

const DEFAULT_UNDERSTAND_PROMPT =
  '用中文说说这段音频：先一句说说了什么，再一句说怎么说的（语气、情绪、有没有笑或叹气）。两到三句，不要逐字复述，只给情绪标签不算回答。'

function expandHome(value) {
  const text = String(value ?? '').trim()
  if (!text) return ''
  return text.startsWith('~') ? path.join(os.homedir(), text.slice(1)) : text
}

async function downloadUrl(url) {
  const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(180_000) })
  if (!res.ok || !res.body) throw new Error(`下载音频失败 ${res.status}`)
  const guess = (() => {
    try {
      const ext = path.extname(new URL(url).pathname)
      return ext && ext.length <= 5 ? ext : '.bin'
    } catch {
      return '.bin'
    }
  })()
  const file = path.join(os.tmpdir(), `fish-ears-url-${process.pid}-${Date.now()}${guess}`)
  const handle = await fsp.open(file, 'w')
  try {
    for await (const chunk of res.body) await handle.write(chunk)
  } finally {
    await handle.close()
  }
  return file
}

export function apply(ctx, config) {
  const cfgFile = path.join(os.homedir(), '.dsh', 'fish-ears', 'config.json')
  const readCfgFile = () => {
    try {
      const raw = JSON.parse(fs.readFileSync(cfgFile, 'utf8'))
      return raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {}
    } catch {
      return {}
    }
  }
  // 代码里再写一份默认值：config.json 里缺字段时（老配置文件、测试、手改）也
  // 不会把 cloudMinChars 之类变成 undefined，避免静默关掉「本地听不出就交云端」这类补救。
  const FALLBACK_DEFAULTS = {
    mode: 'auto',
    tier: 'mid',
    modelDir: '',
    autoDownload: true,
    ffmpegPath: '',
    serverEnabled: true,
    serverPort: 8771,
    cloudBaseUrl: '',
    cloudApiKey: '',
    cloudModel: '',
    cloudAllowUpload: false,
    cloudOnUnderstand: true,
    cloudLongAudioSec: 120,
    cloudMinChars: 2,
    cloudFallbackLocal: true,
    cloudFast: true,
    cloudThink: false,
    biliCookie: '',
    corrections: '本鲸=本亲|本金|本京|本惊|本君',
    quotaEnabled: false,
    quotaDailyCalls: 20,
    quotaDailySeconds: 300,
    quotaOnExceed: 'local',
  }
  let cfg = { ...FALLBACK_DEFAULTS, ...config, ...readCfgFile() }

  function saveCfgFile() {
    try {
      fs.mkdirSync(path.dirname(cfgFile), { recursive: true })
      fs.writeFileSync(cfgFile, JSON.stringify(cfg, null, 2), 'utf8')
      return null
    } catch (error) {
      return String(error?.message ?? error)
    }
  }

  const log = (message) => {
    try {
      if (ctx.logger?.info) ctx.logger.info(`[fish-ears] ${message}`)
      else console.log(`[fish-ears] ${message}`)
    } catch {
      /* logging must never break transcription */
    }
  }

  const stateDir = path.join(os.homedir(), '.dsh', 'fish-ears')
  let modelRoot = expandHome(cfg.modelDir) || defaultModelRoot()
  const quota = new Quota({
    file: path.join(stateDir, 'quota.json'),
    enabled: cfg.quotaEnabled === true,
    dailyCalls: cfg.quotaDailyCalls,
    dailySeconds: cfg.quotaDailySeconds,
    onExceed: cfg.quotaOnExceed,
  })
  const engine = new LocalEngine({ root: modelRoot, tier: cfg.tier, log })
  let correctionPairs = parseCorrections(cfg.corrections)
  const fix = (text) => applyCorrections(text, correctionPairs)

  /**
   * Apply a new settings object in place: the settings page writes through this
   * so most options take effect without restarting DSH. Fields that own a
   * listening socket (serverEnabled/serverPort) still need a restart.
   */
  function applyConfig(next) {
    const prevTier = cfg.tier
    const prevDir = cfg.modelDir
    cfg = next
    quota.enabled = cfg.quotaEnabled === true
    quota.dailyCalls = Math.max(0, Number(cfg.quotaDailyCalls) || 0)
    quota.dailySeconds = Math.max(0, Number(cfg.quotaDailySeconds) || 0)
    quota.onExceed = cfg.quotaOnExceed === 'reject' ? 'reject' : 'local'
    correctionPairs = parseCorrections(cfg.corrections)
    if (prevDir !== cfg.modelDir) modelRoot = expandHome(cfg.modelDir) || defaultModelRoot()
    engine.tier = cfg.tier
    engine.root = modelRoot
    if (prevTier !== cfg.tier || prevDir !== cfg.modelDir) engine.dispose()
  }

  async function ensureLocal() {
    const resolved = await ensureModel({
      root: modelRoot,
      tierId: cfg.tier,
      allowDownload: cfg.autoDownload !== false,
      log,
    })
    if (!resolved.ok) return null
    engine.tier = cfg.tier
    engine.load({ model: resolved.model, tokens: resolved.tokens })
    return resolved
  }

  function localStatus() {
    return {
      tier: cfg.tier,
      label: TIERS[cfg.tier]?.label ?? cfg.tier,
      ready: hasModel(modelRoot, cfg.tier),
      dir: path.join(modelRoot, cfg.tier),
      sizeMB: Math.round(modelSize(modelRoot, cfg.tier) / 1048576),
      loaded: Boolean(engine.recognizer),
      loadMs: engine.loadMs,
    }
  }

  function status() {
    return {
      plugin: 'dsh-fish-ears',
      mode: cfg.mode,
      local: localStatus(),
      cloud: {
        configured: cloudConfigured(cfg),
        model: cfg.cloudModel || '',
        baseUrl: cfg.cloudBaseUrl || '',
        allowUpload: cfg.cloudAllowUpload === true,
      },
      quota: quota.status(),
      ffmpeg: resolveFfmpeg(expandHome(cfg.ffmpegPath)) ?? null,
      server: { enabled: cfg.serverEnabled !== false, port: cfg.serverPort },
      modelRoot,
    }
  }

  function cloudReady() {
    return cloudConfigured(cfg) && cfg.cloudAllowUpload === true
  }

  async function runLocal(samples) {
    const model = await ensureLocal()
    if (!model) {
      throw new Error('本地模型还没装好，而且自动下载是关的：可以在设置里打开自动下载，或改用云端模式')
    }
    const result = engine.transcribe(samples)
    return { text: fix(result.text), engine: `local:${cfg.tier}`, lang: result.lang, emotion: result.emotion, event: result.event, localMs: result.ms }
  }

  async function runCloud(wav, { need, prompt, dur }) {
    const base = {
      baseUrl: cfg.cloudBaseUrl,
      apiKey: cfg.cloudApiKey,
      model: cfg.cloudModel,
      fast: cfg.cloudFast !== false,
    }
    if (need === 'understand') {
      const out = await cloudUnderstand({ ...base, wav, prompt: prompt || DEFAULT_UNDERSTAND_PROMPT, thinking: cfg.cloudThink === true })
      return { text: fix(out.text), engine: `cloud:${cfg.cloudModel}`, understanding: true, usage: out.usage }
    }
    const out = await cloudTranscribe({ ...base, wav })
    return { text: fix(out.text), engine: `cloud:${cfg.cloudModel}`, usage: out.usage }
  }

  /**
   * Route one piece of audio: local engine, cloud omni, or local then cloud.
   * `need` is 'text' for a plain transcript and 'understand' when the caller
   * wants meaning/tone rather than words.
   */
  async function transcribeSamples(samples, { need = 'text', prompt } = {}) {
    const started = Date.now()
    const dur = samples.length / 16000
    const mode = cfg.mode
    const cloud = cloudReady()
    const localPossible = mode !== 'cloud' && (hasModel(modelRoot, cfg.tier) || cfg.autoDownload !== false)

    let route = 'local'
    if (mode === 'cloud') route = 'cloud'
    else if (!localPossible && cloud) route = 'cloud'
    else if (need === 'understand' && cloud && cfg.cloudOnUnderstand !== false) route = 'cloud'
    else if (cloud && dur > Math.max(10, Number(cfg.cloudLongAudioSec) || 120)) route = 'cloud'

    if (route === 'cloud' && !cloud) {
      throw new Error(
        mode === 'cloud'
          ? '当前是「只用云端」模式，但云端 Base URL、API Key 或模型名还没填全（设置里填好，并打开「允许上传音频」）'
          : '本地模型用不了，云端也没配好：先在设置里填云端地址和 Key',
      )
    }

    if (route === 'cloud') {
      const spend = quota.check(dur)
      if (!spend.ok) {
        if (spend.onExceed === 'reject') throw new Error(`${spend.reason}；额度策略是直接拒绝`)
        log(`云端额度用尽，改走本地：${spend.reason}`)
        route = 'local'
      }
    }

    const wav = encodeWav16k(samples)

    if (route === 'cloud') {
      try {
        const out = await runCloud(wav, { need, prompt, dur })
        await quota.spend(dur, out.usage)
        return { ...out, dur, ms: Date.now() - started, route: 'cloud' }
      } catch (error) {
        if (cfg.cloudFallbackLocal === false) throw error
        log(`云端失败，回退本地：${error?.message ?? error}`)
        const out = await runLocal(samples)
        return { ...out, dur, ms: Date.now() - started, route: 'local', cloudError: String(error?.message ?? error) }
      }
    }

    const out = await runLocal(samples)
    const minChars = Math.max(0, Number(cfg.cloudMinChars) || 0)
    if (process.env.FISH_EARS_DEBUG) {
      log(`[debug] rescue? cloud=${cloud} onUnderstand=${cfg.cloudOnUnderstand} mode=${mode} len=${String(out.text ?? '').length} minChars=${minChars} quota=${JSON.stringify(quota.check(dur))}`)
    }
    if (cloud && cfg.cloudOnUnderstand !== false && mode !== 'local' && String(out.text ?? '').length < Math.max(1, minChars)) {
      const spend = quota.check(dur)
      if (spend.ok) {
        try {
          const cloudOut = await runCloud(wav, { need: 'text', dur })
          if (String(cloudOut.text ?? '').trim()) {
            await quota.spend(dur, cloudOut.usage)
            return { ...cloudOut, dur, ms: Date.now() - started, route: 'cloud', localText: out.text }
          }
        } catch (error) {
          log(`本地结果太短、云端补救失败：${error?.message ?? error}`)
        }
      }
    }
    return { ...out, dur, ms: Date.now() - started, route: 'local' }
  }

  /** Accept a local file, a Bilibili video, or a direct audio URL. */
  async function transcribeSource(source, opts = {}) {
    const src = String(source ?? '').trim()
    if (!src) throw new Error('source 不能为空：给本地音频路径、BV 号或音频链接')
    let file = src
    let video
    let temp = false
    if (looksLikeBili(src)) {
      const cookie = resolveCookie(cfg.biliCookie)
      const got = await downloadAudio(src, { cookie, log })
      file = got.file
      video = got.video
      temp = true
    } else if (/^https?:\/\//i.test(src)) {
      file = await downloadUrl(src)
      temp = true
    } else {
      file = expandHome(src)
      if (!fs.existsSync(file)) throw new Error(`找不到音频文件：${file}`)
    }
    try {
      const { samples } = await loadSamples(file, { ffmpegPath: expandHome(cfg.ffmpegPath) })
      const result = await transcribeSamples(samples, opts)
      return { ...result, source: src, video }
    } finally {
      if (temp) fs.rm(file, { force: true }, () => {})
    }
  }

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'ears_transcribe',
        description:
          '把一段音频听成文字。source 可以是本地音频文件路径、B站视频（BV 号 / 链接 / b23 短链，自动抓音轨），或音频直链。' +
          '默认只转写；need="understand" 时交给云端多模态模型，回答「怎么说的、什么情绪、值不值得看」这类需要理解的问题。' +
          'need 时若能配 prompt 描述你真正想知道什么。',
        parameters: {
          type: 'object',
          properties: {
            source: { type: 'string', description: '本地音频路径 / BV 号 / B站链接 / 音频直链' },
            need: { type: 'string', enum: ['text', 'understand'], description: 'text 只要文字；understand 要理解语气与含义' },
            prompt: { type: 'string', description: 'need=understand 时的具体问题' },
          },
          required: ['source'],
          additionalProperties: false,
        },
        output: stringOutput,
        execute: async (args) => {
          const result = await transcribeSource(args.source, {
            need: args.need === 'understand' ? 'understand' : 'text',
            prompt: args.prompt,
          })
          return JSON.stringify(result)
        },
      }),
    'fish-ears: transcribe tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'ears_status',
        description: '看小耳朵的现状：本地模型装没装、加载了没有、云端配没配、今天云端用了多少额度、HTTP 服务端口。',
        parameters: { type: 'object', properties: {}, additionalProperties: false },
        output: stringOutput,
        execute: async () => JSON.stringify(status()),
      }),
    'fish-ears: status tool',
  )

  ctx.effect(
    () =>
      ctx.tools.register({
        name: 'ears_model',
        description:
          '管理本地 ASR 模型：action="status" 看各档位是否已下载，action="download" 下载指定档位（low 82MB / mid SenseVoice 228MB / high 232MB），action="use" 切换当前档位。',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['status', 'download', 'use'] },
            tier: { type: 'string', enum: ['low', 'mid', 'high'] },
          },
          required: ['action'],
          additionalProperties: false,
        },
        output: stringOutput,
        execute: async (args) => {
          if (args.action === 'status') {
            const tiers = Object.values(TIERS).map((spec) => ({
              tier: spec.id,
              label: spec.label,
              approximateSize: spec.approximateSize,
              ready: hasModel(modelRoot, spec.id),
              sizeMB: Math.round(modelSize(modelRoot, spec.id) / 1048576),
            }))
            return JSON.stringify({ ok: true, modelRoot, current: cfg.tier, tiers })
          }
          const tier = args.tier || cfg.tier
          if (!TIERS[tier]) throw new Error(`未知档位：${tier}`)
          if (args.action === 'download') {
            const resolved = await ensureModel({ root: modelRoot, tierId: tier, allowDownload: true, log })
            return JSON.stringify({ ok: resolved.ok, tier, dir: resolved.dir, downloaded: resolved.downloaded, seeded: resolved.seeded === true })
          }
          return JSON.stringify({ ok: true, note: '切换档位请到设置页改「本地模型强度」；这里只报告当前值', current: cfg.tier, requested: tier })
        },
      }),
    'fish-ears: model tool',
  )

  // ---- 设置页接口：/api/fish-ears/* ----
  const WRITABLE = {
    mode: 'string',
    tier: 'string',
    modelDir: 'string',
    autoDownload: 'boolean',
    ffmpegPath: 'string',
    serverEnabled: 'boolean',
    serverPort: 'number',
    cloudBaseUrl: 'string',
    cloudApiKey: 'string',
    cloudModel: 'string',
    cloudAllowUpload: 'boolean',
    cloudOnUnderstand: 'boolean',
    cloudLongAudioSec: 'number',
    cloudMinChars: 'number',
    cloudFallbackLocal: 'boolean',
    cloudFast: 'boolean',
    cloudThink: 'boolean',
    biliCookie: 'string',
    corrections: 'string',
    quotaEnabled: 'boolean',
    quotaDailyCalls: 'number',
    quotaDailySeconds: 'number',
    quotaOnExceed: 'string',
  }
  const SECRET_KEYS = new Set(['cloudApiKey'])
  const maskCfg = () => {
    const out = { ...cfg }
    for (const key of SECRET_KEYS) {
      const value = String(out[key] ?? '')
      out[key] = value ? `${value.slice(0, 4)}****${value.slice(-3)}` : ''
      out[`${key}Set`] = Boolean(value)
    }
    return out
  }
  const sendJson = (res, code, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    res.end(body)
  }
  const readBody = (req) =>
    new Promise((resolve, reject) => {
      let size = 0
      const chunks = []
      req.on('data', (chunk) => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) {
          reject(new Error('请求体太大'))
          req.destroy()
          return
        }
        chunks.push(chunk)
      })
      req.on('end', () => {
        try {
          const text = Buffer.concat(chunks).toString('utf8').trim()
          resolve(text ? JSON.parse(text) : {})
        } catch (error) {
          reject(new Error(`请求体不是合法 JSON：${error?.message ?? error}`))
        }
      })
      req.on('error', reject)
    })
  const sameOrigin = (req) => {
    const origin = req.headers.origin
    if (!origin) return true
    try {
      const { hostname } = new URL(origin)
      return hostname === '127.0.0.1' || hostname === 'localhost' || hostname === '::1'
    } catch {
      return false
    }
  }

  async function handleApi(req, res) {
    const url = new URL(req.url, 'http://127.0.0.1')
    const route = url.pathname.replace(/^\/api\/fish-ears/, '').replace(/\/+$/, '') || '/'

    if (req.method === 'GET' && route === '/status') {
      return sendJson(res, 200, { ok: true, ...status(), config: maskCfg() })
    }
    if (req.method === 'GET' && route === '/config') {
      return sendJson(res, 200, { ok: true, config: maskCfg() })
    }
    if (req.method === 'POST' && route === '/config') {
      const body = await readBody(req)
      const next = { ...cfg }
      const changed = []
      for (const [key, kind] of Object.entries(WRITABLE)) {
        if (!(key in body)) continue
        const raw = body[key]
        if (kind === 'boolean') next[key] = raw === true || raw === 'true'
        else if (kind === 'number') {
          const num = Number(raw)
          if (!Number.isFinite(num)) throw new Error(`${key} 需要是数字`)
          next[key] = Math.round(num)
        } else next[key] = typeof raw === 'string' ? raw.trim() : String(raw ?? '')
        changed.push(key)
      }
      if (!TIERS[next.tier]) next.tier = cfg.tier
      if (!['auto', 'local', 'cloud'].includes(next.mode)) next.mode = cfg.mode
      if (!['local', 'reject'].includes(next.quotaOnExceed)) next.quotaOnExceed = cfg.quotaOnExceed
      const port = Number(next.serverPort) || 8771
      next.serverPort = Math.min(65535, Math.max(1024, port))
      applyConfig(next)
      const writeError = saveCfgFile()
      const restartRequired = ['serverEnabled', 'serverPort'].some((key) => changed.includes(key))
        ? ['改了本机服务端口或开关，重启 DSH 之后才会生效']
        : []
      return sendJson(res, 200, {
        ok: !writeError,
        message: writeError ? `配置已生效但没写进文件：${writeError}` : '已保存',
        changed,
        restartRequired,
        config: maskCfg(),
        status: status(),
      })
    }
    if (req.method === 'GET' && route === '/models') {
      const tiers = Object.values(TIERS).map((spec) => ({
        tier: spec.id,
        label: spec.label,
        approximateSize: spec.approximateSize,
        ready: hasModel(modelRoot, spec.id),
        sizeMB: Math.round(modelSize(modelRoot, spec.id) / 1048576),
      }))
      return sendJson(res, 200, { ok: true, root: modelRoot, current: cfg.tier, tiers })
    }
    if (req.method === 'POST' && route === '/models') {
      const body = await readBody(req)
      const tier = body.tier || cfg.tier
      if (!TIERS[tier]) throw new Error(`未知档位：${tier}`)
      const resolved = await ensureModel({ root: modelRoot, tierId: tier, allowDownload: true, log })
      return sendJson(res, 200, {
        ok: resolved.ok,
        tier,
        dir: resolved.dir,
        downloaded: resolved.downloaded,
        seeded: resolved.seeded === true,
        sizeMB: Math.round(modelSize(modelRoot, tier) / 1048576),
        current: cfg.tier,
      })
    }
    if (req.method === 'POST' && route === '/test') {
      const body = await readBody(req)
      const started = Date.now()
      const result = await transcribeSource(body.source, {
        need: body.need === 'understand' ? 'understand' : 'text',
        prompt: body.prompt,
      })
      return sendJson(res, 200, { ok: true, elapsedMs: Date.now() - started, result })
    }
    if (req.method === 'POST' && route === '/quota/reset') {
      await quota.reset()
      return sendJson(res, 200, { ok: true, quota: quota.status() })
    }
    return sendJson(res, 404, { ok: false, message: `没有这个接口：${route}` })
  }

  try {
    ctx.effect(
      () =>
        ctx.webServer.register({
          kind: 'prefix',
          path: '/api/fish-ears',
          handler: async (req, res) => {
            if (!sameOrigin(req)) return sendJson(res, 403, { ok: false, message: '只接受本机同源请求' })
            try {
              await handleApi(req, res)
            } catch (error) {
              sendJson(res, 500, { ok: false, message: String(error?.message ?? error) })
            }
          },
        }),
      'fish-ears: /api/fish-ears 路由',
    )
  } catch (error) {
    log(`设置页接口没挂上：${error?.message ?? error}`)
  }

  if (cfg.serverEnabled !== false) {
    ctx.effect(() => {
      let disposed = false
      let handle
      startServer({
        host: '127.0.0.1',
        port: Number(cfg.serverPort) || 8771,
        log,
        handlers: {
          status,
          transcribeSource,
          transcribeWav: async (wavBuf, { need = 'text', prompt } = {}) => {
            const wav = decodeWav(wavBuf)
            const samples = resample(wav.samples, wav.sampleRate)
            const result = await transcribeSamples(samples, { need, prompt })
            return { text: result.text, engine: result.engine, dur: result.dur, ms: result.ms, route: result.route }
          },
        },
      })
        .then((server) => {
          if (disposed) {
            server.close()
            return
          }
          handle = server
          log(`HTTP 服务已启动 http://127.0.0.1:${server.port}`)
        })
        .catch((error) => log(`HTTP 服务启动失败（端口 ${cfg.serverPort}）：${error?.message ?? error}`))
      return () => {
        disposed = true
        handle?.close()
        engine.dispose()
      }
    }, 'fish-ears: http server')
  } else {
    ctx.effect(() => () => engine.dispose(), 'fish-ears: engine cleanup')
  }

  log(`已就绪：模式 ${cfg.mode}，本地 ${TIERS[cfg.tier]?.label ?? cfg.tier}${hasModel(modelRoot, cfg.tier) ? '（已安装）' : '（未安装）'}，云端 ${cloudConfigured(cfg) ? '已配置' : '未配置'}`)
}
