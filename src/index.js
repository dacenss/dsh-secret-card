'use strict'
/**
 * dsh-secret-card — dsh 插件 · 密钥安全输入卡片
 *
 * 要解决的问题：AI 在配置过程里需要密钥（API Key / Token / 密码）时，通用做法是
 * 让 AI 调 ask_user_question 或直接要用户在对话里贴出来 —— 于是密钥永久留在会话
 * 记录里，任何能看到这段对话的人都拿得到。本插件换一条路：
 *
 *   1. AI 只调用一个工具 secret_card，描述「密钥要写到哪个文件、哪个键、什么格式、
 *      给用户看什么说明、要不要顺手验证」。参数里没有任何密钥内容。
 *   2. 宿主据此在 Web GUI 弹出一张卡片（SSE 推送 + 同源 fetch 提交）。
 *   3. 用户在卡片里输入的密钥只活在「DOM → 这一次 HTTP 请求体 → 宿主内存」这条
 *      线上，由宿主直接按格式写进配置文件（写前备份、临时文件 + rename 原子落盘）。
 *   4. 可选：宿主带着密钥去请求一个验证端点（或执行一条 stdin 传密钥的命令），
 *      把「生效 / 不生效」这一个结论返回给 AI。
 *   5. AI 收到的返回值是脱敏契约：status / validation / 文件 / 键名 / 备份名 /
 *      指纹前 8 位，**不含密钥明文**。
 *
 * 密钥不出现的所有位置（单测逐条断言）：会话记录、ctx.logger、SSE 广播、
 * HTTP 响应体、工具返回值。
 *
 * 写入格式（行级正则替换，保留原文件的注释、顺序与风格；不做 parse/stringify，
 * 避免 JSON 工具重排、丢注释、改尾逗号）：
 *   env  KEY="value"
 *   json "KEY": "value"
 *   yaml KEY: "value"（值无特殊字符时输出无引号形式）
 *   toml KEY = "value"
 */

const nodePath = require('node:path')
const nodeFs = require('node:fs')
const nodeCrypto = require('node:crypto')
const { createRequire } = require('node:module')
const { pathToFileURL } = require('node:url')
const { homedir } = require('node:os')

// ── 依赖解析（宿主 vendored schemastery 优先；缺席只损失设置 UI）───────────

// 宿主 dsh 全局安装里的 vendored 副本路径。跟随 dsh bin 的真实位置：
// process.execPath 可能指向捆绑的 node 运行时，不能从它推导；用 DSH_GLOBAL_PREFIX
// 与 ~/.local 兜底。路径形如
// <prefix>/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/<pkg>/…
function hostCandidatePaths (pkgName, rel) {
  const prefixes = [process.env.DSH_GLOBAL_PREFIX, homedir() + '/.local'].filter(Boolean)
  return prefixes.map((prefix) =>
    join(prefix, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'node_modules', '@deepseek-ai', pkgName, rel)
  )
}

const { join } = nodePath

function loadSchemasterySync () {
  for (const target of hostCandidatePaths('schemastery', 'lib/index.cjs')) {
    try { return createRequire(target)(target) } catch {}
  }
  try { return require('@deepseek-ai/schemastery') } catch {}
  return null
}

const DEFAULTS = {
  enabled: true,
  // 卡片等待用户输入的最长时间（毫秒）。到期即视为取消并关闭卡片
  timeoutMs: 180000,
  // 写入前把原文件复制成 <file>.bak-YYYYMMDD-HHmmss
  backup: true,
  // 同一文件最多保留多少份备份，超出滚动删旧
  backupKeep: 3,
  // 允许写入的文件后缀白名单。拼错路径时宁可拒绝，也不要把密钥写到莫名其妙的地方
  allowedSuffixes: ['.env', 'env', '.json', '.yaml', '.yml', '.toml'],
  // 是否允许 AI 提供「命令验证」。命令执行风险高于 HTTP 验证，默认关
  allowCommandValidation: false,
  // HTTP 验证禁止访问的主机（SSRF 护栏：本机、内网、云元数据地址）
  denyHosts: ['localhost', '127.0.0.1', '::1', '0.0.0.0', '169.254.169.254', 'metadata.google.internal'],
  // 界面语言。auto = 按本机语言识别，识别不到用英文；zh / en = 固定
  language: 'auto'
}

// 0.1.7 loader 通过 entry.fiber.runtime.Config 自动发现 schema，必须在模块顶层
// 同步构建导出。schemastery <3.18.4 没有 .volatile()：降级为无 Config，
// 设置写回不可用，但模块加载与插件运行不受影响。降级值必须是 undefined 而非
// null：宿主 settings 的 schema() 只排除 undefined，"toJSON" in null 会抛
// TypeError 逃出 describe()，拖垮整份设置文档。
function settingsSchema (Schema) {
  if (!Schema || typeof Schema.object !== 'function') return null
  return Schema.object({
    enabled: Schema.boolean().default(DEFAULTS.enabled).volatile(),
    timeoutMs: Schema.number().step(1000).min(5000).max(600000).default(DEFAULTS.timeoutMs).volatile(),
    backup: Schema.boolean().default(DEFAULTS.backup).volatile(),
    backupKeep: Schema.number().step(1).min(0).max(50).default(DEFAULTS.backupKeep).volatile(),
    allowedSuffixes: Schema.array(Schema.string()).default(DEFAULTS.allowedSuffixes).volatile(),
    allowCommandValidation: Schema.boolean().default(DEFAULTS.allowCommandValidation).volatile(),
    denyHosts: Schema.array(Schema.string()).default(DEFAULTS.denyHosts).volatile(),
    language: Schema.string().default(DEFAULTS.language).volatile()
  })
}

let Config
try { Config = settingsSchema(loadSchemasterySync()) || undefined } catch {}

// ── 常量 ───────────────────────────────────────────────────────────────────

const PLUGIN_ID = 'dsh-secret-card'
const SETTINGS_NS = PLUGIN_ID
const TOOL_NAME = 'secret_card'
const API_BASE = `/${PLUGIN_ID}/api`
const SSE_PATH = `${API_BASE}/events`
const PENDING_PATH = `${API_BASE}/pending`
const FILL_PATH = `${API_BASE}/fill`
const CANCEL_PATH = `${API_BASE}/cancel`
const MAX_BODY_BYTES = 64 * 1024
// 密钥占位符。刻意不用双花括号包裹：宿主的系统提示模板会把成对双花括号当成
// 变量引用，大写变量名会让整段 section 注册失败（实测报错里的形态就是
// malformed prompt variable reference）。%% 包裹既不可能被当成模板变量，也几乎
// 不会与真实密钥内容撞车
const SECRET_PLACEHOLDER = '%%SECRET%%'
const HTTP_TIMEOUT_MS = 15000
const COMMAND_TIMEOUT_MS = 20000
const KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/
const HEADER_NAME_PATTERN = /^[A-Za-z0-9-]+$/
// ── 多语言：按本机语言识别，英文兜底 ────────────────────────────────────────
// 所有交给宿主或用户的文案都走这张表（模型看的系统提示、工具说明、返回给模型的
// 提示、render 表格），识别不到语言一律用英文。
// 识别的两处来源：进程环境变量（Linux/macOS 的 setlocale 会写在这里）→ ICU 默认
// locale（Windows 上它反映系统区域设置）。都读不到才回落英文。

