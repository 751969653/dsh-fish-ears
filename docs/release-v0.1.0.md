# v0.1.0 · 小鱼耳朵

第一个可用版本：给 DSH 装一对「能听懂声音」的耳朵，本地优先、云端可按需兜底。

## 亮点

- **本地识别，离线可用**：内置 sherpa-onnx 引擎，三档模型随时换
  - `低` Paraformer zh-small · 82MB · 约 70ms / 4 秒语音
  - `中` SenseVoice Small · 228MB · 带标点 + 情绪/事件标签（默认）
  - `高` Paraformer zh-large · 232MB
- **云端兜底**：支持火山方舟音频理解（`doubao-seed-2-1-lite`，走 `/responses`，可直接喂 base64，不需要对象存储）与任意 OpenAI 兼容 `/audio/transcriptions`
- **智能路由**：本地先听；听不出、要求「理解」、音频过长时才交云端；云端失败静默回落本地
- **三个入口**：`ears_transcribe` 工具、本机 HTTP（`/asr`、`/v1/audio/transcriptions`、`/health`）、设置页
- **B 站视频**：给一个 BV 号或 b23 短链，自动取音轨 → 转码 → 识别（98 秒视频约 0.9 秒听完）
- **聊天桥接零改造**：本机 8771 端口兼容 `{wav_b64}` 与 OpenAI multipart 两种调用，接上就能给 QQ / 微信语音做转写
- **额度管理**：每日次数 / 每日音频秒数 / 超限后降级或拒绝
- **同音字修正**：`本鲸=本亲|本金|本京|本惊|本君` 这类可配置替换

## 设置页

重启 DSH 后，设置里多一页「小鱼耳朵」：引擎模式、模型档位与下载、模型目录、ffmpeg 路径、云端 Base URL / API Key / 模型名、低延迟队列、理解时思考、额度、本机端口、B 站 cookie、同音字修正。除端口开关外，保存即生效。

## 已知限制

- 人声被音乐盖住时，本地引擎可能返回空（会自动补一次云端；也可直接把模式设成「只走云端」）
- 情绪标签只有 7 档（开心 / 难过 / 生气 / 平静 / 害怕 / 无语 / 惊讶），细粒度语气交给云端
- 分不清真人还是 AI 生成的歌声；不做 BPM / 调性 / 曲式分析（那是 `dsh-better-ears` 那类 DSP 的活）
- 只处理音频；视频画面内容需要另外的工具

## 安装

```bash
git clone https://github.com/751969653/dsh-fish-ears.git
cd dsh-fish-ears && npm install
```

```
plugin_manager install_bundle "<仓库目录绝对路径>"
```

重启 DSH → 设置 → 小鱼耳朵 → 选档位或填云端 Key。

## 致谢

[sherpa-onnx](https://github.com/k2-fsa/sherpa-onnx) 与 [SenseVoice](https://github.com/FunAudioLLM/SenseVoice) 提供本地识别；模型镜像走 [hf-mirror](https://hf-mirror.com)。
