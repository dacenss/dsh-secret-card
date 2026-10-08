import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { EventEmitter } from 'node:events'

const require = createRequire(import.meta.url)
const host = require('../src/index.js')
const client = require('../client/index.js')
const bundleSource = readFileSync(new URL('../client/bundle.js', import.meta.url), 'utf8')

const SECRET = 'sk-test-4f9a2b7c1d8e0f3a6b5c'
const {
  writeSecret, rewriteConfig, replaceEnv, replaceJson, replaceYaml, replaceToml,
  literalFor, literalInfo, envLiteralInfo, detectFormat, parseValidationSpec, isHostDenied, saneConfigValues,
  sanitizePatch, safeSettings, readJsonBody, sendJson, fingerprintOf, sseFrame,
  DEFAULTS
} = host.__internals

function tmp () {
  return mkdtempSync(join(tmpdir(), 'dsc-test-'))
}

// ── 1. 四种格式的行级改写 ───────────────────────────────────────────────────

test('env：替换已存在的键，保留注释与顺序', () => {
  const src = ['# 服务配置', 'PORT=3000', 'OPENAI_API_KEY=old-value', '# 尾注', ''].join('\n')
  const out = rewriteConfig('env', src, 'OPENAI_API_KEY', '"sk-new-1"')
  assert.equal(out.replaced, true)
  assert.match(out.text, /^PORT=3000$/m)
  assert.match(out.text, /^OPENAI_API_KEY="sk-new-1"$/m)
  assert.match(out.text, /^# 服务配置$/m)
  assert.match(out.text, /^# 尾注$/m)
  assert.doesNotMatch(out.text, /old-value/)
})

test('env：键不存在时追加到文件尾', () => {
  const src = 'PORT=3000\nAPI_URL=https://x.dev\n'
  const out = rewriteConfig('env', src, 'ANTHROPIC_API_KEY', '"sk-new-2"')
  assert.equal(out.replaced, false)
  assert.match(out.text, /^ANTHROPIC_API_KEY="sk-new-2"$/m)
  assert.match(out.text, /^PORT=3000$/m)
})

test('env：文件无结尾换行时先补换行再追加', () => {
  const out = rewriteConfig('env', 'PORT=3000', 'KEY_A', '"v"')
  assert.equal(out.text, 'PORT=3000\nKEY_A="v"\n')
})

test('json：替换字符串值，保留注释、顺序与尾逗号风格', () => {
  const src = [
    '{',
    '  "name": "demo", // 行内注释',
    '  "token": "stale",',
    '  "port": 8080',
    '}'
  ].join('\n')
  const out = rewriteConfig('json', src, 'token', '"sk-new-3"')
  assert.equal(out.replaced, true)
  assert.match(out.text, /\/\/ 行内注释/)
  assert.match(out.text, /^  "name": "demo",/m)
  assert.match(out.text, /^  "token": "sk-new-3",$/m)
  assert.match(out.text, /^  "port": 8080$/m)
  assert.doesNotMatch(out.text, /stale/)
})

test('json：替换非字符串值（数字/布尔/null）', () => {
  for (const raw of ['"token": 12345,', '"token": true,', '"token": null,']) {
    const src = ['{', `  ${raw}`, '  "a": 1', '}'].join('\n')
    const out = rewriteConfig('json', src, 'token', '"sk-new-4"')
    assert.equal(out.replaced, true, raw)
    assert.match(out.text, /^  "token": "sk-new-4",$/m)
  }
})

test('json：键不存在时插入到最后一个键之后并补逗号', () => {
  const src = [
    '{',
    '  "name": "demo",',
    '  "port": 8080',
    '}'
  ].join('\n')
  const out = rewriteConfig('json', src, 'token', '"sk-new-5"')
  assert.equal(out.replaced, false)
  assert.match(out.text, /^  "port": 8080,$/m)
  assert.match(out.text, /^  "token": "sk-new-5"$/m)
  // 插入后仍是结构完整的 JSON（不得留下尾逗号）
  const parsed = JSON.parse(out.text)
  assert.equal(parsed.token, 'sk-new-5')
  assert.equal(parsed.port, 8080)
})

test('json：嵌套对象里插入根级键不破坏缩进层级', () => {
  const src = [
    '{',
    '  "database": {',
    '    "host": "db.inner",',
    '    "port": 5432',
    '  },',
    '  "token": "stale"',
    '}'
  ].join('\n')
  const out = rewriteConfig('json', src, 'apiKey', '"sk-new-9"')
  assert.equal(out.replaced, false)
  assert.match(out.text, /^ {2}"apiKey": "sk-new-9"$/m)
  const parsed = JSON.parse(out.text)
  assert.equal(parsed.apiKey, 'sk-new-9')
  assert.equal(parsed.database.host, 'db.inner')
  assert.equal(parsed.database.port, 5432)
})

test('json：非对象结构返回 null 调用方按失败处理', () => {
  const out = replaceJson('[1, 2, 3]', 'token', '"x"')
  assert.equal(out.text, null)
})

test('yaml：替换已存在键；键不存在时追加', () => {
  const src = ['# 配置', 'token: stale', 'port: 8080', ''].join('\n')
  const out = rewriteConfig('yaml', src, 'token', '"sk-new-6"')
  assert.equal(out.replaced, true)
  assert.match(out.text, /^token: "sk-new-6"$/m)
  assert.match(out.text, /^# 配置$/m)

  const appended = rewriteConfig('yaml', 'port: 8080\n', 'token', 'plain-value')
  assert.equal(appended.replaced, false)
  assert.match(appended.text, /^token: plain-value$/m)
})

test('yaml：含特殊字符的值自动加引号', () => {
  const lit = literalFor('yaml', 'a: b # c')
  assert.equal(lit, '"a: b # c"')
  const out = rewriteConfig('yaml', 'token: x\n', 'token', lit)
  assert.match(out.text, /^token: "a: b # c"$/m)
})

test('toml：替换已存在键；键不存在时追加', () => {
  const src = ['# cfg', 'token = "stale"', 'port = 8080', ''].join('\n')
  const out = rewriteConfig('toml', src, 'token', '"sk-new-7"')
  assert.equal(out.replaced, true)
  assert.match(out.text, /^token = "sk-new-7"$/m)
  assert.match(out.text, /^# cfg$/m)

  const appended = rewriteConfig('toml', 'port = 8080\n', 'token', '"sk-new-8"')
  assert.equal(appended.replaced, false)
  assert.match(appended.text, /^token = "sk-new-8"$/m)
})

test('值里的引号与反斜杠被正确转义（env/yaml/toml/json 四种字面量）', () => {
  const tricky = 'a"b\\c$d`e f'
  assert.equal(literalFor('env', tricky), '"a\\"b\\\\c$d`e f"')
  assert.equal(literalFor('toml', tricky), '"a\\"b\\\\c$d`e f"')
  assert.equal(literalFor('json', tricky), JSON.stringify(tricky))
  const out = rewriteConfig('env', 'K=x\n', 'K', literalFor('env', tricky))
  assert.match(out.text, /^K="a\\"b\\\\c\$d`e f"$/m)
})

// ── 1b. env 按需引号（引号踩坑的回归）──────────────────────────────────────

test('env：无特殊字符的值原样落盘，quoted=false', () => {
  assert.deepEqual(literalInfo('env', 'sk-test-4f9a2b7c1d8e0f3a6b5c'), { literal: 'sk-test-4f9a2b7c1d8e0f3a6b5c', quoted: false })
  const out = rewriteConfig('env', 'KEY=old\n', 'KEY', literalFor('env', 'sk-test-4f9a2b7c1d8e0f3a6b5c'))
  assert.match(out.text, /^KEY=sk-test-4f9a2b7c1d8e0f3a6b5c$/m)
})

test('env：空白、引号、$、#、反斜杠、反引号、空值一律加引号', () => {
  const values = ['has space', 'quote"x', "apos'x", 'dollar$sign', 'hash#tag', 'back\\slash', 'tick`cmd', 'tab\there', '  padded  ', '']
  for (const v of values) {
    const info = envLiteralInfo(v)
    assert.equal(info.quoted, true, `${JSON.stringify(v)} 应该加引号`)
    const expected = v
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\r/g, '\\r')
      .replace(/\n/g, '\\n')
    assert.equal(info.literal, `"${expected}"`, `${JSON.stringify(v)} 的转义不正确`)
  }
})

test('env：引号形式可无损还原（朴素读法按规则剥引号+还原转义）', () => {
  // 任何读取方（脚本或后续调用）照这条规则都能取回真值
  const unquote = (line) => {
    const m = line.match(/^KEY="((?:[^"\\]|\\.)*)"$/)
    if (!m) return line.slice('KEY='.length)
    return m[1].replace(/\\r/g, '\r').replace(/\\n/g, '\n').replace(/\\"/g, '"').replace(/\\\\/g, '\\')
  }
  for (const v of ['plain', 'has space', 'a"b\\c$d`e f', 'tab\there', 'new\nline', 'mix "q" \\ # $']) {
    const out = rewriteConfig('env', 'KEY=old\n', 'KEY', literalFor('env', v))
    const line = out.text.split('\n').find((l) => l.startsWith('KEY='))
    assert.equal(unquote(line), v, `原值 ${JSON.stringify(v)} 应能无损还原`)
  }
})

test('literalInfo：env/yaml 按需引号，json/toml 恒为引号形式', () => {
  assert.deepEqual(literalInfo('json', 'plain'), { literal: '"plain"', quoted: true })
  assert.deepEqual(literalInfo('toml', 'plain'), { literal: '"plain"', quoted: true })
  assert.deepEqual(literalInfo('yaml', 'plain'), { literal: 'plain', quoted: false })
  assert.equal(literalInfo('yaml', 'a: b').quoted, true)
  assert.equal(literalFor('env', 'plain'), 'plain')
})

test('writeSecret：安全值原样落盘 quoted=false；特殊值加引号 quoted=true', () => {
  const dir = tmp()
  const file = join(dir, '.env')
  writeFileSync(file, 'K=old\n', 'utf8')
  const plain = writeSecret({ filePath: file, format: 'env', key: 'K', secret: 'plain-value-123', backup: false, backupKeep: 0, overwrite: true })
  assert.equal(plain.status, 'written')
  assert.equal(plain.quoted, false)
  assert.match(readFileSync(file, 'utf8'), /^K=plain-value-123$/m)

  const tricky = writeSecret({ filePath: file, format: 'env', key: 'K', secret: 'a b#c', backup: false, backupKeep: 0, overwrite: true })
  assert.equal(tricky.status, 'written')
  assert.equal(tricky.quoted, true)
  assert.match(readFileSync(file, 'utf8'), /^K="a b#c"$/m)
  rmSync(dir, { recursive: true, force: true })
})

test('detectFormat：显式优先，其次后缀', () => {
  assert.equal(detectFormat('/a/b.env', 'json'), 'json')
  assert.equal(detectFormat('/a/b.env'), 'env')
  assert.equal(detectFormat('/a/.env'), 'env')
  assert.equal(detectFormat('/a/config.json'), 'json')
  assert.equal(detectFormat('/a/config.yaml'), 'yaml')
  assert.equal(detectFormat('/a/config.yml'), 'yaml')
  assert.equal(detectFormat('/a/cfg.toml'), 'toml')
  assert.equal(detectFormat('/a/readme.md'), null)
  assert.equal(detectFormat('/a/x.txt', 'bogus'), null)
})

// ── 2. writeSecret 落盘行为（备份 / 原子写 / 读回校验）──────────────────────

test('writeSecret：覆盖写 + 备份 + 原子落盘 + 读回校验', () => {
  const dir = tmp()
  const file = join(dir, '.env')
  writeFileSync(file, 'A=1\nKEY=x\n', 'utf8')
  const out = writeSecret({ filePath: file, format: 'env', key: 'KEY', secret: SECRET, backup: true, backupKeep: 3, overwrite: true })
  assert.equal(out.status, 'written')
  assert.equal(out.quoted, false, 'sk- 开头的典型密钥无特殊字符，应原样落盘')
  assert.match(out.backup, /\.bak-\d{8}-\d{9}$/)
  const text = readFileSync(file, 'utf8')
  assert.match(text, /^KEY=sk-test-4f9a2b7c1d8e0f3a6b5c$/m)
  // 备份里是旧值
  assert.equal(readFileSync(out.backup, 'utf8'), 'A=1\nKEY=x\n')
  // 临时文件已清理
  assert.ok(!readdirSync(dir).some((n) => n.includes('.tmp-')))
  rmSync(dir, { recursive: true, force: true })
})

test('writeSecret：追加写也返回 written', () => {
  const dir = tmp()
  const file = join(dir, 'app.json')
  writeFileSync(file, '{\n  "name": "x"\n}\n', 'utf8')
  const out = writeSecret({ filePath: file, format: 'json', key: 'token', secret: SECRET, backup: false, backupKeep: 0, overwrite: true })
  assert.equal(out.status, 'written')
  assert.equal(out.backup, undefined)
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).token, SECRET)
  rmSync(dir, { recursive: true, force: true })
})

test('writeSecret：文件不存在 → file_missing，不新建文件', () => {
  const dir = tmp()
  const missing = join(dir, 'nope.env')
  const out = writeSecret({ filePath: missing, format: 'env', key: 'K', secret: SECRET, backup: true, backupKeep: 1, overwrite: true })
  assert.equal(out.status, 'failed')
  assert.equal(out.reason, 'file_missing')
  assert.equal(existsSync(missing), false)
  rmSync(dir, { recursive: true, force: true })
})

test('writeSecret：overwrite=false 且键已存在 → key_exists，文件不动', () => {
  const dir = tmp()
  const file = join(dir, '.env')
  writeFileSync(file, 'K=old\n', 'utf8')
  const out = writeSecret({ filePath: file, format: 'env', key: 'K', secret: SECRET, backup: false, backupKeep: 0, overwrite: false })
  assert.equal(out.status, 'failed')
  assert.equal(out.reason, 'key_exists')
  assert.equal(readFileSync(file, 'utf8'), 'K=old\n')
  rmSync(dir, { recursive: true, force: true })
})

test('writeSecret：备份滚动只保留 N 份', () => {
  const dir = tmp()
  const file = join(dir, '.env')
  writeFileSync(file, 'K=0\n', 'utf8')
  for (let i = 0; i < 5; i++) {
    writeFileSync(file, `K=${i}\n`, 'utf8')
    const out = writeSecret({ filePath: file, format: 'env', key: 'K', secret: `v${i}`, backup: true, backupKeep: 2, overwrite: true })
    assert.equal(out.status, 'written')
  }
  const backups = readdirSync(dir).filter((n) => /\.bak-\d{8}-\d{9}$/.test(n))
  assert.equal(backups.length, 2, `期望 2 份备份，实际 ${backups.length}：${backups.join(', ')}`)
  rmSync(dir, { recursive: true, force: true })
})

// ── 3. 脱敏红线：密钥不得出现在任何出口 ─────────────────────────────────────

test('writeSecret 返回值绝不含密钥', () => {
  const dir = tmp()
  const file = join(dir, '.env')
  writeFileSync(file, 'K=0\n', 'utf8')
  const out = writeSecret({ filePath: file, format: 'env', key: 'K', secret: SECRET, backup: true, backupKeep: 1, overwrite: true })
  assert.doesNotMatch(JSON.stringify(out), new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  rmSync(dir, { recursive: true, force: true })
})

test('fingerprint 只暴露哈希前 8 位，不足以反推密钥', () => {
  const fp = fingerprintOf(SECRET)
  assert.match(fp, /^sha256:[0-9a-f]{8}$/)
  assert.notEqual(fp, SECRET)
  assert.equal(fingerprintOf(SECRET), fingerprintOf(SECRET))
})

test('sseFrame 与结果对象不携带密钥', () => {
  const frame = sseFrame({ type: 'card.request', requestId: 'ab12', label: 'OpenAI API Key', file: 'C:\\p\\.env', key: 'OPENAI_API_KEY' })
  assert.doesNotMatch(frame, new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  assert.match(frame, /^data: \{.*\}\n\n$/)
})

// ── 4. HTTP 小工具 ─────────────────────────────────────────────────────────

function mockRes () {
  const chunks = []
  return {
    statusCode: undefined,
    headers: undefined,
    body: undefined,
    writeHead (status, headers) { this.statusCode = status; this.headers = headers },
    end (body) { this.body = body },
    on () { return this },
    write (chunk) { chunks.push(String(chunk)); return true },
    chunks
  }
}

test('sendJson 写状态头与 JSON 体', () => {
  const res = mockRes()
  sendJson(res, 200, { ok: true })
  assert.equal(res.statusCode, 200)
  assert.match(res.headers['content-type'], /application\/json/)
  assert.equal(res.body, '{"ok":true}')
})

test('readJsonBody：正常解析 + 超限拒绝', async () => {
  const good = new EventEmitter()
  const p = readJsonBody(good)
  good.emit('data', Buffer.from('{"a":'))
  good.emit('data', Buffer.from('1}'))
  good.emit('end')
  assert.deepEqual(await p, { a: 1 })

  const big = new EventEmitter()
  let destroyed = false
  big.destroy = () => { destroyed = true }
  const q = readJsonBody(big)
  big.emit('data', Buffer.alloc(64 * 1024)) // 恰好等于上限：仍然接受，等 end
  big.emit('data', Buffer.alloc(1)) // 再多 1 字节才越过 64KB 上限
  await assert.rejects(q, /too large/)
  assert.equal(destroyed, true)
})

// ── 5. 验证规格解析与 SSRF 护栏 ────────────────────────────────────────────

test('parseValidationSpec：http / command / 空 / 坏 JSON', () => {
  const http = parseValidationSpec(JSON.stringify({
    kind: 'http', method: 'get', url: 'https://api.x.dev/v1/verify',
    header: { Authorization: 'Bearer %%SECRET%%', 'Bad Header': 'x' },
    expectStatus: [200, 204], expectBodyContains: 'ok'
  }))
  assert.equal(http.kind, 'http')
  assert.equal(http.method, 'GET')
  assert.equal(http.header.Authorization, 'Bearer %%SECRET%%')
  assert.equal('Bad Header' in http.header, false)
  assert.deepEqual(http.expectStatus, [200, 204])

  const cmd = parseValidationSpec({ kind: 'command', argv: ['npm', 'run', 'check'], stdinTemplate: '%%SECRET%%\n' })
  assert.equal(cmd.kind, 'command')
  assert.deepEqual(cmd.argv, ['npm', 'run', 'check'])

  assert.equal(parseValidationSpec(undefined).kind, 'none')
  assert.equal(parseValidationSpec('').kind, 'none')
  assert.equal(parseValidationSpec('not json').kind, 'none')
  assert.equal(parseValidationSpec('not json').detail, 'bad_validation_json')
  assert.equal(parseValidationSpec({ kind: 'http' }).kind, 'none')
  assert.equal(parseValidationSpec({ kind: 'http', url: 'https://x', method: 'TRACE' }).kind, 'none')
  assert.equal(parseValidationSpec({ kind: 'command', argv: [] }).kind, 'none')
  assert.equal(parseValidationSpec({ kind: 'command', argv: ['x', ''] }).kind, 'none')
})

test('isHostDenied：拒绝名单命中本机/内网/元数据，放过普通域名', () => {
  const deny = DEFAULTS.denyHosts
  assert.equal(isHostDenied(new URL('http://127.0.0.1:8080/verify'), deny), true)
  assert.equal(isHostDenied(new URL('http://localhost:3000/verify'), deny), true)
  assert.equal(isHostDenied(new URL('http://169.254.169.254/latest/meta-data'), deny), true)
  assert.equal(isHostDenied(new URL('http://sub.localhost/verify'), deny), true)
  assert.equal(isHostDenied(new URL('https://api.openai.com/v1/verify'), deny), false)
  assert.equal(isHostDenied(new URL('https://my-host.internal.dev/verify'), deny), false)
})

// ── 6. 配置清洗 ────────────────────────────────────────────────────────────

test('saneConfigValues：只保留类型一致的标量/数组，{} 毒化被忽略', () => {
  const out = saneConfigValues({ enabled: 'yes', timeoutMs: {}, backup: true, backupKeep: '3', allowedSuffixes: ['.env'], denyHosts: 'x' }, DEFAULTS)
  assert.deepEqual(out, { backup: true, allowedSuffixes: ['.env'] })
})

test('sanitizePatch / safeSettings：白名单清洗与脱敏回显', () => {
  const patch = sanitizePatch({ enabled: false, timeoutMs: 30000, allowedSuffixes: ['.ENV', ' .json '], denyHosts: [' localhost ', ''], evil: 'x' })
  assert.equal(patch.enabled, false)
  assert.equal(patch.timeoutMs, 30000)
  assert.deepEqual(patch.allowedSuffixes, ['.env', '.json'])
  assert.deepEqual(patch.denyHosts, ['localhost'])
  assert.equal('evil' in patch, false)

  const safe = safeSettings({ ...DEFAULTS, enabled: true, timeoutMs: 1000, backup: true, backupKeep: 2, allowedSuffixes: ['.env'], allowCommandValidation: false, denyHosts: [] })
  assert.equal(safe.enabled, true)
  assert.equal(safe.timeoutMs, 1000)
  assert.ok(!('denyHosts' in safe) === false)
  assert.equal(JSON.stringify(safe).includes('sk-'), false)
})

// ── 7. 模块契约 ────────────────────────────────────────────────────────────

test('宿主模块导出契约', () => {
  assert.equal(host.name, 'dsh-secret-card')
  assert.ok(Array.isArray(host.inject))
  for (const need of ['tools', 'webServer', 'systemPrompt', 'connection', 'settings']) {
    assert.ok(host.inject.includes(need), `inject 缺少 ${need}`)
  }
  assert.equal(typeof host.apply, 'function')
  assert.ok(host.Config === undefined || (host.Config && typeof host.Config === 'object'), 'Config 必须是 undefined 或 schema 对象')
})

test('客户端模块导出契约', () => {
  assert.equal(client.name, 'dsh-secret-card')
  assert.ok(Array.isArray(client.inject))
  assert.ok(client.inject.includes('sessions'))
  assert.equal(typeof client.apply, 'function')
})

// ── 1b. 多语言（本机语言识别、英文兜底）────────────────────────────────────

test('detectLocale：zh 开头走中文，其余一律英文（兜底）', () => {
  const { detectLocale } = host.__internals
  assert.equal(detectLocale({ LC_ALL: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(detectLocale({ LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(detectLocale({ LC_MESSAGES: 'zh_TW.UTF-8' }), 'zh')
  assert.equal(detectLocale({ LANGUAGE: 'zh_Hans' }), 'zh')
  assert.equal(detectLocale({ LANG: 'en_US.UTF-8' }), 'en')
  assert.equal(detectLocale({ LANG: 'ja_JP.UTF-8' }), 'en')
  assert.equal(detectLocale({ LANG: 'de_DE' }), 'en')
  // 环境变量全空：落到 Intl，再落不到也只可能是 zh/en，绝不抛错
  assert.ok(['zh', 'en'].includes(detectLocale({})), '识别不到也不能崩，只能给 zh/en')
  assert.equal(detectLocale({ LC_ALL: '   ' }), ['zh', 'en'].includes(detectLocale({ LC_ALL: '   ' })) ? detectLocale({ LC_ALL: '   ' }) : 'en')
  // 空串视为未设置：LANGUAGE 为空串不应把 zh_CN 顶掉
  assert.equal(detectLocale({ LANGUAGE: '', LANG: 'zh_CN.UTF-8' }), 'zh')
})

test('resolveLocale：zh/en 直选，auto 走识别，非法值回落', () => {
  const { resolveLocale } = host.__internals
  assert.equal(resolveLocale('zh', { LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(resolveLocale('en', { LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveLocale('ZH', { LANG: 'en_US.UTF-8' }), 'zh')
  assert.equal(resolveLocale(' EN ', { LANG: 'zh_CN.UTF-8' }), 'en')
  assert.equal(resolveLocale('auto', { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLocale('auto', { LANG: 'fr_FR' }), 'en')
  assert.equal(resolveLocale('français', { LANG: 'zh_CN.UTF-8' }), 'zh', '非法档位回落 auto → 按本机识别')
  assert.equal(resolveLocale(undefined, { LANG: 'zh_CN.UTF-8' }), 'zh')
  assert.equal(resolveLocale(null, { LANG: 'ja_JP' }), 'en')
})

test('saneConfigValues 与 sanitizePatch 接受 language 档位', () => {
  const base = host.__internals.saneConfigValues({ language: 'en' }, DEFAULTS)
  assert.equal(base.language, 'en')
  const patched = host.__internals.sanitizePatch({ language: ' ZH ' })
  assert.equal(patched.language, 'zh')
  const bad = host.__internals.sanitizePatch({ language: 'klingon' })
  assert.equal(bad.language, 'auto', '不认识的档位回落 auto')
})

test('MESSAGES：两张表键一致，且每条都不含双花括号/printf 占位', () => {
  const { MESSAGES } = host.__internals
  const zhKeys = Object.keys(MESSAGES.zh).sort()
  const enKeys = Object.keys(MESSAGES.en).sort()
  assert.deepEqual(zhKeys, enKeys, 'zh 与 en 必须逐键对齐，漏键就是漏翻译')

  const walk = (value, out) => {
    if (typeof value === 'string') out.push(value)
    else if (typeof value === 'function') { try { out.push(value('K'), value('a b')) } catch {} }
    else if (value && typeof value === 'object') Object.values(value).forEach((v) => walk(v, out))
    return out
  }
  for (const locale of ['zh', 'en']) {
    const texts = walk(MESSAGES[locale], [])
    assert.ok(texts.length > 20, `${locale} 表应收集到 20+ 条文案，实际 ${texts.length}`)
    for (const text of texts) {
      assert.doesNotMatch(text, /\{\{/, `${locale} 文案出现 {{：${text.slice(0, 60)}`)
      // printf 风格占位会让宿主二次格式化时崩（too few arguments / bad format）
      assert.doesNotMatch(text.replace(/%%/g, ''), /%[sdifoexcgunp]/, `${locale} 文案出现 printf 占位：${text.slice(0, 60)}`)
    }
  }
  // 两边的密钥占位符都要在（防改回双花括号版或被删掉）
  for (const locale of ['zh', 'en']) {
    assert.ok(JSON.stringify(MESSAGES[locale]).includes('%%SECRET%%'), `${locale} 表必须给出占位符写法`)
  }
})

test('guidanceFor：两种语言的系统提示都覆盖硬规则与占位符', () => {
  const { guidanceFor } = host.__internals
  for (const locale of ['zh', 'en']) {
    const text = guidanceFor(locale)
    assert.equal(typeof text, 'string')
    assert.ok(text.length > 200, `${locale} 系统提示不应为空壳，实际 ${text.length} 字符`)
    assert.match(text, /secret_card/)
    assert.match(text, /%%SECRET%%/)
    assert.doesNotMatch(text, /\{\{/)
  }
  assert.notEqual(guidanceFor('zh'), guidanceFor('en'), '两种语言应给出不同文案')
})

test('客户端 bundle 契约：loader 外壳 + 原样内嵌 + return module.exports', () => {
  assert.match(bundleSource, /^\/\* Generated from client\/index\.js by scripts\/build-client\.mjs/)
  assert.match(bundleSource, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(bundleSource, /id: "dsh-secret-card",/)
  assert.match(bundleSource, /factory: \(require\) => \{/)
  assert.match(bundleSource, /var module = \{ exports: \{\} \}/)
  assert.match(bundleSource, /return module\.exports/)
  assert.match(bundleSource, /module\.exports = \{/)
  // 卡片本体仍是纯 DOM。React 只允许出现在「宿主设置页 tab 桥」这一处：
  // 宿主设置页的 tab 位是 React 插槽，React 由宿主的浏览器模块表提供，
  // 插件不自带、不重复安装，所以只 require 一次 react、且不碰 react-dom。
  const reactRequires = bundleSource.match(/require\(['"]react['"]\)/g) || []
  assert.equal(reactRequires.length, 1, `require('react') 只应出现一次，实际 ${reactRequires.length} 次`)
  assert.doesNotMatch(bundleSource, /react-dom/, '不得打包 react-dom')
  assert.doesNotMatch(bundleSource, /require\(['"]react\/jsx-runtime['"]\)/, '不得走 jsx-runtime')
})

test('宿主 apply 可被调用且不依赖宿主服务（惰性 armed）', async () => {
  const calls = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: (name, cb) => { calls.push(name); return () => {} },
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    settings: undefined,
    tools: undefined,
    webServer: undefined,
    systemPrompt: undefined,
    connection: undefined
  }
  await host.apply(ctx, {})
  assert.equal(typeof host.apply, 'function')
  assert.ok(calls.includes('settings/document-updated'))
})

// ── 8. apply 全量接线（工具 / 路由 / 系统提示文案）──────────────────────────

test('apply：注册工具、两条路由、系统提示 section，且文案不含双花括号', async () => {
  const tools = []
  const routes = []
  const sections = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    settings: undefined,
    connection: undefined,
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    systemPrompt: { section: (section) => { sections.push(section); return () => {} } }
  }
  await host.apply(ctx, {})

  // 工具
  assert.equal(tools.length, 1)
  const tool = tools[0]
  assert.equal(tool.name, 'secret_card')
  assert.equal(tool.isConcurrencySafe(), false)
  assert.equal(typeof tool.execute, 'function')
  assert.ok(tool.output && typeof tool.output.render === 'function')
  assert.ok(Array.isArray(tool.parameters.required))
  assert.deepEqual(tool.parameters.required, ['target', 'key'])

  // 路由：SSE（exact）+ API（prefix）
  assert.equal(routes.length, 2)
  assert.ok(routes.some((r) => r.kind === 'exact' && r.path === '/dsh-secret-card/api/events'))
  assert.ok(routes.some((r) => r.kind === 'prefix' && r.path === '/dsh-secret-card/api'))
  for (const route of routes) assert.equal(typeof route.handler, 'function')

  // 系统提示
  assert.equal(sections.length, 1)
  assert.equal(sections[0].name, 'plugin:dsh-secret-card')
  assert.equal(typeof sections[0].text, 'string')
  assert.match(sections[0].text, /secret_card/)

  // 红线（回归）：宿主的系统提示模板把 {{...}} 当变量引用，大写变量名会让整段
  // section 注册失败（实测：malformed prompt variable reference "{{SECRET}}"）。
  // 所有交给宿主的文案都不许出现双花括号
  const texts = [
    sections[0].text,
    tool.description,
    JSON.stringify(tool.parameters),
    host.__internals.guidanceFor('zh'),
    host.__internals.messagesFor('en').toolDescription,
    JSON.stringify(host.__internals.messagesFor('en'))
  ]
  for (const text of texts) {
    // 只有成对出现的 {{...}} 才会被宿主当成模板变量引用；示例 JSON 里的嵌套
    // 单层花括号无害，因此只查 {{ 这个起始形态
    assert.doesNotMatch(text, /\{\{/, `文案里出现 {{：${text.slice(0, 80)}`)
  }

  // 占位符照旧可用
  for (const locale of ['zh', 'en']) {
    assert.match(host.__internals.guidanceFor(locale), /%%SECRET%%/, `${locale} 的系统提示应给出占位符写法`)
    assert.match(JSON.stringify(host.__internals.messagesFor(locale)), /%%SECRET%%/)
  }
  assert.equal(host.__internals.SECRET_PLACEHOLDER, '%%SECRET%%')
})

test('validateSecret：HTTP 验证只回结论，响应体不进返回值', async () => {
  const { validateSecret } = host.__internals
  const realFetch = globalThis.fetch
  let seen = null
  globalThis.fetch = async (url, init) => {
    seen = { url, init }
    return {
      status: 200,
      text: async () => '{"ok":true,"token":"sk-LIVE-SECRET-VALUE"}'
    }
  }
  try {
    const spec = host.__internals.parseValidationSpec({
      kind: 'http',
      method: 'GET',
      url: 'https://api.example.com/v1/verify',
      header: { Authorization: 'Bearer %%SECRET%%' },
      expectStatus: 200
    })
    const out = await validateSecret(spec, 'sk-user-secret', { denyHosts: [] })
    assert.equal(out.validation, 'passed')
    assert.equal(out.validationDetail, 'http 200')
    // 密钥确实进了请求，但返回值里没有任何密钥或响应体内容
    assert.equal(seen.init.headers.Authorization, 'Bearer sk-user-secret')
    assert.doesNotMatch(JSON.stringify(out), /sk-user-secret|sk-LIVE-SECRET-VALUE|ok/)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('validateSecret：HTTP 状态码不符 → failed，不跟随重定向', async () => {
  const { validateSecret } = host.__internals
  const realFetch = globalThis.fetch
  let seenInit = null
  globalThis.fetch = async (url, init) => {
    seenInit = init
    return { status: 403, text: async () => 'nope' }
  }
  try {
    const spec = host.__internals.parseValidationSpec({
      kind: 'http', method: 'GET', url: 'https://api.example.com/v1/verify',
      header: { Authorization: 'Bearer %%SECRET%%' }, expectStatus: 200
    })
    const out = await validateSecret(spec, 'x', { denyHosts: [] })
    assert.equal(out.validation, 'failed')
    assert.match(out.validationDetail, /^http 403/)
    assert.equal(seenInit.redirect, 'manual')
    assert.equal(seenInit.method, 'GET')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('validateSecret：命中拒绝名单 → denied_host，密钥不出网', async () => {
  const { validateSecret } = host.__internals
  const realFetch = globalThis.fetch
  let called = false
  globalThis.fetch = async () => { called = true; throw new Error('should not be called') }
  try {
    const spec = host.__internals.parseValidationSpec({
      kind: 'http', method: 'GET', url: 'http://169.254.169.254/latest/meta-data', expectStatus: 200
    })
    const out = await validateSecret(spec, 'sk-x', { denyHosts: ['169.254.169.254'] })
    assert.equal(out.validation, 'failed')
    assert.equal(out.validationDetail, 'denied_host')
    assert.equal(called, false)
  } finally {
    globalThis.fetch = realFetch
  }
})

test('validateSecret：命令验证默认关闭；argv 出现占位符一律拒绝', async () => {
  const { validateSecret } = host.__internals
  const off = await validateSecret(host.__internals.parseValidationSpec({ kind: 'command', argv: ['echo', 'hi'] }), 'sk-x', { allowCommandValidation: false })
  assert.equal(off.validation, 'failed')
  assert.equal(off.validationDetail, 'command_not_allowed')

  const argv = await validateSecret(host.__internals.parseValidationSpec({ kind: 'command', argv: ['echo', '%%SECRET%%'] }), 'sk-x', { allowCommandValidation: true })
  assert.equal(argv.validation, 'failed')
  assert.equal(argv.validationDetail, 'secret_in_argv')
})
