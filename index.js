/**
 * dsh-listen
 *
 * 把 listen 模块（默认 127.0.0.1:8771）注册成两个 DSH 原生工具：
 *   transcribe —— 只要文字
 *   hear       —— 文字 + 非语音声音（响动 / 静音 / 持续背景声）+ 整体氛围
 *
 * 为什么全仓库只有一个 index.js、不 import 任何兄弟项目：
 * 这个仓库要能被陌生人单独 clone 下来当 bundle 装。一旦它 require 了 ../DSH-MultiTool
 * 里的某个文件，公开出去就没人装得起来。
 *
 * 为什么手写工具对象、不 import @deepseek-ai/dsh-tools：
 * 普通 profile 里解析不到那个包；而 ctx.tools.register 收的本来就是 defineTool 编译后的
 * 普通对象（name/description/parameters/output/execute），同形状手写即可。
 *
 * 为什么只用 node 内置 + 全局 fetch：
 * 多一个运行时依赖就多一次「npm i 装不上」的机会，而这里只发一个 HTTP POST。
 */

import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';

export const name = 'dsh-listen';
export const inject = ['tools'];

const DEFAULT_BASE_URL = 'http://127.0.0.1:8771';

// 转写 = ffmpeg 转 wav + PowerShell 跑 SAPI，几秒到几十秒。180s 是留给长音频和慢机器的，
// 不是常态；真卡这么久多半是引擎挂了，早点超时比无限挂住好。
const TRANSCRIBE_TIMEOUT_MS = 180000;
// hear = 抽音轨 + 逐窗口算能量 + 再跑一遍 ASR。上游自己的上限是 180s（hearTimeoutMs），
// 这里给两倍余量，免得插件先于服务端超时、把一个还在跑的请求掐掉。
const HEAR_TIMEOUT_MS = 300000;

// 与上游 maxAudioBytes 的默认值保持一致：超了上游会直接拒收，
// 本地读文件时先拦一次，省得把 40MB 的 base64 塞进 JSON 再被 413 打回来。
const MAX_AUDIO_BYTES = 32 * 1024 * 1024;

// filePath → mime。上游其实能靠文件头猜，但显式带上能省掉一次猜错的机会。
const MIME_BY_EXT = {
  '.wav': 'audio/wav',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.aac': 'audio/aac',
  '.ogg': 'audio/ogg',
  '.opus': 'audio/ogg',
  '.flac': 'audio/flac',
  '.webm': 'audio/webm',
  '.mp4': 'video/mp4',
  '.mkv': 'video/x-matroska',
  '.mov': 'video/quicktime',
  '.avi': 'video/x-msvideo',
};

// 这几个错误说明「上游压根没拿到音频」，不是音频内容有问题。
// 只有它们值得本地读文件补一次 base64 —— 其他错误（ASR_FAILED 等）重试也是白重试。
const MISSING_AUDIO_ERRORS = new Set(['EMPTY_AUDIO', 'BAD_BASE64', 'AUDIO_TOO_SHORT', 'NO_AUDIO']);

// 上游的 error 是给人看的短码（EMPTY_AUDIO / FILE_NOT_FOUND / TIMEOUT…），
// 直接丢给模型没意义，配一句「下一步该干什么」它才能自己恢复。
const HINT_BY_CODE = {
  MISSING_AUDIO_SOURCE:
    'pass filePath (a file on the machine running the listen service) or audioBase64 (optionally with mime)',
  EMPTY_AUDIO: 'no audio arrived: pass filePath or audioBase64',
  BAD_BASE64: 'audioBase64 is not valid base64; strip any whitespace or re-encode the file',
  AUDIO_TOO_SHORT: 'the clip is shorter than a usable audio frame; send at least a fraction of a second',
  AUDIO_TOO_LARGE: 'over the 32MB audio limit; transcribe a shorter excerpt',
  FILE_NOT_FOUND: 'the path does not exist on the machine running the listen service',
  FILE_UNREADABLE: 'the file exists but the DSH process could not read it; pass audioBase64 instead',
  BAD_JSON: 'the listen service rejected the request body as invalid JSON',
  BODY_TOO_LARGE: 'the request body exceeded the service limit (32MB by default)',
  FFMPEG_MISSING: 'ffmpeg is not installed at the path the listen service expects',
  FFMPEG_FAILED: 'ffmpeg could not decode this file; try another format (wav 16k mono is safest)',
  TIMEOUT: 'ffmpeg or the speech recognizer exceeded the service timeout; try a shorter clip',
  ASR_FAILED: 'no speech recognizer is installed or SAPI failed; check GET /v1/health for recognizers',
  UNREACHABLE: 'is the listen service running? check the port, then set config.baseUrl or DSH_LISTEN_URL',
  BAD_RESPONSE: 'the service returned something that is not JSON (a proxy error page?)',
  SERVICE_ERROR: 'the listen service returned a failure without a code; see message',
};

