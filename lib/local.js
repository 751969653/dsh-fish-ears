// Local offline recognizer (sherpa-onnx-node). Loaded lazily so the plugin
// costs nothing until the first transcription.

import { createRequire } from 'node:module'
import { emotionZh, eventZh, stripTags, tagValue } from './postprocess.js'

const require = createRequire(import.meta.url)

let sherpaModule
function loadSherpa() {
  if (!sherpaModule) sherpaModule = require('sherpa-onnx-node')
  return sherpaModule
}

export class LocalEngine {
  constructor({ root, tier, log } = {}) {
    this.root = root
    this.tier = tier
    this.log = log ?? (() => {})
    this.recognizer = null
    this.loadedAt = 0
    this.loadMs = 0
  }

  get kind() {
    return this.tier === 'mid' ? 'senseVoice' : 'paraformer'
  }

  /** Load (or reload) the recognizer for `paths` = { model, tokens }. */
  load({ model, tokens }) {
    if (this.recognizer && this.modelPath === model) return this
    const sherpaLib = loadSherpa()
    const modelConfig = {
      tokens,
      numThreads: Math.max(2, Math.min(4, (require('node:os').cpus().length || 4) - 1)),
      provider: 'cpu',
      debug: 0,
    }
    if (this.kind === 'senseVoice') {
      modelConfig.senseVoice = { model, language: 'auto', useInverseTextNormalization: 1 }
    } else {
      modelConfig.paraformer = { model }
    }
    const started = Date.now()
    this.recognizer = new sherpaLib.OfflineRecognizer({
      featConfig: { sampleRate: 16000, featureDim: 80 },
      modelConfig,
    })
    this.modelPath = model
    this.loadMs = Date.now() - started
    this.loadedAt = Date.now()
    this.log(`本地识别器就绪（${this.tier}，加载 ${this.loadMs}ms）`)
    return this
  }

  /** Transcribe 16 kHz mono Float32 samples. Returns { text, lang, emotion, event, ms }. */
  transcribe(samples) {
    if (!this.recognizer) throw new Error('local recognizer is not loaded')
    const started = Date.now()
    const stream = this.recognizer.createStream()
    stream.acceptWaveform({ sampleRate: 16000, samples })
    this.recognizer.decode(stream)
    const result = this.recognizer.getResult(stream)
    const parsed = stripTags(result.text ?? '')
    // SenseVoice puts its tags in dedicated fields ("<|zh|>", "<|HAPPY|>") instead of the text.
    const lang = tagValue(result.lang).toLowerCase()
    return {
      text: parsed.text,
      lang: parsed.lang || (/^(zh|en|ja|ko|yue)$/.test(lang) ? lang : ''),
      emotion: parsed.emotion || emotionZh(result.emotion),
      event: parsed.event || eventZh(result.event),
      ms: Date.now() - started,
    }
  }

  dispose() {
    this.recognizer = null
    this.modelPath = undefined
  }
}
