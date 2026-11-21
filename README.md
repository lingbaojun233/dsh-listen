# dsh-listen — 让 DSH 听懂一段录音：说了什么，还有什么声音

DSH 只能读文字，收到语音消息、会议录音、视频片段就束手无策。这个插件把「听」做成一个工具 `hear`：默认返回**台词 + 非语音声音**（关门声、脚步、音乐、静音、突然的爆响）+ 整体氛围；只要文字时传 `words_only: true`。

> 这个仓库只是**客户端**。真正转写的是 listen 服务（默认 `127.0.0.1:8771`），它在 [DSH-MultiTool](https://github.com/lingbaojun233/DSH-MultiTool) 的 `listen/` 里，依赖 ffmpeg 和 Windows 语音识别引擎。

## 快速开始

### 1. 安装

```powershell
# 进入你的 DSH profile 目录（默认在 C:\Users\你\.dsh\profiles\desktop）
cd "$env:USERPROFILE\.dsh\profiles\desktop"   # 把 desktop 换成你的 profile 名

npm install https://github.com/lingbaojun233/dsh-listen/archive/refs/heads/main.tar.gz
```

约 2 秒装完，没有构建步骤、没有 npm 依赖。

### 2. 启用

`dependencies` 由 npm 自动写好，你只要把包名加进 `dsh.profile.bundles` 末尾：

```json
{
  "dependencies": {
    "dsh-listen": "https://github.com/lingbaojun233/dsh-listen/archive/refs/heads/main.tar.gz"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-headless",
        "dsh-listen"
      ]
    }
  }
}
```

> 保留原有的其它 bundle 条目，只在最后追加。改完重启 DSH；headless 每次运行自动重新装配。

### 3. 验证

先确认服务就绪，并记下它认识哪些语言：

```powershell
curl.exe -s http://127.0.0.1:8771/v1/health
# {"ok":true,"provider":"windows-sapi","recognizers":[{"id":"MS-2052-80-DESK","culture":"zh-CN",...}],"ffmpeg":true,...}
```

准备一段 3~10 秒的语音（手机录音、微信语音导出都行），放到**运行 listen 服务的那台机器**上。新开一个会话，对 DSH 说：

> 听听 `D:\clips\memo.wav` 说了什么，只要文字（words_only:true）。

成功时返回类似：

```text
今天下午三点开会，记得带上方案。
—— 置信度 0.82
```

再问「这段录音里除了人说话，还有什么声音？」，默认模式会多给一段「声音事件」。

## 它提供哪些工具

| 工具 | 干什么 | 例子 |
|---|---|---|
| `hear` | 转写语音；默认还听非语音声音和整体氛围。`words_only:true` 时只转写 | 对 DSH 说「听听 D:\clips\memo.wav 说了什么，只要文字」 |

参数：

| 参数 | 必填 | 说明 |
|---|---|---|
| `filePath` | 二选一 | 文件路径，**在 listen 服务所在的那台机器上**（不是 DSH 的 cwd） |
| `audioBase64` | 二选一 | 音频字节的 base64；服务在另一台机器时用它 |
| `mime` | 否 | 如 `audio/wav`；不传时按扩展名猜 |
| `words_only` | 否 | `true` = 只转写（走 `/v1/transcribe`）；默认 `false`（走 `/v1/hear`） |

两种模式的区别：

| 你想知道 | 用哪个 |
|---|---|
| 这段录音说了什么 | `hear { words_only: true }` |
| 有没有关门声/脚步/音乐/爆炸声，是不是一直很吵，后面有没有被截断 | `hear`（默认） |
| 既要台词又要氛围 | `hear`（它已经包含台词，别调两次） |

`filePath` 和 `audioBase64` **必须给一个**，都不给会直接返回 `MISSING_AUDIO_SOURCE`，不会发空请求。

## 依赖

| 依赖 | 说明 |
|---|---|
| listen 服务 | 默认 `http://127.0.0.1:8771`，`GET /v1/health` 返回 `ok:true` |
| ffmpeg | 服务用它把任意音/视频容器转成 16k 单声道 wav；路径在 `listen/config.json` 的 `ffmpeg` |
| Windows 语音识别引擎 | 走 Windows SAPI。**装了哪些语言，才能识别哪些语言**；识别引擎列表见 `/v1/health` 的 `recognizers` |
| Node.js | ≥ 18（DSH 自带） |

服务从 DSH-MultiTool 里起：

```powershell
cd C:\Apps\DSH-MultiTool\listen
node server.js
# 或双击 start-server.cmd
```

> 服务端 `config.json` 里的 ffmpeg 路径默认按 `C:\Apps\DSH-MultiTool\` 布局写死；装在别处就改成你自己的路径。

**语言说明（别踩坑）**：这台验证机的 `recognizers` 里只有 `zh-CN`，所以实测只覆盖中文。要识别英文，得在 Windows 里加装 `en-US` 的语音识别组件，`/v1/health` 的 `recognizers` 出现 `en-US` 之后才可用。插件本身不限制语言，它只是把音频转给服务。

**大小和耗时**：单次音频上限 32MB；`words_only` 超时 180 秒，默认模式 300 秒。长录音先截一段，或压成 16k 单声道 wav 再传。

`filePath` / `audioBase64` / 端口：

| 项 | 默认 | 说明 |
|---|---|---|
| 端口 | `8771` | 只监听 `127.0.0.1` |
| `DSH_LISTEN_URL` | — | 服务地址兜底（配置里没写时才用） |

## 配置

插件没有 `config.json`，配置是**插件行的 `config` 字段**：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `baseUrl` | `http://127.0.0.1:8771` | listen 服务根地址；结尾斜杠会被自动去掉 |

解析优先级：`config.baseUrl` → `DSH_LISTEN_URL` → 内置默认值。

服务不在本机时：

```powershell
$env:DSH_LISTEN_URL = "http://192.168.1.20:8771"
```

或写进 profile 的 `cordis.patch.yml`（`config` 整体替换，字段要写全）：

```yaml
- id: dsh-listen
  config:
    baseUrl: 'http://192.168.1.20:8771'
```

## 常见问题

### 1. 返回 `UNREACHABLE`

服务没起或地址不对：

```powershell
curl.exe -s http://127.0.0.1:8771/v1/health
```

有 JSON 就说明服务活着，问题在 `baseUrl`；连不上就先把 `listen/server.js` 起起来。

### 2. 返回 `ASR_FAILED`，或转写永远是空字符串

`/v1/health` 的 `recognizers` 是空数组，说明这台 Windows **没装语音识别引擎**（常见于精简版系统）。装一个中文语音识别组件，再访问 `GET /v1/recognizers` 强制重新枚举（绕过 60 秒缓存）。

### 3. 返回 `FILE_NOT_FOUND`

`filePath` 是**运行 listen 服务的那台机器**上的路径，不是 DSH 进程的当前目录。服务在远程时，这个路径在远程不存在——改用 `audioBase64` 把字节递过去。

### 4. `EMPTY_AUDIO` / `BAD_BASE64` / `AUDIO_TOO_SHORT`

- `EMPTY_AUDIO`：服务没收到音频。只给 `filePath` 时会本地读文件兜底一次；仍然出现就先确认文件不是 0 字节、路径可读。
- `BAD_BASE64`：`audioBase64` 里混了换行/空格，或不是合法 base64。
- `AUDIO_TOO_SHORT`：有效音频不足一帧（约 44 字节），太短的「哔」声识别不了。

### 5. 英文录音识别不出来

先看 `/v1/health` 的 `recognizers` 里有没有 `en-US`。没有就是 Windows 没装英文识别引擎，插件和服务都没法凭空识别。

### 6. 转写结果的 `duration` 是 `null`

`words_only` 的上游只回文字，不回时长，插件不编数字——`null` 就是「不知道」。默认的 `hear` 模式有 `duration`（秒）。

## 实现说明

- 单文件 `index.js`（约 450 行），零依赖，只用 `fetch` + `fs/promises`。
- 一个工具两条路由：`words_only:true` → `POST /v1/transcribe`；否则 → `POST /v1/hear`。两者入参相同，拆成两个工具只会让每轮的固定开销翻倍。
- 只给 `filePath` 时，插件先把路径原样透传；**只有**服务回 `EMPTY_AUDIO` / `BAD_BASE64` / `AUDIO_TOO_SHORT` 时，才在本地把文件读成 base64 再试一次（上游 `/v1/transcribe` 目前只吃 base64）。服务能读路径时不会多传几十 MB。
- 返回统一成 `{ ok, transcript, duration, confidence, ... }`；`/v1/hear` 的 `levels[]`（给前端画波形的几千个数）**故意不回传**，塞进上下文只会吃 token。要波形直接请求服务拿原始 JSON。
- 失败不抛异常，返回 `{ ok:false, code, message, hint }`；`hint` 是给模型的下一步建议（换参数、检查引擎、启动服务）。
- 不落盘：插件不写任何音频文件；服务端处理完会删掉自己的临时文件，插件不保存音频。

## License

MIT © 2026 lingbaojun233
