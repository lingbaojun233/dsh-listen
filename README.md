# dsh-listen

把**「听」的能力**注册成 DSH 原生工具：模型不用先 `ls` 翻目录、拼 `curl`，而是像用
`bash` 一样直接 `hear`（`words_only:true` 只转写）。零运行时依赖，`index.js` 里只用 Node 内置的
`fetch` 和 `fs/promises`。

> Native DSH tools for a listen service — speech-to-text, plus the non-speech sound picture.
> No dependencies.

## 它做什么

| 模式 | 一句话 | 后端 |
| --- | --- | --- |
| `hear { words_only: true }` | **只要文字**：把音/视频里说的话转成文本 | `POST {baseUrl}/v1/transcribe` |
| `hear`（默认） | **还要知道还有什么声音**：台词 + 响动/静音/持续背景声 + 整体氛围 | `POST {baseUrl}/v1/hear` |

两种模式共用一个工具、一套入参（`filePath` 或 `audioBase64`，可选 `mime`），区别只在**要不要
非语音信息** —— 拆成两个工具只会让每轮的固定 token 翻倍：

| 你想知道 | 用哪个 |
| --- | --- |
| 这段录音说了什么 | `hear { words_only: true }` |
| 有没有关门声/脚步/音乐/爆炸声，是不是一直很吵，后面是不是被截断了 | `hear` |
| 既要台词又要氛围 | `hear`（它已经包含台词，别调两次） |

`hear` 的返回是 `summary + transcript + events` 组织成的一段可读文本。上游算出来的
`levels[]`（给前端画波形用的几千个 dB 数）**故意不回传**——那玩意塞进上下文只会把
token 预算吃光。真要波形，直接请求 `GET/POST {baseUrl}/v1/hear` 拿原始 JSON。

工具执行失败**不抛异常**，而是返回 `{ ok: false, code, message, hint }` 这样的结构化
JSON——模型看到 `hint` 才能自己恢复（换参数、提示你启动服务），而不是拿到一条读不懂的
调用栈。

## 依赖

一个在跑的 **listen 服务**，默认 `http://127.0.0.1:8771`。

- 开箱即用：DSH-MultiTool 的 `listen` 模块（Windows 下 `listen\start-server.cmd`）。
  本文的接口契约就是按它写的。
- 自己实现也行，只要路径、请求体字段、返回 JSON 对齐即可（见下方「API 契约」）。
- 插件本身**不转码、不识别、不读主项目任何文件**，只发 HTTP。

### API 契约

两条都是 `POST` + `content-type: application/json`，响应 JSON。失败也返回
**HTTP 200 + `{ ok:false, error }`**（面板只看 body，不看状态码），插件的 `code`
就是从 `error` 里取的第一段。

```jsonc
// POST /v1/transcribe
{ "audioBase64": "UklGRi...", "mime": "audio/wav" }
// → { "ok": true, "text": "今天服务器又崩了", "ms": 1203, "provider": "windows-sapi",
//     "segments": 1, "confidence": 0.82 }
// 注意：上游字段叫 text，而且没有 duration；插件会把它归一成 transcript，duration 缺就是 null。

// POST /v1/hear
{ "filePath": "D:\\clips\\door.mp4" }        // 或者 { "audioBase64": "...", "mime": "audio/wav" }
// → { "ok": true, "duration": 12, "truncated": false,
//     "transcript": "把门关上", "speechOk": true, "confidence": 0.88,
//     "events": [{ "t": "0:03", "kind": "sudden", "desc": "音量突然变大到 -8 dB（像撞击、爆响或突然的呼喊）" }],
//     "summary": "全长约 12 秒，其中 6 秒有声音；听得到人说话", "levels": [-52, -48, ...] }
```

`filePath` 是**listen 服务所在那台机器**上的绝对路径（不是 DSH 进程的当前目录）。
服务在另一台机器时，`filePath` 指的是那台机器上的文件。

