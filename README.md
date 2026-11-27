# dsh-fish-ears

本地优先的语音转写插件：离线识别、云端多模态兜底、B 站视频音轨、本机 HTTP 接口。

- 本地引擎：sherpa-onnx + SenseVoice / Paraformer，三档可选（82MB / 228MB / 232MB）
- 云端兜底：火山方舟音频理解（Ark Seed）或任意 OpenAI 兼容 `/audio/transcriptions`
- 路由：本地先听，听不出 / 要理解 / 超长音频才交云端，云端失败回落本地
- 没有本地模型也能用：装好直接填云端 Key 即可

## 安装

```bash
git clone https://github.com/751969653/dsh-fish-ears.git
cd dsh-fish-ears
npm install          # 只装 sherpa-onnx-node 与 schemastery
```

然后在 DSH 里把目录装成 bundle：

```
plugin_manager install_bundle "<仓库目录的绝对路径>"
```

重启 DSH，设置里会多出一页「小鱼耳朵」。首次转写时按所选档位下载模型（走 `hf-mirror.com`，也可手动指定本地模型目录）。

## 用法

```
ears_transcribe({ source: "D:/a.wav" })
ears_transcribe({ source: "BV1kVsP6jERE", need: "understand", prompt: "这游戏值得买吗" })
ears_status({})
ears_model({ action: "download", tier: "mid" })
```

本机服务（默认 8771）：`GET /health`、`POST /asr`、`POST /v1/audio/transcriptions`。

完整说明见 [docs/DETAIL.md](docs/DETAIL.md)。

## 开发

```bash
npm install
node .tmp/test-local.mjs   # 本地引擎冒烟测试（需要一段 wav）
```

- `index.js`：Config schema、工具注册、HTTP 服务、路由逻辑
- `lib/models.js`：模型档位与下载（hf-mirror）
- `lib/local.js`：sherpa-onnx-node 识别器
- `lib/cloud.js`：OpenAI 兼容的音频接口（transcriptions / chat input_audio）
- `lib/bili.js`：BV 号 → cid → dash 音轨 → 本地文件
- `lib/audio.js`：RIFF 解析、重采样、wav 编码、ffmpeg 转码
- `lib/quota.js`、`lib/postprocess.js`：额度账本、SenseVoice 标签清理与同音字修正

## 设置页

重启 DSH 之后，「设置」里会多出一页「小鱼耳朵」，可以直接改：

- 怎么听：本地优先 / 只用本地 / 只用云端
- 本地模型强度（低 Paraformer 小 82MB / 中 SenseVoice Small 228MB / 高 Paraformer 大 232MB），带「下载 / 检查」按钮
- 模型目录、自动下载、ffmpeg 路径
- 云端 Base URL、API Key、模型名、是否允许上传音频、何时交给云端、长音频阈值、太短补救字数、失败是否回退本地
- 额度：开关、每天次数、每天秒数、用完之后降级还是拒绝；累计 token 也一起记账
- 本机接口开关与端口、B站 cookie、同音字修正

除「本机接口的开关与端口」之外，保存后立即生效，不用重启。