const SUPPORTED_LOCALES = ['zh', 'en']

const MESSAGES = {
  zh: {
    toolDescription: '配置过程需要用户提供密钥（API Key / Token / 密码）时调用本工具。'
      + '你只描述密钥要写入哪里：文件路径、键名、格式、给用户看的标题与说明、可选的生效性验证方式。'
      + '密钥由用户在弹出卡片里直接输入并写入文件，本工具的返回值只包含写入与验证结果，不含密钥。'
      + '参数里绝不要出现任何密钥内容；也不要让用户在对话里直接贴密钥。',
    argTarget: '密钥要写入的文件路径。绝对路径，或相对当前会话工作目录；文件必须已存在，后缀需在白名单内（.env/.json/.yaml/.yml/.toml）',
    argKey: '键名，如 OPENAI_API_KEY、ANTHROPIC_API_KEY。只允许字母数字下划线点连字符',
    argFormat: '写入格式。缺省按文件后缀推断',
    argLabel: '卡片标题，如「OpenAI API Key」',
    argHint: '给用户的说明：这个密钥是干什么的、去哪里获取。不得包含任何密钥内容',
    argValidation: '可选的生效性验证，JSON 字符串。'
      + 'HTTP：{"kind":"http","method":"GET","url":"https://api.example.com/v1/verify","header":{"Authorization":"Bearer %%SECRET%%"},"expectStatus":200,"expectBodyContains":"ok"}；'
      + '命令：{"kind":"command","argv":["npm","run","check"],"stdinTemplate":"%%SECRET%%\\n"}（密钥只走 stdin，禁止出现在 argv）。'
      + '省略表示不验证',
    argMasked: '输入框是否掩码显示，默认 true',
    argOverwrite: '键已存在时是否覆盖写入，默认 true',
    resultNote: '密钥已由用户在卡片中直接输入并写入文件；本结果不含密钥明文，也不要去读该文件的值。',
    resultTitle: '密钥写入结果',
    resultHead: '| 项 | 值 |',
    rowStatus: '状态',
    rowReason: '原因',
    rowValidation: '验证',
    rowFile: '文件',
    rowKey: '键名',
    rowBackup: '备份',
    rowFingerprint: '指纹',
    disabled: 'dsh-secret-card 已在设置中停用。',
    missingTargetKey: '缺少 target 或 key。',
    badKey: (key) => `键名不合法：${key}`,
    keyPlaceholder: '键名不得包含占位符。',
    hintPlaceholder: '说明文字不得包含占位符（占位符只允许出现在验证规格里）。',
    badTarget: '路径解析失败。',
    suffixNotAllowed: (list) => `只允许写入这些后缀的文件：${list}`,
    unknownFormat: '无法从后缀推断格式，请显式传 format（env/json/yaml/toml）。',
    busy: '已有一张卡片正等待用户输入；一次只处理一个密钥，请等结果返回后再调用。',
    labelFallback: (key) => `请输入「${key}」`,
    guidance: [
      'dsh-secret-card 已启用：配置过程需要用户提供密钥（API key / token / 密码 / webhook 密钥）时调用工具 `secret_card`，不要让用户把它贴进对话。你只描述元数据：目标文件、键名、格式、给用户看的标题与说明、可选的生效性验证方式。用户在弹出的卡片里输入密钥，插件会直接写进配置文件；若提供了验证规格，插件还会顺便检查密钥是否生效。你的工具结果只包含写入与验证结果（status、file、key、backup、fingerprint），不含密钥本身。',
      '硬性规则：',
      '- 任何密钥值都不得出现在工具参数、消息、文件名或 shell 命令里；也不得要求用户在对话里贴密钥。',
      '- 通过 `secret_card` 写入的键值不要再读回来；文件内容属于敏感信息，即使技术上能打开。',
      '- 验证规格以 JSON 字符串传入，例如 {"kind":"http","method":"GET","url":"https://api.example.com/v1/verify","header":{"Authorization":"Bearer %%SECRET%%"},"expectStatus":200}。只有占位符 %%SECRET%% 代表密钥；它只允许出现在 header 值与 bodyTemplate 里，绝不能出现在命令 argv 里。',
      '- 一次一张卡：等结果返回后再请求下一个密钥。结果为 busy 表示还有一张卡片开着。',
      '目标文件必须已存在且后缀在白名单内（.env/.json/.yaml/.yml/.toml）；未知格式需显式传 format。'
    ]
  },
  en: {
    toolDescription: 'Call this tool when a configuration task needs a secret from the user (API key, token, password, webhook secret).'
      + 'You only describe where the secret goes: target file, key name, format, a label and hint for the user, and an optional validation request.'
      + 'The user types the secret into a card that this plugin renders; the plugin writes it straight into the config file and, when you supplied a validation spec, checks whether the secret works.'
      + 'Never put a secret value in an argument, and never ask the user to paste a secret into the chat.',
    argTarget: 'File path the secret is written to. Absolute, or relative to the current session working directory. The file must already exist and its suffix must be in the whitelist (.env/.json/.yaml/.yml/.toml).',
    argKey: 'Key name, e.g. OPENAI_API_KEY or ANTHROPIC_API_KEY. Only letters, digits, underscore, dot and hyphen are allowed.',
    argFormat: 'Write format. Inferred from the file suffix when omitted.',
    argLabel: 'Card title, for example "OpenAI API Key".',
    argHint: 'Note for the user: what this secret is for and where to get it. Must not contain any secret content.',
    argValidation: 'Optional validation, as a JSON string.'
      + 'HTTP: {"kind":"http","method":"GET","url":"https://api.example.com/v1/verify","header":{"Authorization":"Bearer %%SECRET%%"},"expectStatus":200,"expectBodyContains":"ok"};'
      + 'command: {"kind":"command","argv":["npm","run","check"],"stdinTemplate":"%%SECRET%%\\n"} (the secret may only travel through stdin, never through argv).'
      + 'Omit to skip validation.',
    argMasked: 'Whether the input box masks what is typed. Defaults to true.',
    argOverwrite: 'Whether to overwrite the value when the key already exists. Defaults to true.',
    resultNote: 'The secret was typed by the user into a card and written to the file. This result contains no secret value, and you must not read the value back from the file.',
    resultTitle: 'Secret write result',
    resultHead: '| Field | Value |',
    rowStatus: 'Status',
    rowReason: 'Reason',
    rowValidation: 'Validation',
    rowFile: 'File',
    rowKey: 'Key',
    rowBackup: 'Backup',
    rowFingerprint: 'Fingerprint',
    disabled: 'dsh-secret-card is disabled in the settings.',
    missingTargetKey: 'Both target and key are required.',
    badKey: (key) => `Invalid key name: ${key}`,
    keyPlaceholder: 'The key name must not contain the placeholder.',
    hintPlaceholder: 'The hint text must not contain the placeholder (it is only allowed inside the validation spec).',
    badTarget: 'Could not resolve the path.',
    suffixNotAllowed: (list) => `Only files with these suffixes are allowed: ${list}`,
    unknownFormat: 'Cannot infer the format from the suffix. Pass format explicitly (env/json/yaml/toml).',
    busy: 'A card is already waiting for user input; only one secret is handled at a time. Wait for the result before calling again.',
    labelFallback: (key) => `Enter the secret for ${key}`,
    guidance: [
      'dsh-secret-card is active: when a configuration task needs a secret from the user (API key, token, password, webhook secret), call the tool `secret_card` instead of asking the user to paste it in chat. You only describe metadata: target file, key name, format, a label and hint for the user, and an optional validation request. The user types the secret into a card that this plugin renders; the plugin writes it straight into the config file and, when you supplied a validation spec, checks whether the secret works. Your tool result contains only the write and validation outcome (status, file, key, backup, fingerprint) — never the secret itself.',
      'Hard rules:',
      '- Never put a secret value in a tool argument, a message, a filename, or a shell command; never ask the user to paste a secret into the chat.',
      '- Never read back the value of a key you wrote through `secret_card`; the file content is sensitive even though you can technically open it.',
      '- Pass the validation spec as a JSON string, e.g. {"kind":"http","method":"GET","url":"https://api.example.com/v1/verify","header":{"Authorization":"Bearer %%SECRET%%"},"expectStatus":200}. Only the placeholder %%SECRET%% stands for the secret; it may appear in header values and bodyTemplate only, never in a command argv.',
      '- One card at a time: wait for the result before requesting another secret. A "busy" result means a card is still open.',
      'The target file must already exist and its suffix must be in the whitelist (.env/.json/.yaml/.yml/.toml); pass format explicitly when the suffix is unknown.'
    ]
  }
}

