# 小鱼耳朵 Fish Ears

把声音听成字，顺便听懂它。

## 它能做什么

- **听语音**：本地离线识别（Paraformer / SenseVoice），不出网，一次加载后单条语音几十毫秒。
- **听懂 B 站视频**：给它 BV 号、视频链接或 b23 短链，它自己取 cid、抓音轨、用 ffmpeg 转 16k、再识别。100 秒视频约 1 秒出字。
- **听门缝**：本地跑不了的时候（没装模型、音频太长、或者你想问「这人说话什么情绪、值不值得看」），交给云端多模态模型；云端失败会静默退回本地。
- **当接口**：本机开一个 HTTP 服务，`POST /asr`、`POST /v1/audio/transcriptions`、`GET /health`，SurfCore 桥接、`dsh-better-ears` 之类的插件都能直接接。
- **算账**：云端可以设每天多少次、多少秒，超了降级本地或直接拒绝。

## 三个入口

### 工具 `ears_transcribe`

```
ears_transcribe({ source: "D:/a.wav" })                  // 本地文件
ears_transcribe({ source: "BV1kVsP6jERE" })              // B站视频
ears_transcribe({ source: "BV1kVsP6jERE", need: "understand", prompt: "这游戏值得买吗" })
```

`need: "understand"` 需要云端配好；它会把音频交给多模态模型，回答语气、情绪、内容评价这类问题。

### 工具 `ears_status` / `ears_model`

`ears_status` 看本地模型装没装、云端配没配、今天云端还剩多少额度。
`ears_model({ action: "download", tier: "mid" })` 预下载模型；`action: "status"` 看各档位。

### HTTP 服务（默认 8771）

```
GET  /health
POST /asr                        { "wav_b64": "..." } 或直接发 wav 二进制
POST /v1/audio/transcriptions    multipart 的 file 字段（OpenAI 兼容）
```

## 本地模型档位

| 档位 | 模型 | 体积 | 特点 |
| --- | --- | --- | --- |
| low | Paraformer 小 (int8) | 82 MB | 最快，不带标点 |
| mid | SenseVoice Small (int8) | 228 MB | 带标点、能识别情绪与事件，中英日韩粤 |
| high | Paraformer 大 (int8) | 232 MB | 识别更稳，不带标点 |

模型从 hf-mirror.com 下载；下载目录默认 `~/.dsh/fish-ears/models`。如果本机已经有 SurfCore 的 `state/asr/paraformer-zh-small`，选 low 档时会直接复制过来，不重复下载。

## 设置项

设置页里能改的都在这：

- **引擎模式**：`auto` 本地优先、云端兜底；`local` 只用本地；`cloud` 只用云端。
- **本地模型强度**：low / mid / high。
- **模型目录**、**自动下载模型**、**ffmpeg 路径**（留空自动找 PATH 和 WinGet 里的安装）。
- **云端**：Base URL、API Key、模型名（都是输入框，填什么都行：百炼 `https://dashscope.aliyuncs.com/compatible-mode/v1` + `qwen3.8-omni-flash`，火山方舟 `https://ark.cn-beijing.volces.com/api/v3` + `doubao-seed-1-6-flash-250928`，或者任何 OpenAI 兼容的音频端点）。
- **允许上传音频**：关掉就完全不出网。
- **需要理解时交给云端**、**长音频交给云端（秒）**、**本地结果太短时问云端（字）**、**云端失败回退本地**。
- **B站 Cookie**：留空会自动读 SurfCore 的 B 站凭据；填了就用填的。
- **同音字修正**：`本鲸=本亲|本金|本京`，多条用分号。
- **额度**：开关、每天调用上限、每天音频秒数上限、超限后降级本地还是直接拒绝。

## 已知限制

- 本地模型对**唱歌、纯音乐**没辙——它只会转字。音乐的速度、调性、曲式交给 `dsh-better-ears` 一类的 DSP 插件。
- `low` 档不输出标点，长句会连成一片；要标点和情绪就换 `mid`。
- 云端「理解」依赖对方模型支持 `input_audio`（百炼 omni 系列、火山 Seed 系列、Gemini 3 Flash 这类），纯文本模型会报错。
- B 站不带 Cookie 也能取到普通清晰度音轨；付费/大会员限定的视频需要 Cookie。
- 首次使用某个档位要等模型下载（low 82MB / mid 228MB / high 232MB），下载完成后常驻内存约 80–380MB，取决于档位。

## 设置页

重启 DSH 之后，「设置」里会多出一页「小鱼耳朵」，可以直接改：

- 怎么听：本地优先 / 只用本地 / 只用云端
- 本地模型强度（低 Paraformer 小 82MB / 中 SenseVoice Small 228MB / 高 Paraformer 大 232MB），带「下载 / 检查」按钮
- 模型目录、自动下载、ffmpeg 路径
- 云端 Base URL、API Key、模型名、是否允许上传音频、何时交给云端、长音频阈值、太短补救字数、失败是否回退本地
- 额度：开关、每天次数、每天秒数、用完之后降级还是拒绝
- 本机接口开关与端口、B站 cookie、同音字修正

除「本机接口的开关与端口」之外，保存后立即生效，不用重启。
