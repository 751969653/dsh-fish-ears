// Post-processing: SenseVoice emits inline tags such as <|zh|> / <|HAPPY|>,
// and both engines make the occasional homophone mistake. Both are cleaned
// here so tool output is plain readable text.

const EMOTION_ZH = {
  HAPPY: '开心',
  SAD: '难过',
  ANGRY: '生气',
  NEUTRAL: '平静',
  FEARFUL: '害怕',
  DISGUSTED: '无语',
  SURPRISED: '惊讶',
  EMO_UNKNOWN: '',
}

const EVENT_ZH = {
  Speech: '说话',
  BGM: '背景音乐',
  Applause: '鼓掌',
  Laughter: '笑',
  Cry: '哭',
  Cough: '咳嗽',
  Sneeze: '喷嚏',
  Breath: '呼吸声',
  'Speech|BGM': '边说话边有背景音乐',
}

/** Split "<|zh|><|HAPPY|><|Speech|>喂…" into clean text plus tag values. */
export function stripTags(raw) {
  const text = String(raw ?? '')
  const tags = [...text.matchAll(/<\|([^|]+)\|>/g)].map((m) => m[1].trim())
  const clean = text.replace(/<\|[^|]+\|>/g, '').replace(/\s+/g, ' ').trim()
  const lang = tags.find((t) => /^(zh|en|ja|ko|yue)$/i.test(t)) ?? ''
  const emotionKey = tags.find((t) => Object.prototype.hasOwnProperty.call(EMOTION_ZH, t.toUpperCase()))
  const eventKey = tags.find((t) => Object.prototype.hasOwnProperty.call(EVENT_ZH, t))
  return {
    text: clean,
    lang,
    emotion: emotionKey ? EMOTION_ZH[emotionKey.toUpperCase()] : '',
    event: eventKey ? EVENT_ZH[eventKey] : '',
  }
}

/** Strip <|…|> from a single tag field such as "<|zh|>" or "<|HAPPY|>". */
export function tagValue(value) {
  const match = /<\|([^|]+)\|>/.exec(String(value ?? ''))
  return match ? match[1].trim() : String(value ?? '').trim()
}

export function emotionZh(value) {
  const key = tagValue(value).toUpperCase()
  return EMOTION_ZH[key] ?? (key && key !== 'EMO_UNKNOWN' ? '' : '')
}

export function eventZh(value) {
  const key = tagValue(value)
  return EVENT_ZH[key] ?? ''
}

/**
 * Parse user-supplied corrections: "本鲸=本亲|本金; 大肥鱼=大飞鱼".
 * Returns a flat list of { from, to } pairs.
 */
export function parseCorrections(spec) {
  const pairs = []
  for (const group of String(spec ?? '').split(/[;；]/)) {
    const [right, left] = group.split(/[=＝]/)
    const to = String(right ?? '').trim()
    if (!to) continue
    for (const wrong of String(left ?? '').split(/[|,，、]/)) {
      const from = wrong.trim()
      if (from && from !== to) pairs.push({ from, to })
    }
  }
  return pairs
}

export function applyCorrections(text, pairs) {
  let out = String(text ?? '')
  for (const { from, to } of pairs) out = out.split(from).join(to)
  return out
}