// auto → 按本机语言识别；zh / en → 固定。非法值一律 auto。
// env 可注入（测试用）：不传就读 process.env
function resolveLocale (pref, env = process.env) {
  const p = typeof pref === 'string' ? pref.trim().toLowerCase() : ''
  if (SUPPORTED_LOCALES.includes(p)) return p
  return detectLocale(env)
}

function detectLocale (env = process.env) {
  for (const name of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE']) {
    const raw = (env || {})[name]
    if (!raw) continue
    const code = String(raw).toLowerCase()
    if (code.startsWith('zh')) return 'zh'
    if (code) return 'en'
  }
  try {
    const resolved = Intl.DateTimeFormat().resolvedOptions().locale
    if (resolved) return String(resolved).toLowerCase().startsWith('zh') ? 'zh' : 'en'
  } catch {}
  return 'en'
}

function messagesFor (pref) {
  return MESSAGES[resolveLocale(pref)]
}

function guidanceFor (pref) {
  return messagesFor(pref).guidance.join('\n')
}

// ── 纯函数：配置清洗与通用小工具 ────────────────────────────────────────────

// 0.1.7 宿主 resolveConfig 会把 apply-config 里的 volatile 字段物化成 {}（实测）：
// {} 会盖掉 DEFAULTS，导致 describe 就绪前拿到毒化值。这里只保留类型与默认值
// 一致的标量/数组；真实持久化值走 describe 投影（liveSettings）。
function saneConfigValues (config, defaults) {
  const out = {}
  for (const key of Object.keys(defaults)) {
    const v = (config || {})[key]
    if (v === undefined || v === null) continue
    if (Array.isArray(defaults[key])) { if (Array.isArray(v)) out[key] = v; continue }
    if (typeof v === typeof defaults[key]) out[key] = v
  }
  return out
}

function readJsonBody (req) {
  return new Promise((fulfil, reject) => {
    let size = 0
    const chunks = []
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > MAX_BODY_BYTES) { reject(new Error('request body too large')); req.destroy(); return }
      chunks.push(chunk)
    })
    req.on('end', () => {
      try { fulfil(chunks.length === 0 ? {} : JSON.parse(Buffer.concat(chunks).toString('utf8'))) }
      catch (error) { reject(new Error(`invalid JSON body: ${error && error.message}`)) }
    })
    req.on('error', reject)
  })
}

function sendJson (res, status, payload) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(payload))
}

function sha256Hex (text) {
  return nodeCrypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

// 只取哈希前 8 位：够用户肉眼核对「就是刚才那个」，不够反推密钥
function fingerprintOf (secret) {
  return 'sha256:' + sha256Hex(secret).slice(0, 8)
}

function sseFrame (payload) {
  return `data: ${JSON.stringify(payload)}\n\n`
}

function escapeRegExp (text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function clampInt (value, min, max, fallback) {
  const n = Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.trunc(n)))
}

// ── 纯函数：格式字面量与行级改写 ────────────────────────────────────────────

// env / yaml / toml 都用双引号字面量，转义规则一致（\ " 换行 回车）
function quotedLiteral (value) {
  const v = String(value)
  const escaped = v
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\r/g, '\\r')
    .replace(/\n/g, '\\n')
  return `"${escaped}"`
}

function jsonLiteral (value) {
  return JSON.stringify(String(value))
}

