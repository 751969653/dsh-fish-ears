/**
 * dsh-fish-ears —— 浏览器半端（设置里新增「小鱼耳朵」一页）
 *
 * client bundle 不是 ESM，是自注册脚本：window.__ModuleLoader__.load({ id, factory })。
 * 进「设置」的方式：slots.inject('settings.section', () => slots.register({...}, () => h(Panel)))。
 * 读写配置走 host 半端的 /api/fish-ears/* 接口。
 */
window.__ModuleLoader__.load({
  id: 'dsh-fish-ears',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/api/fish-ears'

    const asJson = async (res) => {
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data.message || `HTTP ${res.status}`)
      return data
    }
    const jget = async (p) => asJson(await fetch(API + p, { credentials: 'same-origin' }))
    const jpost = async (p, body) =>
      asJson(
        await fetch(API + p, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body || {}),
        }),
      )

    const line = 'var(--dsw-alias-line-1, rgba(0,0,0,.1))'
    const box = { border: `1px solid ${line}`, borderRadius: 10, padding: '14px 16px', marginBottom: 14 }
    const rowStyle = { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12, padding: '7px 0' }
    const labelStyle = { opacity: 0.75, fontSize: 13 }
    const inputStyle = {
      width: 300,
      padding: '6px 8px',
      borderRadius: 8,
      border: `1px solid ${line}`,
      background: 'transparent',
      color: 'inherit',
      fontSize: 13,
    }
    const hint = { opacity: 0.55, fontSize: 12, marginTop: 6 }
    const sectionTitle = { fontSize: 13, fontWeight: 600, margin: '0 0 6px', opacity: 0.9 }

    function Switch({ on, onChange }) {
      return h(
        'button',
        {
          type: 'button',
          role: 'switch',
          'aria-checked': !!on,
          onClick: () => onChange(!on),
          style: {
            width: 40,
            height: 23,
            borderRadius: 999,
            border: 0,
            cursor: 'pointer',
            position: 'relative',
            background: on ? 'var(--dsw-alias-accent-1, #2f6df6)' : 'rgba(0,0,0,.18)',
          },
        },
        h('span', {
          style: {
            position: 'absolute',
            top: 3,
            left: on ? 20 : 3,
            width: 17,
            height: 17,
            borderRadius: '50%',
            background: '#fff',
            transition: 'left .15s',
          },
        }),
      )
    }

    function Text({ value, onSave, placeholder, type }) {
      const [draft, setDraft] = React.useState(value ?? '')
      React.useEffect(() => setDraft(value ?? ''), [value])
      return h('input', {
        type: type || 'text',
        value: draft,
        placeholder: placeholder || '',
        onChange: (e) => setDraft(e.target.value),
        onBlur: () => {
          if (draft !== (value ?? '')) onSave(draft)
        },
        style: inputStyle,
      })
    }

    function Select({ value, options, onSave }) {
      return h(
        'select',
        {
          value: value ?? '',
          onChange: (e) => onSave(e.target.value),
          style: { ...inputStyle, width: 180 },
        },
        options.map((opt) => h('option', { key: opt.value, value: opt.value }, opt.label)),
      )
    }

    function Panel() {
      const [state, setState] = React.useState({ cfg: null, status: null, models: null, note: '', busy: '' })
      const [error, setError] = React.useState('')

      const load = async () => {
        try {
          const data = await jget('/status')
          let models = null
          try {
            models = await jget('/models')
          } catch {
            /* models 只是附加信息 */
          }
          setState((prev) => ({ ...prev, cfg: data.config, status: data, models }))
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        }
      }

      React.useEffect(() => {
        load()
      }, [])

      const flash = (note) => {
        setState((prev) => ({ ...prev, note }))
        setTimeout(() => setState((prev) => ({ ...prev, note: '' })), 4000)
      }

      const patch = async (body) => {
        try {
          const data = await jpost('/config', body)
          const models = await jget('/models').catch(() => null)
          setState((prev) => ({ ...prev, cfg: data.config, status: data.status, models }))
          const extra = data.restartRequired && data.restartRequired.length ? `；${data.restartRequired[0]}` : ''
          flash(`${data.message || '已保存'}${extra}`)
          setError('')
        } catch (e) {
          setError(String(e.message || e))
        }
      }

      const download = async (tier) => {
        setState((prev) => ({ ...prev, busy: `正在下载 ${tier} 模型…` }))
        try {
          const data = await jpost('/models', { tier })
          flash(data.ok ? `模型已就绪（${data.sizeMB}MB）` : '模型下载没成功')
          await load()
        } catch (e) {
          setError(String(e.message || e))
        } finally {
          setState((prev) => ({ ...prev, busy: '' }))
        }
      }

      const cfg = state.cfg
      const st = state.status
      if (!cfg) {
        return h('div', { style: { padding: 8 } }, error ? `加载失败：${error}` : '正在读取小鱼耳朵的配置…')
      }

      const localLabel = st?.local?.ready
        ? `${st.local.label}（${st.local.sizeMB}MB，${st.local.loaded ? '已加载' : '未加载'}）`
        : `${st?.local?.label || cfg.tier}（还没下载）`
      const cloudLabel = st?.cloud?.configured ? `${st.cloud.model || '已配置'}` : '没配'
      const quota = st?.quota || {}

      return h(
        'div',
        null,
        h('h3', { style: { margin: '0 0 4px', fontSize: 15 } }, '小鱼耳朵'),
        h(
          'p',
          { style: { ...hint, marginTop: 0, marginBottom: 14 } },
          `离线转写 + 云端理解。本地：${localLabel} ｜ 云端：${cloudLabel} ｜ 本机接口：${
            st?.server?.enabled === false ? '未开启' : `127.0.0.1:${st?.server?.port ?? cfg.serverPort}`
          } ｜ 今天云端：${quota.calls ?? 0}/${quota.callLimit || '∞'} 次、${quota.seconds ?? 0}/${
            quota.secondLimit || '∞'
          } 秒`,
        ),
        error ? h('div', { style: { ...box, borderColor: '#e5484d', color: '#e5484d' } }, error) : null,
        state.note ? h('div', { style: { fontSize: 12, opacity: 0.75, marginBottom: 10 } }, state.note) : null,

        h(
          'div',
          { style: box },
          h('p', { style: sectionTitle }, '引擎'),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '怎么听'),
            h(Select, {
              value: cfg.mode,
              options: [
                { value: 'auto', label: '本地优先，必要时上云' },
                { value: 'local', label: '只用本地' },
                { value: 'cloud', label: '只用云端' },
              ],
              onSave: (v) => patch({ mode: v }),
            }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '本地模型强度'),
            h(Select, {
              value: cfg.tier,
              options: (state.models?.tiers || [
                { tier: 'low', label: '低 · Paraformer 小' },
                { tier: 'mid', label: '中 · SenseVoice Small' },
                { tier: 'high', label: '高 · Paraformer 大' },
              ]).map((t) => ({ value: t.tier, label: `${t.label}${t.ready ? ' ✓' : ''}` })),
              onSave: (v) => patch({ tier: v }),
            }),
          ),
          h(
            'div',
            { style: { ...rowStyle, justifyContent: 'flex-end', gap: 10 } },
            state.busy
              ? h('span', { style: labelStyle }, state.busy)
              : h(
                  'button',
                  {
                    type: 'button',
                    onClick: () => download(cfg.tier),
                    style: {
                      padding: '7px 14px',
                      borderRadius: 8,
                      fontSize: 13,
                      border: '1px solid transparent',
                      background: 'var(--dsw-alias-accent-1, #2f6df6)',
                      color: '#fff',
                      cursor: 'pointer',
                    },
                  },
                  '下载 / 检查当前档位模型',
                ),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '模型目录'),
            h(Text, { value: cfg.modelDir, placeholder: '留空 = ~/.dsh/fish-ears/models', onSave: (v) => patch({ modelDir: v }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '自动下载模型'),
            h(Switch, { on: cfg.autoDownload !== false, onChange: (v) => patch({ autoDownload: v }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, 'ffmpeg 路径'),
            h(Text, { value: cfg.ffmpegPath, placeholder: '留空自动找', onSave: (v) => patch({ ffmpegPath: v }) }),
          ),
        ),

        h(
          'div',
          { style: box },
          h('p', { style: sectionTitle }, '云端（火山方舟 / 百炼 / Gemini）'),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, 'Base URL'),
            h(Text, {
              value: cfg.cloudBaseUrl,
              placeholder: 'https://ark.cn-beijing.volces.com/api/v3',
              onSave: (v) => patch({ cloudBaseUrl: v }),
            }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, 'API Key'),
            h(Text, {
              value: '',
              placeholder: cfg.cloudApiKeySet ? '已填写，留空表示不改' : 'sk-…',
              onSave: (v) => (v ? patch({ cloudApiKey: v }) : null),
            }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '模型名'),
            h(Text, {
              value: cfg.cloudModel,
              placeholder: 'qwen3.8-omni-flash',
              onSave: (v) => patch({ cloudModel: v }),
            }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '允许上传音频到云端'),
            h(Switch, { on: cfg.cloudAllowUpload === true, onChange: (v) => patch({ cloudAllowUpload: v }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '要「理解」时交给云端'),
            h(Switch, { on: cfg.cloudOnUnderstand !== false, onChange: (v) => patch({ cloudOnUnderstand: v }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '长音频改走云端（秒）'),
            h(Text, {
              value: String(cfg.cloudLongAudioSec ?? 120),
              onSave: (v) => patch({ cloudLongAudioSec: Number(v) || 0 }),
            }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '本地结果太短就补救（字）'),
            h(Text, { value: String(cfg.cloudMinChars ?? 2), onSave: (v) => patch({ cloudMinChars: Number(v) || 0 }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '低延迟队列（方舟 fast，需控制台开通）'),
            h(Switch, { on: cfg.cloudFast !== false, onChange: (v) => patch({ cloudFast: v }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '理解时先思考（更细，慢 4–5 倍）'),
            h(Switch, { on: cfg.cloudThink === true, onChange: (v) => patch({ cloudThink: v }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '云端失败回退本地'),
            h(Switch, { on: cfg.cloudFallbackLocal !== false, onChange: (v) => patch({ cloudFallbackLocal: v }) }),
          ),
        ),

        h(
          'div',
          { style: box },
          h('p', { style: sectionTitle }, '额度'),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '开启额度管理'),
            h(Switch, { on: cfg.quotaEnabled === true, onChange: (v) => patch({ quotaEnabled: v }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '每天云端次数上限'),
            h(Text, { value: String(cfg.quotaDailyCalls ?? 20), onSave: (v) => patch({ quotaDailyCalls: Number(v) || 0 }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '每天云端音频秒数上限'),
            h(Text, {
              value: String(cfg.quotaDailySeconds ?? 300),
              onSave: (v) => patch({ quotaDailySeconds: Number(v) || 0 }),
            }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '用完之后'),
            h(Select, {
              value: cfg.quotaOnExceed || 'local',
              options: [
                { value: 'local', label: '降级用本地' },
                { value: 'reject', label: '直接拒绝' },
              ],
              onSave: (v) => patch({ quotaOnExceed: v }),
            }),
          ),
        ),

        h(
          'div',
          { style: box },
          h('p', { style: sectionTitle }, '本机接口与其他'),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '开着 HTTP 接口（给聊天桥接用）'),
            h(Switch, { on: cfg.serverEnabled !== false, onChange: (v) => patch({ serverEnabled: v }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, '端口'),
            h(Text, { value: String(cfg.serverPort ?? 8771), onSave: (v) => patch({ serverPort: Number(v) || 8771 }) }),
          ),
          h(
            'div',
            { style: rowStyle },
            h('span', { style: labelStyle }, 'B站 cookie'),
            h(Text, {
              value: cfg.biliCookie,
              placeholder: '留空自动读 SurfCore 的登录态',
              onSave: (v) => patch({ biliCookie: v }),
            }),
          ),
          h(
            'div',
            { style: { padding: '7px 0' } },
            h('div', { style: labelStyle }, '同音字修正（一行一条，例如 本鲸=本亲|本金）'),
            h('textarea', {
              defaultValue: cfg.corrections || '',
              onBlur: (e) => patch({ corrections: e.target.value }),
              rows: 3,
              style: { ...inputStyle, width: '100%', marginTop: 6, fontFamily: 'inherit' },
            }),
          ),
          h(
            'p',
            { style: hint },
            '改了「本机接口」的开关或端口要重启 DSH 才生效；其他选项保存即生效。',
          ),
        ),
      )
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        const slots = (typeof ctx.get === 'function' ? ctx.get('slots') : undefined) || ctx.slots
        if (!slots) return
        slots.inject('settings.section', () =>
          slots.register({ name: 'settings.section', id: 'fish-ears', order: 41, label: '小鱼耳朵' }, () => h(Panel)),
        )
      },
    }
  },
})
