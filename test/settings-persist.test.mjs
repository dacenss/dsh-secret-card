/**
 * 设置持久化测试。
 *
 * 线上 bug：用户在设置面板改一项、点保存，界面说「已保存」，重启后又回默认值。
 * 根因是 ctx.settings.update() 内部「写 profile patch → loader 就地重载全部插件」
 * 这条链上任何一环失败都会抛错，而旧代码只 warn 一句把错误吞了。
 *
 * 这组测试钉住三件事：
 *   1. 宿主那条路失败时，原生改写 profile patch 必须真的把 config 合并进去，
 *      并且**只动本插件那一行**，别人的行原样保留。
 *   2. 宿主那条路成功时，绝不能去碰 profile patch 文件。
 *   3. 两条路都失败时，HTTP 必须回 500 并把原因带回给设置页，不许假装成功。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs'
import { tmpdir, homedir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const host = require('../src/index.js')
// 插件开机时会往自己目录写 .dsc-diag.json；测试跑完顺手删掉，别让它跟着 install 脚本进 profile。
const DIAG_FILE = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', '.dsc-diag.json')

function tmp () { return mkdtempSync(join(tmpdir(), 'dsc-set-')) }

const SEED = `# Your patch layer for this dsh profile
- id: agent-default-model
  name: "@deepseek-ai/dsh-agent-default-model"
  config:
    provider: stepplan
    model: step-5-preview
- id: dsh-mcp-manager
  name: "@wingsky-1/dsh-mcp-manager"
  config:
    ui:
      position: bottom-right
  disabled: false
`

async function boot (settings) {
  const routes = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    settings,
    connection: { requestRejection: () => undefined },
    tools: { register: () => () => {} },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    systemPrompt: { section: () => () => {} }
  }
  await host.apply(ctx, { language: 'zh' })
  const server = http.createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
    for (const route of routes) {
      const hit = route.kind === 'exact' ? path === route.path : path.startsWith(route.path)
      if (hit) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not_found"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return { base: `http://127.0.0.1:${port}`, close: () => new Promise((resolve) => server.close(resolve)) }
}

const put = async (base, patch) => {
  const res = await fetch(`${base}/dsh-secret-card/api/settings`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(patch)
  })
  return { status: res.status, body: await res.json().catch(() => null) }
}

test('宿主 settings.update 失败 → 原生改写 profile patch，只动自己那一行', async () => {
  const dir = tmp()
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, SEED, 'utf8')
  const h = await boot({
    update: async () => { throw new Error('reload failed: plugin fiber went inactive') },
    prepareDocument: () => ({ patchPath })
  })
  try {
    const { status, body } = await put(h.base, { timeoutMs: 300000, backupKeep: 7 })
    assert.equal(status, 200)
    // 落盘失败不能报成功
    assert.equal(body.settingsError, null)

    const text = readFileSync(patchPath, 'utf8')
    // 本插件的行被写进去了
    assert.match(text, /- id: dsh-secret-card/)
    assert.match(text, /timeoutMs: 300000/)
    assert.match(text, /backupKeep: 7/)
    // 别人的行一个字都没动
    assert.match(text, /- id: agent-default-model/)
    assert.match(text, /provider: stepplan/)
    assert.match(text, /- id: dsh-mcp-manager/)
    assert.match(text, /position: bottom-right/)
    assert.match(text, /disabled: false/)
    // 备份也留了
    assert.ok(existsSync(`${patchPath}.dsc-backup`))
    // 备份内容是改写前的原文
    assert.equal(readFileSync(`${patchPath}.dsc-backup`, 'utf8'), SEED)
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); rmSync(DIAG_FILE, { force: true }) }
})

test('原生改写是幂等的：连改两次不会堆出行、也不会丢前一次的值', async () => {
  const dir = tmp()
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, SEED, 'utf8')
  const h = await boot({
    update: async () => { throw new Error('boom') },
    prepareDocument: () => ({ patchPath })
  })
  try {
    await put(h.base, { timeoutMs: 300000 })
    await put(h.base, { backupKeep: 5 })
    const text = readFileSync(patchPath, 'utf8')
    // 本插件只出现一次
    assert.equal(text.match(/- id: dsh-secret-card/g).length, 1)
    // 两次的值都在
    assert.match(text, /timeoutMs: 300000/)
    assert.match(text, /backupKeep: 5/)
    // 别人的行还在
    assert.match(text, /- id: dsh-mcp-manager/)
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); rmSync(DIAG_FILE, { force: true }) }
})

test('patch 里本来没有本插件的行 → 追加一行，不动别人', async () => {
  const dir = tmp()
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, SEED, 'utf8')
  const h = await boot({
    update: async () => { throw new Error('boom') },
    prepareDocument: () => ({ patchPath })
  })
  try {
    await put(h.base, { language: 'en' })
    const text = readFileSync(patchPath, 'utf8')
    assert.match(text, /- id: dsh-secret-card/)
    assert.match(text, /name: dsh-secret-card/)
    // 字符串值统一带引号落盘，YAML 解析出来还是 en
    assert.match(text, /language: "en"/)
    assert.match(text, /- id: agent-default-model/)
    // 追加的行紧跟在前一行后面，不留空行堆叠
    assert.ok(!/\n\n- id: dsh-secret-card/.test(text))
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); rmSync(DIAG_FILE, { force: true }) }
})

test('patch 文件不存在 → 建一份新的', async () => {
  const dir = tmp()
  const patchPath = join(dir, 'cordis.patch.yml')
  const h = await boot({
    update: async () => { throw new Error('boom') },
    prepareDocument: () => ({ patchPath })
  })
  try {
    const { status } = await put(h.base, { backupKeep: 9 })
    assert.equal(status, 200)
    assert.match(readFileSync(patchPath, 'utf8'), /backupKeep: 9/)
    // 没有原文可备份，不该留下备份文件
    assert.ok(!existsSync(`${patchPath}.dsc-backup`))
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); rmSync(DIAG_FILE, { force: true }) }
})

test('宿主 settings.update 成功 → 一根手指都不碰 profile patch', async () => {
  const dir = tmp()
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, SEED, 'utf8')
  const h = await boot({
    update: async () => {},
    prepareDocument: () => { throw new Error('native writer must not run') }
  })
  try {
    const { status, body } = await put(h.base, { timeoutMs: 60000 })
    assert.equal(status, 200)
    assert.equal(body.settingsError, null)
    // 文件保持原样
    assert.equal(readFileSync(patchPath, 'utf8'), SEED)
    assert.ok(!existsSync(`${patchPath}.dsc-backup`))
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); rmSync(DIAG_FILE, { force: true }) }
})

test('两条路都失败 → 回 500 并把原因带回设置页，不假装已保存', async () => {
  const dir = tmp()
  const patchPath = join(dir, 'cordis.patch.yml')
  // 顶层不是 YAML 序列 → 原生改写必须拒绝，一个字节都不能改
  writeFileSync(patchPath, 'this file is not a patch layer at all\n', 'utf8')
  const h = await boot({
    update: async () => { throw new Error('host said no') },
    prepareDocument: () => ({ patchPath })
  })
  try {
    const { status, body } = await put(h.base, { backupKeep: 1 })
    assert.equal(status, 500)
    assert.match(String(body.settingsError), /host said no/)
    assert.match(String(body.settingsError), /顶层不是 YAML 序列/)
    // 坏文件不许被改写
    assert.equal(readFileSync(patchPath, 'utf8'), 'this file is not a patch layer at all\n')
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); rmSync(DIAG_FILE, { force: true }) }
})

test('GET /settings 会把上一次的落盘失败原因带出来', async () => {
  const dir = tmp()
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, SEED, 'utf8')
  const h = await boot({
    update: async () => { throw new Error('nope') },
    prepareDocument: () => ({ patchPath })
  })
  try {
    await put(h.base, { timeoutMs: 120000 })
    const res = await fetch(`${h.base}/dsh-secret-card/api/settings`)
    const body = await res.json()
    // 这一次是靠原生改写救回来的，所以没有遗留错误
    assert.equal(body.settingsError, null)
    // 但值确实落了盘（重启后读得到）
    assert.match(readFileSync(patchPath, 'utf8'), /timeoutMs: 120000/)
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); rmSync(DIAG_FILE, { force: true }) }
})

// 拿本机真实的 profile patch 当模板跑一遍：这是「别人的行一个字都不能动」
// 最有力的证据。文件不在（换机器 / 换 profile）就跳过。
//
// 注意：这份文件是活的——本插件的原生改写兜底真的会往里写 dsh-secret-card 那一行
// （2026-10-09 08:27 实测落盘成功过一次）。所以不能再假设「原本没有我们这一行」，
// 断言要改成：除本插件 config 块内部的值行之外，原有每一行都必须原样留在原位置。
const realPatch = join(homedir(), '.dsh', 'profiles', 'desktop', 'cordis.patch.yml')
test('真实 profile patch 当模板：别人的行一个字都不能动', async (t) => {
  if (!existsSync(realPatch)) return t.skip('本机没有 desktop profile patch')
  const original = readFileSync(realPatch, 'utf8')
  const dir = tmp()
  const patchPath = join(dir, 'cordis.patch.yml')
  writeFileSync(patchPath, original, 'utf8')
  const h = await boot({
    update: async () => { throw new Error('simulated host failure') },
    prepareDocument: () => ({ patchPath })
  })
  try {
    const { status } = await put(h.base, { timeoutMs: 240000, language: 'en' })
    assert.equal(status, 200)
    const before = original.split(/\r?\n/)
    const after = readFileSync(patchPath, 'utf8').split(/\r?\n/)

    // 原有行里，属于「本插件 config 块」的值行允许被改写（这次就是去改它们的）；
    // 其余每一行都必须原样保留。定位本插件块：从 `- id: dsh-secret-card` 那行起，
    // 到下一个**同级或更浅**的 `- ` 项为止。只按 `^\s*-\s` 判断会误伤 —— 我们自己
    // config 里的 allowedSuffixes / denyHosts 数组项也是 `- ` 开头的（只是缩进更深），
    // 所以必须连缩进一起比。
    const start = before.findIndex((l) => /^\s*-\s+id:\s*['"]?dsh-secret-card['"]?\s*$/.test(l))
    const ownRange = (lines) => {
      if (start < 0) return new Set()
      const baseIndent = /^\s*/.exec(before[start])[0].length
      const drop = new Set()
      for (let i = start; i < lines.length; i += 1) {
        if (i > start) {
          const m = /^(\s*)-\s/.exec(lines[i])
          if (m && m[1].length <= baseIndent) break
        }
        drop.add(i)
      }
      return drop
    }
    const own = ownRange(before)
    for (let i = 0; i < before.length; i += 1) {
      if (before[i].trim() === '') continue
      if (own.has(i)) continue
      assert.ok(after.includes(before[i]), `原有行丢了[${i}]: ${before[i]}`)
    }
    // 别人的条目一个都没少
    for (const id of ['agent-default-model', 'ui-settings-account', 'ui-chat', 'ui-settings',
      'llm-deepseek', 'llm-pi-ai', 'web-search-free', 'dsh-mcp-manager', 'permission',
      'browserskill', 'better-sidebar', 'agent-preset-registry', 'dsh-context']) {
      assert.ok(after.some((l) => l.includes(`- id: ${id}`)), `别人的条目没了: ${id}`)
    }
    // 本插件只出现一次，不堆行
    assert.equal(after.filter((l) => /- id: dsh-secret-card/.test(l)).length, 1)
    // 这次改的值真的落盘了
    assert.match(readFileSync(patchPath, 'utf8'), /timeoutMs: 240000/)
    assert.match(readFileSync(patchPath, 'utf8'), /language: "en"/)
  } finally { await h.close(); rmSync(dir, { recursive: true, force: true }); rmSync(DIAG_FILE, { force: true }) }
})