// yaml 的值不含特殊字符时保持无引号的清爽写法
function yamlLiteral (value) {
  const v = String(value)
  if (/[:#\[\]{}&*!|>'"%@`,]|^[\s]|[\s]$/.test(v)) return quotedLiteral(v)
  return v
}

function detectFormat (filePath, explicit) {
  if (typeof explicit === 'string' && explicit) {
    const f = explicit.toLowerCase()
    if (f === 'env' || f === 'json' || f === 'yaml' || f === 'toml') return f
    return null
  }
  const base = nodePath.basename(filePath).toLowerCase()
  const ext = nodePath.extname(base)
  if (ext === '.json') return 'json'
  if (ext === '.yaml' || ext === '.yml') return 'yaml'
  if (ext === '.toml') return 'toml'
  if (ext === '.env' || base.startsWith('.env') || base.endsWith('env')) return 'env'
  return null
}

function literalFor (format, secret) {
  if (format === 'json') return jsonLiteral(secret)
  if (format === 'yaml') return yamlLiteral(secret)
  return quotedLiteral(secret)
}

// 四个改写函数统一返回 { text, replaced }；text 为 null 表示目标结构不识别
function replaceEnv (text, key, literal) {
  const re = new RegExp(`^([ \\t]*)${escapeRegExp(key)}([ \\t]*)=.*$`, 'm')
  if (re.test(text)) return { text: text.replace(re, `$1${key}$2=${literal}`), replaced: true }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  return { text: `${text}${sep}${key}=${literal}\n`, replaced: false }
}

function replaceToml (text, key, literal) {
  const re = new RegExp(`^([ \\t]*)${escapeRegExp(key)}([ \\t]*)=.*$`, 'm')
  if (re.test(text)) return { text: text.replace(re, `$1${key}$2= ${literal}`), replaced: true }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  return { text: `${text}${sep}${key} = ${literal}\n`, replaced: false }
}

function replaceYaml (text, key, literal) {
  const re = new RegExp(`^([ \\t]*)${escapeRegExp(key)}([ \\t]*):.*$`, 'm')
  if (re.test(text)) return { text: text.replace(re, `$1${key}$2: ${literal}`), replaced: true }
  const sep = text.length === 0 || text.endsWith('\n') ? '' : '\n'
  return { text: `${text}${sep}${key}: ${literal}\n`, replaced: false }
}

// JSON 只做「找到键所在那一行再替换整行」，不做 parse/stringify：原文件的注释、
// 键顺序、缩进风格、尾逗号都原样保留。v1 只处理根级键
function replaceJson (text, key, literal) {
  const strVal = new RegExp(`^([ \\t]*)"${escapeRegExp(key)}"([ \\t]*):[ \\t]*"(?:[^"\\\\]|\\\\.)*"[ \\t]*(,?)[ \\t]*$`, 'm')
  if (strVal.test(text)) return { text: text.replace(strVal, `$1"${key}"$2: ${literal}$3`), replaced: true }
  const anyVal = new RegExp(`^([ \\t]*)"${escapeRegExp(key)}"([ \\t]*):[ \\t]*(?:"(?:[^"\\\\]|\\\\.)*"|'[^']*'|-?\\d+(?:\\.\\d+)?(?:[eE][-+]?\\d+)?|true|false|null|\\{[^{}\\n]*\\}|\\[[^\\[\\]\\n]*\\])[ \\t]*(,?)[ \\t]*$`, 'm')
  if (anyVal.test(text)) return { text: text.replace(anyVal, `$1"${key}"$2: ${literal}$3`), replaced: true }

  // 键不存在：插到最外层对象的最后一个键之后（继承缩进、必要时补逗号，且不得
  // 留下尾逗号）；没有键行则插到第一个 { 之后；两者都没有说明这不是 JSON 对象
  // 结构。嵌套对象的键行缩进更深，按最小缩进定位最外层，避免把根键插进嵌套里
  const lines = text.split('\n')
  const anyKey = /^([ \t]*)"[^"\n]*"[ \t]*:/
  const keyLines = []
  for (let i = 0; i < lines.length; i++) {
    const m = lines[i].match(anyKey)
    if (m) keyLines.push({ index: i, indent: m[1] })
  }
  let target = null
  if (keyLines.length > 0) {
    const minIndent = keyLines.reduce((min, entry) => (entry.indent.length < min.length ? entry.indent : min), keyLines[0].indent)
    const outer = keyLines.filter((entry) => entry.indent === minIndent)
    target = outer[outer.length - 1]
  }
  // 下一行是闭合括号/空行 ⇒ 插入的将是最后一个成员，不能带尾逗号
  const isLastMember = (index) => {
    const next = lines[index + 1]
    return next === undefined || /^\s*\}?,?\s*$/.test(next)
  }
  if (target) {
    if (!/,\s*$/.test(lines[target.index])) lines[target.index] = lines[target.index].replace(/\s*$/, '') + ','
    const comma = isLastMember(target.index) ? '' : ','
    lines.splice(target.index + 1, 0, `${target.indent}"${key}": ${literal}${comma}`)
    return { text: lines.join('\n'), replaced: false }
  }
  const brace = lines.findIndex((line) => /\{/.test(line))
  if (brace < 0) return { text: null, replaced: false }
  const comma = isLastMember(brace) ? '' : ','
  lines.splice(brace + 1, 0, `  "${key}": ${literal}${comma}`)
  return { text: lines.join('\n'), replaced: false }
}

function rewriteConfig (format, text, key, literal) {
  if (format === 'json') return replaceJson(text, key, literal)
  if (format === 'yaml') return replaceYaml(text, key, literal)
  if (format === 'toml') return replaceToml(text, key, literal)
  return replaceEnv(text, key, literal)
}

function backupStamp (date) {
  const p = (n) => String(n).padStart(2, '0')
  const p3 = (n) => String(n).padStart(3, '0')
  // 带毫秒：同一秒内连续写多个键时备份名不互相覆盖
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}${p3(date.getMilliseconds())}`
}

// 备份命名 <file>.bak-<stamp>；按名字排序滚动删除旧备份，保留 backupKeep 份
function makeBackup (filePath, backupKeep) {
  const stamp = backupStamp(new Date())
  const backupPath = `${filePath}.bak-${stamp}`
  nodeFs.copyFileSync(filePath, backupPath)
  const keep = clampInt(backupKeep, 0, 50, 3)
  if (keep <= 0) return backupPath
  const dir = nodePath.dirname(filePath)
  const prefix = `${nodePath.basename(filePath)}.bak-`
  let siblings = []
  try { siblings = nodeFs.readdirSync(dir) } catch { return backupPath }
  const mine = siblings
    .filter((name) => name.startsWith(prefix))
    .map((name) => ({ name, path: nodePath.join(dir, name) }))
    .sort((a, b) => (a.name < b.name ? 1 : -1))
  for (const old of mine.slice(keep)) {
    try { nodeFs.unlinkSync(old.path) } catch {}
  }
  return backupPath
}

// 写密钥：读原文 → 备份 → 行级改写 → 临时文件 + rename 原子落盘 → 读回校验。
// 返回值只含状态与元信息，绝不回显密钥
function writeSecret (options) {
  const { filePath, format, key, secret, backup, backupKeep, overwrite } = options
  let original
  try {
    original = nodeFs.readFileSync(filePath, 'utf8')
  } catch (error) {
    if (error && error.code === 'ENOENT') return { status: 'failed', reason: 'file_missing' }
    return { status: 'failed', reason: 'read_failed' }
  }

  const literal = literalFor(format, secret)
  const rewritten = rewriteConfig(format, original, key, literal)
  if (rewritten === null || typeof rewritten.text !== 'string') {
    return { status: 'failed', reason: 'rewrite_failed' }
  }
  // overwrite=false 只阻止「覆盖已有键」；键不存在时的追加始终允许
  if (rewritten.replaced && overwrite === false) {
    return { status: 'failed', reason: 'key_exists' }
  }

  let backupPath
  if (backup === true) {
    try { backupPath = makeBackup(filePath, backupKeep) } catch { backupPath = undefined }
  }

  const tmpPath = `${filePath}.tmp-${process.pid}-${Date.now()}`
  try {
    nodeFs.writeFileSync(tmpPath, rewritten.text, 'utf8')
    nodeFs.renameSync(tmpPath, filePath)
  } catch {
    try { nodeFs.unlinkSync(tmpPath) } catch {}
    return { status: 'failed', reason: 'write_failed' }
  }

  // 读回校验：确认键确实落盘（防止 rename 到意外位置、或改写逻辑漏匹配）
  let back
  try {
    back = nodeFs.readFileSync(filePath, 'utf8')
  } catch {
    return { status: 'failed', reason: 'verify_failed' }
  }
  if (back === rewritten.text && rewritten.replaced === true) return { status: 'written', backup: backupPath }
  if (back.includes(literal)) return { status: 'written', backup: backupPath }
  return { status: 'failed', reason: 'verify_mismatch' }
}

// ── 纯函数：验证规格解析 ───────────────────────────────────────────────────

// AI 传进来的 validation 参数（JSON 字符串或对象）→ 白名单化后的规格对象。
// 任何不认识的形状一律降级为 none，不影响写入结果本身
function parseValidationSpec (raw) {
  if (raw === undefined || raw === null || raw === '') return { kind: 'none' }
  let spec = raw
  if (typeof raw === 'string') {
    try { spec = JSON.parse(raw) } catch { return { kind: 'none', detail: 'bad_validation_json' } }
  }
  if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return { kind: 'none', detail: 'bad_validation_json' }
  const kind = typeof spec.kind === 'string' ? spec.kind.toLowerCase() : ''
  if (kind === 'http') {
    const url = typeof spec.url === 'string' ? spec.url.trim() : ''
    if (!url) return { kind: 'none', detail: 'bad_validation_json' }
    const method = typeof spec.method === 'string' ? spec.method.toUpperCase() : 'GET'
    if (!['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD'].includes(method)) {
      return { kind: 'none', detail: 'bad_validation_json' }
    }
    const header = {}
    if (spec.header && typeof spec.header === 'object') {
      for (const [name, value] of Object.entries(spec.header)) {
        if (!HEADER_NAME_PATTERN.test(name)) continue
        if (typeof value !== 'string' && typeof value !== 'number') continue
        header[name] = String(value)
      }
    }
    const expectStatus = Array.isArray(spec.expectStatus)
      ? spec.expectStatus.map((n) => Number(n)).filter((n) => Number.isFinite(n))
      : (spec.expectStatus === undefined || spec.expectStatus === null ? [200] : (Number.isFinite(Number(spec.expectStatus)) ? [Number(spec.expectStatus)] : [200]))
    return {
      kind: 'http',
      url,
      method,
      header,
      bodyTemplate: typeof spec.bodyTemplate === 'string' ? spec.bodyTemplate : '',
      contentType: typeof spec.contentType === 'string' ? spec.contentType : 'application/json',
      expectStatus: expectStatus.length > 0 ? expectStatus : [200],
      expectBodyContains: typeof spec.expectBodyContains === 'string' ? spec.expectBodyContains : '',
      timeoutMs: clampInt(spec.timeoutMs, 1000, 60000, HTTP_TIMEOUT_MS)
    }
  }
  if (kind === 'command') {
    if (!Array.isArray(spec.argv) || spec.argv.length === 0 || spec.argv.some((a) => typeof a !== 'string' || a === '')) {
      return { kind: 'none', detail: 'bad_validation_json' }
    }
    return {
      kind: 'command',
      argv: spec.argv.map((a) => String(a)),
      stdinTemplate: typeof spec.stdinTemplate === 'string' ? spec.stdinTemplate : `${SECRET_PLACEHOLDER}\n`,
      timeoutMs: clampInt(spec.timeoutMs, 1000, 120000, COMMAND_TIMEOUT_MS)
    }
  }
  return { kind: 'none' }
}

// SSRF 护栏：目标主机命中拒绝名单（本机 / 内网 / 云元数据）时不让密钥出门
function isHostDenied (url, denyHosts) {
  const host = url.hostname.toLowerCase()
  const denied = Array.isArray(denyHosts) ? denyHosts : []
  for (const raw of denied) {
    const entry = String(raw || '').trim().toLowerCase()
    if (!entry) continue
    if (host === entry || host.endsWith(`.${entry}`)) return true
  }
  return false
}

function substitutePlaceholder (template, secret) {
  return String(template).split(SECRET_PLACEHOLDER).join(secret)
}

// HTTP 验证：密钥只进 header 值 / body；响应体读完即弃，只回结论
async function validateHttp (spec, secret, cfg) {
  const fetchFn = globalThis.fetch
  if (typeof fetchFn !== 'function') return { validation: 'failed', validationDetail: 'fetch_unavailable' }
  let url
  try { url = new URL(spec.url) } catch { return { validation: 'failed', validationDetail: 'bad_url' } }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { validation: 'failed', validationDetail: 'bad_scheme' }
  }
  if (isHostDenied(url, cfg.denyHosts)) return { validation: 'failed', validationDetail: 'denied_host' }

  const headers = {}
  for (const [name, value] of Object.entries(spec.header)) {
    headers[name] = substitutePlaceholder(value, secret)
  }
  let body
  if (spec.bodyTemplate) {
    body = substitutePlaceholder(spec.bodyTemplate, secret)
    if (!Object.keys(headers).some((k) => k.toLowerCase() === 'content-type')) {
      headers['Content-Type'] = spec.contentType
    }
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), spec.timeoutMs)
  try {
    const res = await fetchFn(spec.url, {
      method: spec.method,
      headers,
      body,
      redirect: 'manual', // 跟随重定向会把密钥带到第二个主机，SSRF 护栏会失效
      signal: controller.signal
    })
    if (!spec.expectStatus.includes(res.status)) {
      return { validation: 'failed', validationDetail: `http ${res.status} not in [${spec.expectStatus.join(',')}]` }
    }
    if (spec.expectBodyContains) {
      const text = await res.text() // 本地变量，用完即弃，绝不进入返回值
      if (!text.includes(spec.expectBodyContains)) {
        return { validation: 'failed', validationDetail: 'expect_body_mismatch' }
      }
    }
    return { validation: 'passed', validationDetail: `http ${res.status}` }
  } catch (error) {
    const aborted = error && (error.name === 'AbortError' || /abort/i.test(String(error.message || '')))
    return { validation: 'failed', validationDetail: aborted ? 'http_timeout' : 'http_error' }
  } finally {
    clearTimeout(timer)
  }
}

// 命令验证：密钥只走 stdin；argv 出现占位符一律拒绝（进程列表会公开密钥）
function validateCommand (spec, secret, cfg) {
  if (cfg.allowCommandValidation !== true) {
    return Promise.resolve({ validation: 'failed', validationDetail: 'command_not_allowed' })
  }
  if (spec.argv.join(' ').includes(SECRET_PLACEHOLDER)) {
    return Promise.resolve({ validation: 'failed', validationDetail: 'secret_in_argv' })
  }
  const stdin = substitutePlaceholder(spec.stdinTemplate, secret)
  const { spawn } = require('node:child_process')
  return new Promise((resolve) => {
    let settled = false
    const child = spawn(spec.argv[0], spec.argv.slice(1), {
      stdio: ['pipe', 'ignore', 'ignore'], // 输出丢弃：不进入返回值、不进入日志
      windowsHide: true
    })
    const timer = setTimeout(() => {
      if (settled) return
      settled = true
      try { child.kill() } catch {}
      resolve({ validation: 'failed', validationDetail: 'command_timeout' })
    }, spec.timeoutMs)
    const done = (result) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    child.on('error', () => done({ validation: 'failed', validationDetail: 'spawn_error' }))
    child.on('close', (code) => done(code === 0
      ? { validation: 'passed', validationDetail: 'exit 0' }
      : { validation: 'failed', validationDetail: `exit ${typeof code === 'number' ? code : 'unknown'}` }))
    try {
      child.stdin.write(stdin)
      child.stdin.end()
    } catch {
      done({ validation: 'failed', validationDetail: 'stdin_failed' })
    }
  })
}

async function validateSecret (spec, secret, cfg) {
  if (!spec || spec.kind === 'none') {
    return { validation: 'skipped', validationDetail: spec && spec.detail ? spec.detail : 'no_validation' }
  }
  if (spec.kind === 'http') return validateHttp(spec, secret, cfg)
  if (spec.kind === 'command') return validateCommand(spec, secret, cfg)
  return { validation: 'skipped', validationDetail: 'no_validation' }
}

// ── 给模型的系统提示走 MESSAGES[locale].guidance，见上面「多语言」一节 ─────────

// ── 插件本体 ────────────────────────────────────────────────────────────────

function apply (ctx, config = {}) {
  return Promise.resolve(applyAsync(ctx, config))
}

async function applyAsync (ctx, config = {}) {
  const trace = (event, data) => {
    // 只打元信息：requestId / 文件 / 键名 / 状态。任何分支不得打密钥、请求体、
    // 写出的整行值或验证响应体
    const line = `[${PLUGIN_ID}] ${event} ${data ? JSON.stringify(data) : ''}`
    try { ctx.logger.info(line) } catch {}
    try { console.error(`[trace] ${line}`) } catch {}
  }
  const warn = (message) => {
    const line = `[${PLUGIN_ID}] ${message}`
    try { ctx.logger.warn(line) } catch {}
    try { console.error(`[warn] ${line}`) } catch {}
  }

  // ── 配置接线（对齐 smart-title：base + describe 投影 + 进程内兜底）──
  const base = { ...DEFAULTS, ...saneConfigValues(config, DEFAULTS) }
  let liveSettings = {}
  const memoryPatch = {}
  const readDescriptor = () => {
    try {
      if (!ctx.settings || typeof ctx.settings.describe !== 'function') return null
      return ctx.settings.describe().find((x) => x.ns === SETTINGS_NS) || null
    } catch { return null }
  }
  const refreshLive = (attempt = 0) => {
    const d = readDescriptor()
    if (d) {
      if (d.value && typeof d.value === 'object') liveSettings = d.value
      return
    }
    if (attempt < 15) setTimeout(() => { refreshLive(attempt + 1) }, 2000).unref?.()
  }
  refreshLive()
  const effective = () => ({ ...base, ...liveSettings, ...memoryPatch })
  // 当前语言的文案表：每次现取，设置里改 language 立刻生效
  const msg = () => messagesFor(effective().language)

  try {
    ctx.effect(() => {
      const off = ctx.on('settings/document-updated', (ns) => {
        if (ns !== SETTINGS_NS) return
        const d = readDescriptor()
        if (d && d.value && typeof d.value === 'object') liveSettings = d.value
      })
      return () => { try { off() } catch {} }
    }, `${PLUGIN_ID}: settings watch`)
  } catch { /* 事件订阅不可用：写回后靠 memoryPatch 维持本次运行 */ }

  // ── 运行时状态 ──
  const hub = new Set()       // SSE 连接（res 对象）
  const pending = new Map()   // requestId → 卡片记录
  const bySignature = new Map() // signature → requestId（合并重复请求）
  const completed = new Map() // signature → {file, key}（仅用于卡片提示，不存任何密钥派生值）
  let busy = false

  const broadcast = (payload) => {
    const frame = sseFrame(payload)
    for (const res of [...hub]) {
      try { res.write(frame) } catch { hub.delete(res) }
    }
  }

  const publicCard = (record) => ({
    type: 'card.request',
    requestId: record.requestId,
    sessionId: record.sessionId,
    label: record.card.label,
    hint: record.card.hint,
    file: record.card.file,
    key: record.card.key,
    format: record.card.format,
    masked: record.card.masked,
    willValidate: record.validation && record.validation.kind !== 'none',
    seenBefore: completed.has(record.signature),
    // 卡片寿命：客户端照着显示倒计时，到点自己收掉，与宿主超时对齐
    expiresAt: record.deadline
  })

  const currentCards = (sessionId) => [...pending.values()]
    .filter((r) => !sessionId || r.sessionId === undefined || r.sessionId === sessionId)
    .map(publicCard)

  const resultOf = (record, extra) => ({
    status: extra.status,
    ...(extra.reason ? { reason: extra.reason } : {}),
    ...(extra.validation ? { validation: extra.validation } : { validation: 'skipped' }),
    ...(extra.validationDetail ? { validationDetail: extra.validationDetail } : {}),
    file: record.card.file,
    key: record.card.key,
    ...(extra.backup ? { backup: extra.backup } : {}),
    ...(extra.fingerprint ? { fingerprint: extra.fingerprint } : {}),
    note: msg().resultNote
  })

  // ── SSE 路由（exact）──
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: SSE_PATH,
      handler: (req, res) => {
        const rejection = requestRejection(ctx, req)
        if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
          'x-accel-buffering': 'no'
        })
        res.write(': connected\n\n')
        hub.add(res)
        // 连接建立即补推当前卡片：消掉「SSE 连上之前广播已发完」的竞态
        for (const card of currentCards(undefined)) {
          try { res.write(sseFrame(card)) } catch { break }
        }
        const ping = setInterval(() => { try { res.write(': ping\n\n') } catch {} }, 30000)
        const close = () => { clearInterval(ping); hub.delete(res) }
        res.on('close', close)
        res.on('error', close)
      }
    }), `${PLUGIN_ID}: sse route`)
  }

  // ── API 路由（prefix）──
  if (ctx.webServer && typeof ctx.webServer.register === 'function') {
    ctx.effect(() => ctx.webServer.register({
      kind: 'prefix',
      path: API_BASE,
      handler: async (req, res) => {
        const rejection = requestRejection(ctx, req)
        if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
        try {
          const url = new URL(req.url || '/', 'http://dsh.local')
          const apiPath = url.pathname.replace(/\/+$/, '')
          const cfg = effective()

          // GET /pending?sessionId=… — 重连/晚加入的页面补齐当前卡片。
          // 读不到会话不报错也不清任何宿主状态，只是给出能拿到的列表
          if (req.method === 'GET' && apiPath.endsWith(PENDING_PATH)) {
            const sid = url.searchParams.get('sessionId')
            sendJson(res, 200, { requests: currentCards(sid || undefined) })
            return
          }

          // POST /fill — 用户提交密钥。密钥在这一段请求体里活着，出了作用域就只剩
          // 已写入的文件与一条脱敏结论
          if (req.method === 'POST' && apiPath.endsWith(FILL_PATH)) {
            const body = await readJsonBody(req)
            const requestId = typeof body.requestId === 'string' ? body.requestId : ''
            const secret = typeof body.secret === 'string' ? body.secret : ''
            if (!requestId || !secret) {
              sendJson(res, 400, { ok: false, error: 'missing requestId or secret' })
              return
            }
            const record = pending.get(requestId)
            if (!record || record.done) {
              sendJson(res, 404, { ok: false, error: 'request_not_found' })
              return
            }
            trace('fill', { requestId, file: record.card.file, key: record.card.key, secretLength: secret.length })

            const write = writeSecret({
              filePath: record.card.file,
              format: record.card.format,
              key: record.card.key,
              secret,
              backup: cfg.backup,
              backupKeep: cfg.backupKeep,
              overwrite: record.overwrite
            })
            if (write.status !== 'written') {
              const result = resultOf(record, { status: 'failed', reason: write.reason })
              // 先回卡片、再结算工具：宿主打包结果时若出错，也不该把用户晾在
              // 「正在写入…」的卡片前（bug：输入密码后卡片不消失）
              sendJson(res, 200, { ok: false, status: 'failed', reason: write.reason })
              record.finish(result)
              return
            }

            const v = await validateSecret(record.validation, secret, cfg)
            const result = resultOf(record, {
              status: 'written',
              validation: v.validation,
              validationDetail: v.validationDetail,
              backup: write.backup,
              fingerprint: fingerprintOf(secret)
            })
            sendJson(res, 200, {
              ok: true,
              status: 'written',
              validation: v.validation,
              validationDetail: v.validationDetail
            })
            record.finish(result)
            return
          }

          // POST /cancel — 用户在卡片上点取消
          if (req.method === 'POST' && apiPath.endsWith(CANCEL_PATH)) {
            const body = await readJsonBody(req)
            const requestId = typeof body.requestId === 'string' ? body.requestId : ''
            const record = pending.get(requestId)
            if (!record || record.done) {
              sendJson(res, 404, { ok: false, error: 'request_not_found' })
              return
            }
            trace('cancel', { requestId })
            record.finish(resultOf(record, { status: 'cancelled', reason: 'user_cancelled' }))
            sendJson(res, 200, { ok: true })
            return
          }

          // GET /status — 设置页与排查用
          if (req.method === 'GET' && apiPath.endsWith(`${API_BASE}/status`)) {
            sendJson(res, 200, {
              armed: true,
              pending: pending.size,
              clients: hub.size,
              settings: safeSettings(effective())
            })
            return
          }

          // PUT /settings — 设置页写回（持久化进 profile patch）
          if (req.method === 'PUT' && apiPath.endsWith(`${API_BASE}/settings`)) {
            const body = await readJsonBody(req)
            const patch = sanitizePatch(body)
            Object.assign(memoryPatch, patch)
            if (ctx.settings && typeof ctx.settings.update === 'function') {
              try { await ctx.settings.update(SETTINGS_NS, patch) }
              catch (error) { warn(`settings update 失败（仅本次运行生效）: ${(error && error.message) || error}`) }
            }
            trace('settings-updated', { keys: Object.keys(patch) })
            sendJson(res, 200, { settings: safeSettings(effective()) })
            return
          }

          sendJson(res, 404, { error: 'not found' })
        } catch (error) {
          sendJson(res, 400, { error: String((error && error.message) || error) })
        }
      }
    }), `${PLUGIN_ID}: api route`)
  }

  // ── 工具注册 ──
  if (ctx.tools && typeof ctx.tools.register === 'function') {
    ctx.effect(() => ctx.tools.register({
      name: TOOL_NAME,
      description: msg().toolDescription,
      parameters: {
        type: 'object',
        properties: {
          target: {
            type: 'string',
            description: msg().argTarget
          },
          key: {
            type: 'string',
            description: msg().argKey
          },
          format: {
            type: 'string',
            enum: ['env', 'json', 'yaml', 'toml'],
            description: msg().argFormat
          },
          label: {
            type: 'string',
            description: msg().argLabel
          },
          hint: {
            type: 'string',
            description: msg().argHint
          },
          validation: {
            type: 'string',
            description: msg().argValidation
          },
          masked: {
            type: 'boolean',
            description: msg().argMasked
          },
          overwrite: {
            type: 'boolean',
            description: msg().argOverwrite
          }
        },
        required: ['target', 'key']
      },
      output: {
        schema: {
          type: 'object',
          properties: {
            status: { type: 'string' },
            reason: { type: 'string' },
            validation: { type: 'string' },
            validationDetail: { type: 'string' },
            file: { type: 'string' },
            key: { type: 'string' },
            backup: { type: 'string' },
            fingerprint: { type: 'string' },
            note: { type: 'string' }
          }
        },
        // 契约（对齐 dsh-plugin-manager/lib/types/tools.js:28 与 dsh-mcp-manager
        // lib/index.js:7261）：render(args, value) 必须返回内容块数组
        // [{type:'text', text}]，返回裸字符串会让宿主在打包结果时崩
        // （实测：content.some is not a function）。第二个参数才是 execute 的
        // 返回值，第一个是本次调用的入参
        render: (_args, value) => {
          const p = (value && typeof value === 'object') ? value : {}
          const m = msg()
          const rows = [
            [m.rowStatus, p.status],
            [p.reason ? m.rowReason : m.rowValidation, p.reason || `${p.validation || 'skipped'}${p.validationDetail ? ` (${p.validationDetail})` : ''}`],
            [m.rowFile, p.file],
            [m.rowKey, p.key],
            [p.backup ? m.rowBackup : null, p.backup],
            [p.fingerprint ? m.rowFingerprint : null, p.fingerprint]
          ].filter((row) => row[0] && row[1])
          const table = [m.resultHead, '| --- | --- |', ...rows.map(([k, v]) => `| ${k} | ${String(v).replace(/\|/g, '\\|')} |`)].join('\n')
          return [{ type: 'text', text: `**${m.resultTitle}**\n\n${table}\n\n${p.note || m.resultNote}` }]
        }
      },
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const cfg = effective()
        const m = msg()
        if (cfg.enabled !== true) {
          return { status: 'failed', reason: 'disabled', note: m.disabled }
        }
        const fail = (reason, note) => ({ status: 'failed', reason, note: note || reason })

        // ── 参数与目标文件 ──
        const target = typeof args.target === 'string' ? args.target.trim() : ''
        const key = typeof args.key === 'string' ? args.key.trim() : ''
        if (!target || !key) return fail('bad_request', m.missingTargetKey)
        if (!KEY_PATTERN.test(key)) return fail('bad_key', m.badKey(key))
        if (key.includes(SECRET_PLACEHOLDER)) return fail('bad_key', m.keyPlaceholder)
        if (typeof args.hint === 'string' && args.hint.includes(SECRET_PLACEHOLDER)) {
          return fail('bad_hint', m.hintPlaceholder)
        }

        const cwd = exec && exec.agent && exec.agent.session && exec.agent.session.header
          ? exec.agent.session.header.cwd
          : undefined
        let filePath
        try {
          filePath = nodePath.resolve(typeof cwd === 'string' && cwd ? cwd : process.cwd(), target)
        } catch {
          return fail('bad_target', m.badTarget)
        }
        const suffixes = (Array.isArray(cfg.allowedSuffixes) ? cfg.allowedSuffixes : DEFAULTS.allowedSuffixes)
          .map((s) => String(s || '').toLowerCase()).filter(Boolean)
        const lowerPath = filePath.toLowerCase()
        if (!suffixes.some((s) => lowerPath.endsWith(s))) {
          return fail('suffix_not_allowed', m.suffixNotAllowed(suffixes.join(' ')))
        }
        const format = detectFormat(filePath, args.format)
        if (!format) return fail('unknown_format', m.unknownFormat)

        const sessionId = exec && exec.agent && exec.agent.session && typeof exec.agent.session.id === 'string'
          ? exec.agent.session.id
          : undefined
        const signature = sha256Hex([sessionId || 'no-session', filePath, key].join('|'))

        // ── 幂等：同一会话对同一文件同一键的重复请求合并到同一张卡 ──
        const liveId = bySignature.get(signature)
        if (liveId) {
          const live = pending.get(liveId)
          if (live && !live.done) {
            trace('merged', { requestId: live.requestId, file: filePath, key })
            return live.promise
          }
        }

        if (busy) {
          return {
            status: 'busy',
            file: filePath,
            key,
            note: m.busy
          }
        }

        const validation = parseValidationSpec(args.validation)
        const masked = args.masked !== false
        const overwrite = args.overwrite !== false
        const label = typeof args.label === 'string' && args.label.trim()
          ? args.label.trim()
          : m.labelFallback(key)
        const hint = typeof args.hint === 'string' ? args.hint.trim() : ''

        // ── 建卡并等待 ──
        busy = true
        const requestId = nodeCrypto.randomUUID().slice(0, 8)
        let record
        const promise = new Promise((resolve) => {
          record = {
            requestId,
            signature,
            sessionId,
            card: { label, hint, file: filePath, key, format, masked },
            validation,
            overwrite,
            done: false,
            resolve,
            finish: null
          }
          record.finish = (result) => {
            if (record.done) return
            record.done = true
            clearTimeout(record.timer)
            const signal = record.execSignal
            if (signal && typeof signal.removeEventListener === 'function') {
              try { signal.removeEventListener('abort', record.onAbort) } catch {}
            }
            pending.delete(requestId)
            bySignature.delete(signature)
            busy = false
            if (result.status === 'written' || result.status === 'already-written') {
              if (completed.size > 200) completed.clear()
              completed.set(signature, { file: record.card.file, key: record.card.key })
            }
            broadcast({ type: 'card.result', requestId, status: result.status })
            trace('settled', { requestId, file: record.card.file, key: record.card.key, status: result.status, validation: result.validation })
            resolve(result)
          }

          const waitMs = clampInt(cfg.timeoutMs, 5000, 600000, DEFAULTS.timeoutMs)
          record.deadline = Date.now() + waitMs
          record.timer = setTimeout(() => {
            broadcast({ type: 'card.cancel', requestId, reason: 'timeout' })
            record.finish(resultOf(record, { status: 'timeout', reason: 'timeout' }))
          }, waitMs)
          if (record.timer && typeof record.timer.unref === 'function') record.timer.unref()

          const signal = exec && exec.signal
          record.execSignal = signal
          if (signal && typeof signal.addEventListener === 'function') {
            record.onAbort = () => {
              broadcast({ type: 'card.cancel', requestId, reason: 'aborted' })
              record.finish(resultOf(record, { status: 'aborted', reason: 'aborted' }))
            }
            if (signal.aborted) record.onAbort()
            else signal.addEventListener('abort', record.onAbort)
          }

          pending.set(requestId, record)
          bySignature.set(signature, requestId)
          broadcast(publicCard(record))
          trace('card-requested', {
            requestId,
            file: filePath,
            key,
            format,
            willValidate: validation.kind !== 'none',
            sessionId: sessionId || 'unknown'
          })
        })

        record.promise = promise
        return promise
      }
    }), `${PLUGIN_ID}: tool`)
  }

  // ── 系统提示：告诉 AI 走这条路并且别越界 ──
  if (ctx.systemPrompt && typeof ctx.systemPrompt.section === 'function') {
    try {
      const dispose = ctx.systemPrompt.section({
        name: `plugin:${PLUGIN_ID}`,
        order: 170,
        text: guidanceFor(effective().language)
      })
      if (typeof dispose === 'function') {
        ctx.effect(() => dispose, `${PLUGIN_ID}: prompt section`)
      }
    } catch (error) {
      warn(`systemPrompt.section 失败: ${(error && error.message) || error}`)
    }
  }

  trace('armed', {
    pid: process.pid,
    hasConfig: Boolean(Config),
    hasClientRoute: Boolean(ctx.webServer && typeof ctx.webServer.register === 'function'),
    hasTool: Boolean(ctx.tools && typeof ctx.tools.register === 'function'),
    suffixes: effective().allowedSuffixes
  })
}

// ── 小工具函数（apply 作用域之外也要用）────────────────────────────────────

// 同其它 host 路由一致的信任栅栏：connection 服务的 Host/Origin 检查加浏览器
// 认证，防止本机任意网页跨站调用。服务缺席时不做额外拦截（宿主本身只应绑
// loopback）
function requestRejection (ctx, req) {
  try {
    if (ctx.connection && typeof ctx.connection.requestRejection === 'function') {
      return ctx.connection.requestRejection(req)
    }
  } catch {}
  return undefined
}

function safeSettings (cfg) {
  return {
    enabled: cfg.enabled === true,
    timeoutMs: cfg.timeoutMs,
    backup: cfg.backup === true,
    backupKeep: cfg.backupKeep,
    allowedSuffixes: Array.isArray(cfg.allowedSuffixes) ? cfg.allowedSuffixes.slice() : [],
    allowCommandValidation: cfg.allowCommandValidation === true,
    denyHosts: Array.isArray(cfg.denyHosts) ? cfg.denyHosts.slice() : []
  }
}

// 只接受与 DEFAULTS 类型一致的字段，其余丢弃（设置页 PUT 的白名单清洗）
function sanitizePatch (body) {
  const patch = {}
  if (!body || typeof body !== 'object') return patch
  for (const key of Object.keys(DEFAULTS)) {
    if (!(key in body)) continue
    const value = body[key]
    const fallback = DEFAULTS[key]
    if (Array.isArray(fallback)) { if (Array.isArray(value)) patch[key] = value; continue }
    if (fallback === null) continue
    if (typeof value === typeof fallback) patch[key] = value
  }
  if ('denyHosts' in patch) {
    patch.denyHosts = (patch.denyHosts || []).map((s) => String(s || '').trim()).filter(Boolean)
  }
  if ('language' in patch) {
    const v = String(patch.language || '').trim().toLowerCase()
    patch.language = SUPPORTED_LOCALES.includes(v) ? v : 'auto'
  }
  if ('allowedSuffixes' in patch) {
    patch.allowedSuffixes = (patch.allowedSuffixes || []).map((s) => String(s || '').trim().toLowerCase()).filter(Boolean)
  }
  return patch
}

module.exports = {
  name: PLUGIN_ID,
  inject: ['tools', 'webServer', 'systemPrompt', 'connection', 'settings'],
  Config: Config ?? undefined,
  __internals: {
    DEFAULTS,
    TOOL_NAME,
    SUPPORTED_LOCALES,
    MESSAGES,
    detectLocale,
    resolveLocale,
    messagesFor,
    guidanceFor,
    SECRET_PLACEHOLDER,
    saneConfigValues,
    sanitizePatch,
    safeSettings,
    readJsonBody,
    sendJson,
    sha256Hex,
    fingerprintOf,
    sseFrame,
    escapeRegExp,
    detectFormat,
    literalFor,
    replaceEnv,
    replaceJson,
    replaceYaml,
    replaceToml,
    rewriteConfig,
    writeSecret,
    parseValidationSpec,
    isHostDenied,
    validateSecret,
    clampInt
  },
  apply
}
