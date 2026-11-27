// Cloud fallback: any OpenAI-compatible endpoint that accepts audio.
// Two calls are supported:
//   - POST {base}/audio/transcriptions  -> plain transcription
//   - POST {base}/chat/completions      -> omni understanding (input_audio)

function normalizeBase(baseUrl) {
  const trimmed = String(baseUrl ?? '').trim().replace(/\/+$/, '')
  if (!trimmed) return ''
  if (/\/v\d+$/.test(trimmed)) return trimmed
  if (/compatible-mode$/.test(trimmed)) return `${trimmed}/v1`
  return trimmed.endsWith('/v1') ? trimmed : `${trimmed}/v1`
}

export function cloudConfigured(cfg) {
  return Boolean(normalizeBase(cfg?.cloudBaseUrl) && cfg?.cloudApiKey && cfg?.cloudModel)
}

/** Volcengine Ark (方舟) serves audio through the Responses API, not chat/completions. */
export function isArkBase(baseUrl) {
  const base = normalizeBase(baseUrl)
  return /volces\.com|bytepluses\.com|^https?:\/\/ark\./i.test(base)
}

function authHeaders(apiKey) {
  return { authorization: `Bearer ${apiKey}` }
}

async function postJson(url, apiKey, body, timeoutMs) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...authHeaders(apiKey) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  if (!res.ok) {
    const detail = json?.error?.message ?? json?.message ?? text.slice(0, 300)
    throw new Error(`云端返回 ${res.status}: ${detail}`)
  }
  return json
}

/**
 * Volcengine Ark (方舟) Responses API: audio goes in as `input_audio.audio_url`
 * with a `data:` URI, so local files work without TOS upload or submit/query.
 */
async function arkRespond({ baseUrl, apiKey, model, wav, prompt, thinking, fast, timeoutMs }) {
  const base = normalizeBase(baseUrl)
  const dataUri = `data:audio/wav;base64,${Buffer.from(wav).toString('base64')}`
  const body = {
    model,
    input: [
      {
        role: 'user',
        content: [
          { type: 'input_audio', audio_url: dataUri },
          { type: 'input_text', text: prompt },
        ],
      },
    ],
  }
  // 低延迟队列：需在方舟控制台开通 fast 模式，实测同质量快 35–40%。
  if (fast) body.service_tier = 'fast'
  // 转写不需要思考链：关掉后 5s -> 1s，标点质量不受影响（实测）。
  if (thinking === false) body.thinking = { type: 'disabled' }
  else if (thinking === true) body.thinking = { type: 'enabled' }
  const json = await postJson(`${base}/responses`, apiKey, body, timeoutMs)
  const parts = []
  const walk = (items) => {
    for (const item of items ?? []) {
      if (typeof item === 'string') { parts.push(item); continue }
      if (Array.isArray(item?.content)) {
        for (const part of item.content) {
          if (typeof part === 'string') parts.push(part)
          else if (typeof part?.text === 'string') parts.push(part.text)
        }
      } else if (typeof item?.text === 'string') {
        parts.push(item.text)
      }
    }
  }
  walk(json?.output)
  if (!parts.length && typeof json?.output_text === 'string') parts.push(json.output_text)
  const out = parts.join('').trim()
  if (!out) throw new Error('方舟返回了空内容')
  return { text: out, usage: normalizeUsage(json?.usage) }
}

/**
 * Both Ark and OpenAI report spend under different key names; flatten them to
 * one shape so the quota book can add them up without caring which line it is.
 */
function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object') return null
  const input = Number(usage.input_tokens ?? usage.prompt_tokens ?? 0) || 0
  const output = Number(usage.output_tokens ?? usage.completion_tokens ?? 0) || 0
  const total = Number(usage.total_tokens ?? 0) || input + output
  const audio = Number(usage.input_tokens_details?.audio_tokens ?? usage.prompt_tokens_details?.audio_tokens ?? 0) || 0
  const cached = Number(usage.input_tokens_details?.cached_tokens ?? usage.prompt_tokens_details?.cached_tokens ?? 0) || 0
  return { input, output, total, audio, cached }
}

/** Plain transcription through an OpenAI-compatible /audio/transcriptions endpoint. */
export async function cloudTranscribe({ baseUrl, apiKey, model, wav, language, fast, timeoutMs = 120_000 }) {
  if (isArkBase(baseUrl)) {
    return arkRespond({ baseUrl, apiKey, model, wav, prompt: ARK_TRANSCRIBE_PROMPT, thinking: false, fast, timeoutMs })
  }
  const base = normalizeBase(baseUrl)
  const form = new FormData()
  form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav')
  form.append('model', model)
  form.append('response_format', 'json')
  if (language) form.append('language', language)
  const res = await fetch(`${base}/audio/transcriptions`, {
    method: 'POST',
    headers: authHeaders(apiKey),
    body: form,
    signal: AbortSignal.timeout(timeoutMs),
  })
  const text = await res.text()
  let json
  try {
    json = JSON.parse(text)
  } catch {
    json = undefined
  }
  if (!res.ok) {
    const detail = json?.error?.message ?? json?.message ?? text.slice(0, 300)
    throw new Error(`云端转写返回 ${res.status}: ${detail}`)
  }
  const out = String(json?.text ?? json?.result ?? text ?? '').trim()
  if (!out) throw new Error('云端转写返回了空内容')
  return { text: out, usage: normalizeUsage(json?.usage) }
}

/**
 * Omni understanding: send the audio plus a question to a chat model that
 * accepts `input_audio`. Used when the local model is not enough or when the
 * caller explicitly asks for understanding rather than transcription.
 */
export async function cloudUnderstand({ baseUrl, apiKey, model, wav, prompt, fast, thinking, timeoutMs = 180_000 }) {
  if (isArkBase(baseUrl)) {
    return arkRespond({ baseUrl, apiKey, model, wav, prompt, fast, thinking, timeoutMs })
  }
  const base = normalizeBase(baseUrl)
  const body = {
    model,
    temperature: 0.2,
    messages: [
      {
        role: 'user',
        content: [
          { type: 'text', text: prompt },
          {
            type: 'input_audio',
            input_audio: { data: Buffer.from(wav).toString('base64'), format: 'wav' },
          },
        ],
      },
    ],
  }
  const json = await postJson(`${base}/chat/completions`, apiKey, body, timeoutMs)
  const content = json?.choices?.[0]?.message?.content
  const out = typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (typeof part === 'string' ? part : part?.text ?? '')).join('')
      : ''
  if (!String(out).trim()) throw new Error('云端理解返回了空内容')
  return { text: String(out).trim(), usage: normalizeUsage(json?.usage) }
}

export const TRANSCRIBE_PROMPT =
  '把这段音频逐字转写成文字，只输出转写结果本身，不要加解释、不要加引号。'

export const ARK_TRANSCRIBE_PROMPT =
  '转写这段中文语音，保留口语，加标点，直接输出文字。'