### 关于 `words_only:true` 的 `filePath`

上游 `/v1/transcribe` 目前**只吃 base64**（不像 `/v1/hear` 能直接读 `filePath`），所以
插件只在 `words_only:true` 时做一次兜底：先把 `{filePath}` 原样发给服务；**只有**服务回
`EMPTY_AUDIO` / `BAD_BASE64` / `AUDIO_TOO_SHORT` 时，才本地把文件读成 base64 再试一次。
服务端能读 `filePath` 的情况下不会多传一份几十 MB 的 base64，契约也不用改。

## 安装

插件是标准 DSH bundle：`package.json` 里声明了 `dsh.bundle.patch`，装载时会插入
`cordis.patch.yml` 里那一行。以下三种方式任选其一。

### 方式 A：Plugin Manager（推荐）

```powershell
git clone https://github.com/lingbaojun233/dsh-listen.git
```

在 DSH 的 Plugin Manager 里 **Add plugin** 选中这个目录；或让 agent 调用
`plugin_manager` 的 `install_bundle`，`target` 传该目录的**绝对路径**。

### 方式 B：手工放进 profile 的 `node_modules`

```powershell
# 1) 把仓库放进 profile 的 node_modules（路径换成你自己的 profile）
$dst = "$env:USERPROFILE\.dsh\profiles\default\node_modules\dsh-listen"
robocopy . $dst /MIR

# 2) 在 profile/package.json 的 dsh.profile.bundles 里加上包名
#    "dsh": { "profile": { "bundles": ["dsh-listen"] } }
```

npm 发布之后也可以在 profile 目录里 `npm i dsh-listen`。

### 方式 C：直接写进 `cordis.yml`

profile 的 `cordis.yml` 本质是一个插件条目列表。原文件如果是空的 `[]`，整个换成：

```yaml
- id: dsh-listen
  name: dsh-listen
  config:
    baseUrl: 'http://127.0.0.1:8771'
```

已有条目就追加同样一项（注意 `-` 对齐、缩进用空格）。

> `name` 是**包名**，必须是 DSH 能解析到的模块；用方式 B 时要和 `node_modules` 下的目录名一致。

## 配置

`cordis.patch.yml` 里的 row config：

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `baseUrl` | `http://127.0.0.1:8771` | listen 服务根地址。不要带结尾斜杠（带了也会被去掉） |

| 环境变量 | 作用 |
| --- | --- |
| `DSH_LISTEN_URL` | `baseUrl` 的兜底值；配置里没写时才用它 |

解析优先级：`config.baseUrl` → `DSH_LISTEN_URL` → 内置默认值 `http://127.0.0.1:8771`。

想改端口或指向另一台机器，改 row config 最省事；容器/服务端部署没地方写 config 时再
用环境变量。

## 工具与参数 schema

只有一个工具 `hear`，两种模式共用一套参数：

```json
{
  "type": "object",
  "properties": {
    "filePath": {
      "type": "string",
      "description": "On the listen-service machine; or pass audioBase64."
    },
    "audioBase64": {
      "type": "string",
      "description": "Base64 audio bytes; omit when passing filePath."
    },
    "mime": {
      "type": "string",
      "description": "e.g. audio/wav; guessed from the file when omitted."
    },
    "words_only": {
      "type": "boolean",
      "description": "true = words only via /v1/transcribe; default false."
    }
  }
}
```

`filePath` 和 `audioBase64` **必须给一个**。都不给时插件直接返回

```json
{
  "ok": false,
  "code": "MISSING_AUDIO_SOURCE",
  "message": "hear needs one of filePath or audioBase64; neither was given, so nothing was sent.",
  "hint": "pass filePath (a file on the machine running the listen service) or audioBase64 (optionally with mime)"
}
```

不会抛异常、也不会发一个空请求出去。

### `hear { words_only: true }` 返回

```json
{ "ok": true, "transcript": "今天服务器又崩了", "duration": null, "confidence": 0.82 }
```