/**
 * 配置优先、环境变量兜底。
 * 同一台机器上跑多份 profile、或 listen 跑在另一台机器时，只改 env 就能切后端；
 * 末尾斜杠会让 `${base}/v1/...` 变成双斜杠，有的反向代理会 404，所以先削掉。
 */
function baseUrlOf(config) {
  const fromConfig = config && typeof config.baseUrl === 'string' ? config.baseUrl.trim() : '';
  const fromEnv = (process.env.DSH_LISTEN_URL || '').trim();
  return (fromConfig || fromEnv || DEFAULT_BASE_URL).replace(/\/+$/, '');
}

function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

const textBlock = (value) => [
  { type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) },
];

/**
 * 发一个 JSON POST。**永远不抛异常**：网络错误、超时、非 JSON 响应都变成
 * { ok:false, code, message, hint }，好让模型看到结构化失败并自己改参数。
 */
async function postJson(url, body, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const text = await res.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      // 反向代理的 HTML 错误页也会走到这里；别让 JSON.parse 把真实状态码吃掉
      data = { ok: false, error: 'BAD_RESPONSE', message: text.slice(0, 500) };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const aborted = err && err.name === 'AbortError';
    // Node 的 fetch 网络错误只有一句 "fetch failed"，真正的原因（ECONNREFUSED 等）在 cause 里；
    // 不把它带出来，模型只会反复重试同一个错误。
    const cause = err && err.cause ? err.cause.code || err.cause.message : '';
    return {
      ok: false,
      code: aborted ? 'TIMEOUT' : 'UNREACHABLE',
      message: aborted
        ? `no response within ${timeoutMs}ms`
        : `${String((err && err.message) || err)}${cause ? ` (${cause})` : ''}`,
      hint: HINT_BY_CODE[aborted ? 'TIMEOUT' : 'UNREACHABLE'],
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 上游的 error 可能长成 "ASR_FAILED: xxx"，取冒号前那段当 code，人能一眼看出类别。 */
function failureCode(data) {
  const raw = String((data && (data.error || data.message)) || '');
  return raw.split(':')[0].trim().toUpperCase();
}

function hintFor(code) {
  if (HINT_BY_CODE[code]) return HINT_BY_CODE[code];
  if (/^HTTP_\d{3}$/.test(code)) {
    return 'the listen service answered with an error status; check its log for the upstream reason';
  }
  return HINT_BY_CODE.SERVICE_ERROR;
}

function upstreamFailure(data) {
  const code = failureCode(data) || 'SERVICE_ERROR';
  return {
    ok: false,
    code,
    message: String((data && (data.error || data.message)) || code),
    hint: hintFor(code),
  };
}

function missingSource(tool) {
  return {
    ok: false,
    code: 'MISSING_AUDIO_SOURCE',
    message: `${tool} needs one of filePath or audioBase64; neither was given, so nothing was sent.`,
    hint: HINT_BY_CODE.MISSING_AUDIO_SOURCE,
  };
}

/** 只挑真给了的字段，别把 undefined / 空串当成"该字段存在"发给上游。 */
function audioBody(args) {
  const body = {};
  const filePath = typeof args.filePath === 'string' ? args.filePath.trim() : '';
  const audioBase64 = typeof args.audioBase64 === 'string' ? args.audioBase64.trim() : '';
  const mime = typeof args.mime === 'string' ? args.mime.trim() : '';
  if (filePath) body.filePath = filePath;
  if (audioBase64) body.audioBase64 = audioBase64;
  if (mime) body.mime = mime;
  return body;
}

/**
 * 只在「上游说没收到音频」时才用：本地把文件读成 base64。
 * 为什么需要它：上游 /v1/transcribe 目前只认 base64（不像 /v1/hear 能直接读 filePath），
 * 所以只传 filePath 的话服务端会回 EMPTY_AUDIO。这里补一次，契约不用改，filePath 也真能用。
 */
async function readAudioFile(filePath) {
  try {
    const info = await stat(filePath);
    if (!info.isFile()) {
      return { ok: false, code: 'FILE_UNREADABLE', message: `not a regular file: ${filePath}` };
    }
    if (info.size > MAX_AUDIO_BYTES) {
      return {
        ok: false,
        code: 'AUDIO_TOO_LARGE',
        message: `${info.size} bytes is over the ${MAX_AUDIO_BYTES}-byte limit: ${filePath}`,
      };
    }
    const buf = await readFile(filePath);
    return {
      ok: true,
      audioBase64: buf.toString('base64'),
      mime: MIME_BY_EXT[path.extname(filePath).toLowerCase()] || '',
    };
  } catch (err) {
    return { ok: false, code: 'FILE_UNREADABLE', message: String((err && err.message) || err) };
  }
}

/**
 * 对齐对外契约：{ ok, transcript, duration, confidence }。
 * 上游 /v1/transcribe 实际返回的是 text，而且没有 duration —— 两个名字都收，
 * duration 缺就是 null，不编一个数字出来。
 */
function normalizeTranscribe(data) {
  const transcript =
    typeof data.transcript === 'string'
      ? data.transcript
      : typeof data.text === 'string'
        ? data.text
        : '';
  return {
    ok: true,
    transcript: transcript.trim(),
    duration: finiteOrNull(data.duration ?? data.durationSec),
    confidence: finiteOrNull(data.confidence),
  };
}

/**
 * 对齐对外契约：{ ok, duration, transcript, speechOk, confidence, events[], summary, truncated }。
 * 刻意不返回上游的 levels[]：那是给前端画波形的几千个数，塞进模型上下文只会把预算吃光。
 * 真要波形的人直接请求 /v1/hear 拿原始 JSON。
 */
function normalizeHear(data) {
  const transcript =
    typeof data.transcript === 'string'
      ? data.transcript
      : typeof data.text === 'string'
        ? data.text
        : '';
  const events = Array.isArray(data.events)
    ? data.events
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({
          t: String(e.t ?? ''),
          kind: String(e.kind ?? ''),
          desc: String(e.desc ?? ''),
        }))
    : [];
  return {
    ok: true,
    duration: finiteOrNull(data.duration),
    transcript: transcript.trim(),
    speechOk: Boolean(data.speechOk),
    confidence: finiteOrNull(data.confidence),
    events,
    summary: typeof data.summary === 'string' ? data.summary : '',
    truncated: Boolean(data.truncated),
  };
}

async function runTranscribe(baseUrl, body) {
  const first = await postJson(`${baseUrl}/v1/transcribe`, body, TRANSCRIBE_TIMEOUT_MS);
  if (!first.ok) return first;
  if (!first.data || first.data.ok !== false) return normalizeTranscribe(first.data || {});

  // 上游没拿到音频、而调用方只给了 filePath：本地补 base64 再试一次。
  // 注意是「先原样透传、失败才补」，所以服务端能读 filePath 时不会多传一份 40MB 的 base64。
  if (body.filePath && !body.audioBase64 && MISSING_AUDIO_ERRORS.has(failureCode(first.data))) {
    const local = await readAudioFile(body.filePath);
    if (!local.ok) {
      return { ok: false, code: local.code, message: local.message, hint: HINT_BY_CODE[local.code] };
    }
    const retryBody = { ...body, audioBase64: local.audioBase64 };
    if (!retryBody.mime && local.mime) retryBody.mime = local.mime;
    const retry = await postJson(`${baseUrl}/v1/transcribe`, retryBody, TRANSCRIBE_TIMEOUT_MS);
    if (retry.ok && retry.data && retry.data.ok !== false) return normalizeTranscribe(retry.data);
    return upstreamFailure(retry.ok ? retry.data : first.data);
  }

  return upstreamFailure(first.data);
}

async function runHear(baseUrl, body) {
  const res = await postJson(`${baseUrl}/v1/hear`, body, HEAR_TIMEOUT_MS);
  if (!res.ok) return res;
  if (res.data && res.data.ok === false) return upstreamFailure(res.data);
  return normalizeHear(res.data || {});
}

function renderFailure(tool, value) {
  if (!value) return `${tool} 调用失败：没有拿到任何返回`;
  const lines = [`${tool} 调用失败：${value.code || 'UNKNOWN'}`];
  if (value.message) lines.push(String(value.message));
  if (value.hint) lines.push(`建议：${value.hint}`);
  return lines.join('\n');
}

function renderTranscript(value) {
  const lines = [value.transcript || '（没有识别到语音：上游返回了空文本）'];
  const meta = [];
  if (typeof value.duration === 'number') meta.push(`${value.duration}s`);
  if (typeof value.confidence === 'number') meta.push(`置信度 ${value.confidence.toFixed(2)}`);
  if (meta.length) lines.push('', `—— ${meta.join(' · ')}`);
  return lines.join('\n');
}

/**
 * hear 的可读文本：summary + transcript + events。
 * 这里只组织这三样，levels 一个数字都不出现 —— 见 normalizeHear 的说明。
 */
function renderHear(value) {
  const lines = [`听感：${value.summary || '（上游没给 summary）'}`];
  if (value.truncated) lines.push('注意：只听了前面一段，后面被截断了。');
  lines.push('', `台词：${value.transcript || '（没听出成句的人话）'}`);

  if (value.events.length) {
    lines.push('', `声音事件 / 非语音声音（${value.events.length} 条）：`);
    for (const e of value.events) {
      const head = e.t ? `[${e.t}] ` : '';
      lines.push(`- ${head}${e.desc || e.kind || '（无描述）'}`);
    }
  } else {
    lines.push('', '声音事件 / 非语音声音：无（没有明显的响动或持续背景声）');
  }

  const meta = [];
  if (typeof value.duration === 'number') meta.push(`时长 ${value.duration}s`);
  if (typeof value.confidence === 'number') meta.push(`置信度 ${value.confidence.toFixed(2)}`);
  meta.push(value.speechOk ? '有人声' : '没听出人声');
  lines.push('', `—— ${meta.join(' · ')}`);
  return lines.join('\n');
}

/**
 * 两个工具的参数完全一样，但每次注册都返回一份**新的**对象：
 * 工具表可能会被上层加工（补默认值、加内部字段），共享同一个 schema 对象会让
 * 两个工具互相污染。
 */
function audioParams() {
  return {
    type: 'object',
    additionalProperties: false,
    properties: {
      filePath: {
        type: 'string',
        description:
          'Absolute path to an audio or video file on the machine running the listen service. Omit when passing audioBase64.',
      },
      audioBase64: {
        type: 'string',
        description:
          'Base64 audio bytes, optionally prefixed with data:audio/...;base64,. Omit when passing filePath.',
      },
      mime: {
        type: 'string',
        description:
          'MIME type such as audio/wav or video/mp4. Guessed from the file header or extension when omitted.',
      },
    },
  };
}

export function apply(ctx, config) {
  const baseUrl = baseUrlOf(config);

  // 注册时拿返回的 disposer，HMR 重载插件才能干净地摘掉旧工具，
  // 否则同一个名字会注册两遍。
  const disposers = [];
  const register = (tool) => {
    const dispose = ctx.tools.register(tool);
    if (typeof dispose === 'function') disposers.push(dispose);
  };

  register({
    name: 'transcribe',
    description:
      'Speech-to-text only: transcribe one audio or video file and return the words. Use it when you only need what was said, not what else is audible. Give filePath (on the machine running the listen service) or audioBase64. Returns {ok, transcript, duration, confidence}. If you also need the non-speech sounds and the overall atmosphere, call hear instead.',
    parameters: audioParams(),
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        textBlock(value && value.ok === false ? renderFailure('transcribe', value) : renderTranscript(value)),
    },
    async execute(args) {
      const body = audioBody(args || {});
      if (!body.filePath && !body.audioBase64) return missingSource('transcribe');
      try {
        return await runTranscribe(baseUrl, body);
      } catch (err) {
        // 兜底：连 postJson/文件读取都没想到的异常，也不能变成调用崩溃
        return {
          ok: false,
          code: 'PLUGIN_ERROR',
          message: String((err && err.message) || err),
          hint: 'this is a bug in dsh-listen; retry once, then report it with the message above',
        };
      }
    },
  });

  register({
    name: 'hear',
    description:
      'Hear a recording the way a person would: the transcript PLUS the non-speech sound picture — sudden bangs, sustained background sound, long silences, overall loudness, and whether the clip was cut off — folded into one sentence plus an event list. Use it when what is audible matters, not only what was said (is there music? did a door slam? is it mostly quiet?). Give filePath or audioBase64. Returns {ok, duration, transcript, speechOk, confidence, events[], summary, truncated} as readable text. Use transcribe when only the words matter; hear costs more because it also profiles the energy curve.',
    parameters: audioParams(),
    output: {
      schema: { type: 'object' },
      render: (_args, value) =>
        textBlock(value && value.ok === false ? renderFailure('hear', value) : renderHear(value)),
    },
    async execute(args) {
      const body = audioBody(args || {});
      if (!body.filePath && !body.audioBase64) return missingSource('hear');
      try {
        // hear 不需要本地补 base64：上游 /v1/hear 原生支持 filePath（还能直接吃视频容器），
        // 让服务端自己抽音轨，比在这一侧把整个文件读进内存更省。
        return await runHear(baseUrl, body);
      } catch (err) {
        return {
          ok: false,
          code: 'PLUGIN_ERROR',
          message: String((err && err.message) || err),
          hint: 'this is a bug in dsh-listen; retry once, then report it with the message above',
        };
      }
    },
  });

  return () => {
    for (const dispose of disposers) {
      try {
        dispose();
      } catch {
        // 卸载阶段单个 disposer 抛错不该拦住其余清理
      }
    }
  };
}
