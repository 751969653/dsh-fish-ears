// Local HTTP surface so other processes (SurfCore bridge, dsh-better-ears,
// anything OpenAI-compatible) can use the same ears without plugin access.

import http from 'node:http'

const MAX_BODY = 64 * 1024 * 1024

function sendJson(res, code, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(code, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'access-control-allow-origin': '*',
  })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = []
    let size = 0
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY) {
        reject(new Error('请求体过大'))
        req.destroy()
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => resolve(Buffer.concat(chunks)))
    req.on('error', reject)
  })
}

/** Minimal multipart/form-data parser: enough for one `file` field. */
function parseMultipart(buf, contentType) {
  const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(contentType)
  const marker = boundary?.[1] ?? boundary?.[2]
  if (!marker) throw new Error('multipart 缺少 boundary')
  const delimiter = Buffer.from(`--${marker}`)
  const parts = []
  let index = buf.indexOf(delimiter)
  while (index !== -1) {
    const next = buf.indexOf(delimiter, index + delimiter.length)
    if (next === -1) break
    const chunk = buf.subarray(index + delimiter.length, next)
    const headerEnd = chunk.indexOf('\r\n\r\n')
    if (headerEnd !== -1) {
      const headerText = chunk.subarray(0, headerEnd).toString('utf8')
      let body = chunk.subarray(headerEnd + 4)
      if (body.subarray(-2).toString() === '\r\n') body = body.subarray(0, body.length - 2)
      const name = /name="([^"]*)"/i.exec(headerText)?.[1] ?? ''
      const filename = /filename="([^"]*)"/i.exec(headerText)?.[1] ?? ''
      parts.push({ name, filename, headerText, body })
    }
    index = next
  }
  return parts
}

/**
 * Start the ears HTTP server.
 * `handlers.transcribeWav(buffer, { need })` -> { text, engine, dur, ms }
 */
export function startServer({ host = '127.0.0.1', port = 8771, handlers, log } = {}) {
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`)
    try {
      if (req.method === 'GET' && (url.pathname === '/health' || url.pathname === '/')) {
        sendJson(res, 200, { ok: true, ...handlers.status() })
        return
      }
      if (req.method === 'POST' && url.pathname === '/asr') {
        const body = await readBody(req)
        const contentType = String(req.headers['content-type'] ?? '')
        let wav
        if (contentType.includes('application/json')) {
          const json = JSON.parse(body.toString('utf8') || '{}')
          if (json.wav_b64) wav = Buffer.from(json.wav_b64, 'base64')
          else if (json.wav_base64) wav = Buffer.from(json.wav_base64, 'base64')
          else throw new Error('JSON 里需要 wav_b64')
        } else {
          wav = body
        }
        if (!wav?.length) throw new Error('没有收到音频数据')
        const need = url.searchParams.get('need') === 'understand' ? 'understand' : 'text'
        const result = await handlers.transcribeWav(wav, { need, prompt: url.searchParams.get('prompt') ?? undefined })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      if (req.method === 'POST' && (url.pathname === '/v1/audio/transcriptions' || url.pathname === '/audio/transcriptions')) {
        const body = await readBody(req)
        const contentType = String(req.headers['content-type'] ?? '')
        let wav
        if (contentType.includes('multipart/form-data')) {
          const parts = parseMultipart(body, contentType)
          const file = parts.find((p) => p.name === 'file' || p.filename)
          if (!file) throw new Error('multipart 里没有 file 字段')
          wav = Buffer.from(file.body)
        } else if (contentType.includes('application/json')) {
          const json = JSON.parse(body.toString('utf8') || '{}')
          wav = Buffer.from(json.wav_b64 ?? '', 'base64')
        } else {
          wav = body
        }
        if (!wav?.length) throw new Error('没有收到音频数据')
        const result = await handlers.transcribeWav(wav, { need: 'text' })
        sendJson(res, 200, { text: result.text, engine: result.engine })
        return
      }
      // POST /bili {bvid|source, need?, prompt?} —— 直接给 BV 号/链接/本地路径/音频直链，
      // 由插件自己取音轨再转写。给 SurfCore 的 debrief 这类「没有字幕就得靠听」的管线用。
      if (req.method === 'POST' && (url.pathname === '/bili' || url.pathname === '/source')) {
        if (typeof handlers.transcribeSource !== 'function') throw new Error('这个版本不支持 source 转写')
        const body = await readBody(req)
        const json = JSON.parse(body.toString('utf8') || '{}')
        const source = String(json.source ?? json.bvid ?? '').trim()
        if (!source) throw new Error('JSON 里需要 source 或 bvid')
        const need = json.need === 'understand' ? 'understand' : 'text'
        const result = await handlers.transcribeSource(source, { need, prompt: json.prompt })
        sendJson(res, 200, { ok: true, ...result })
        return
      }
      sendJson(res, 404, { ok: false, error: `unknown route ${req.method} ${url.pathname}` })
    } catch (error) {
      log?.(`HTTP ${url.pathname} 失败：${error?.message ?? error}`)
      sendJson(res, 500, { ok: false, error: String(error?.message ?? error) })
    }
  })

  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      const address = server.address()
      resolve({
        port: typeof address === 'object' && address ? address.port : port,
        close: () => new Promise((done) => server.close(() => done())),
      })
    })
  })
}