### `hear` 返回

```json
{
  "ok": true, "duration": 12, "transcript": "把门关上",
  "speechOk": true, "confidence": 0.88,
  "events": [{ "t": "0:03", "kind": "sudden", "desc": "音量突然变大到 -8 dB（…）" }],
  "summary": "全长约 12 秒，其中 6 秒有声音；听得到人说话",
  "truncated": false
}
```

渲染成文本大致是：

```text
听感：全长约 12 秒，其中 6 秒有声音；听得到人说话

台词：把门关上

声音事件 / 非语音声音（1 条）：
- [0:03] 音量突然变大到 -8 dB（像撞击、爆响或突然的呼喊）

—— 时长 12s · 置信度 0.88 · 有人声
```

## 排错

### 1. `{ "ok": false, "code": "MISSING_AUDIO_SOURCE" }`

参数没给全。`filePath` 和 `audioBase64` 至少一个，`mime` 可省。

### 2. `{ "ok": false, "code": "UNREACHABLE" }`

服务没起来、端口不对，或被防火墙拦了。

```powershell
# 用 Node 自带 fetch 探活，省掉 PowerShell 引号转义的坑
node -e "fetch('http://127.0.0.1:8771/v1/health').then(r=>r.text()).then(console.log)"
```

有 JSON 返回说明服务活着，问题在 `baseUrl`；没返回就先把服务启动起来。
`code: "TIMEOUT"` 表示 180s（words_only）/ 300s（hear）内没响应，通常是 ffmpeg 卡住或
识别引擎挂了。

### 3. `{ "ok": false, "code": "FILE_NOT_FOUND" }`

`filePath` 在**运行 listen 服务的那台机器**上不存在。两种可能：路径写错，或服务根本不在
本机（那样这个路径当然不存在）。远程部署时改用 `audioBase64` 自己把字节递过去。

### 4. `EMPTY_AUDIO` / `BAD_BASE64` / `AUDIO_TOO_SHORT`

- `EMPTY_AUDIO`：服务没收到音频。`words_only:true` 只给 `filePath` 时会本地读文件兜底一次；
  如果仍然出现，先确认 `filePath` 可读、文件不是 0 字节。
- `BAD_BASE64`：`audioBase64` 里混了换行/空白，或不是合法 base64。
- `AUDIO_TOO_SHORT`：有效音频不到一帧（约 44 字节），太短的"哔"声识别不了。

### 5. `ASR_FAILED` / 转写永远是空字符串

`GET /v1/health` 看 `recognizers`：空数组说明这台机器**没装 SAPI 中文识别引擎**，
`ok` 会是 `false`。装一个中文识别引擎（Windows 语音识别/语言包）再试。
另外 `GET /v1/recognizers` 会强制重新枚举，绕开 60 秒缓存。

### 6. 超过 32MB

上游 `maxAudioBytes` 默认 32MB，插件本地读文件兜底时也按同一上限拦。
长录音先截一段，或自己压成 16k 单声道 wav 再传。

### 7. `duration` 是 `null`

`words_only` 的上游不返回时长，插件不编数字——`null` 就是"不知道"。
`hear` 有 `duration`（秒，四舍五入到整数）。

### 8. 工具注册了但模型不用

工具表只在插件行**启用**后才注入。用 Plugin Manager 看该行的 `enabled`；改完
`cordis.yml` 通常需要重载 profile（headless 模式每次调用都会重载）。

## 开发

```powershell
node --check index.js
```

没有测试依赖、没有构建步骤；改完直接重载插件即可。

想在没有真实音频的情况下自测：起一个桩服务，在 `/v1/transcribe`、`/v1/hear` 上返回固定
JSON，然后 `apply({ tools: { register(fn) { ... } } }, { baseUrl: 'http://127.0.0.1:PORT' })`
手工调 `execute` 即可。

## License

MIT © 2026 lingbaojun233
