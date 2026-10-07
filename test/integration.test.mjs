/**
 * 集成测试：把插件注册的工具与路由挂到真实 HTTP server 上，走完整链路
 *   execute() 建卡 → /pending 看到卡 → /fill 提交密钥 → 写文件 → 验证 → 工具返回
 * 这类测试正是能提前抓住两个线上bug的那类：
 *   - render 返回字符串（宿主 content.some is not a function）
 *   - /fill 的响应时序（卡片不消失）
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const host = require('../src/index.js')

const SECRET = 'sk-integration-9f8e7d6c5b4a'

function tmp () { return mkdtempSync(join(tmpdir(), 'dsc-int-')) }

/** 模拟宿主：收集注册进来的工具与路由，并把路由按 kind 挂到 http server。 */
async function boot () {
  const tools = []
  const routes = []
  const sections = []
  const ctx = {
    logger: { info: () => {}, warn: () => {} },
    on: () => () => {},
    effect: (fn) => { try { const d = fn(); return typeof d === 'function' ? d : () => {} } catch { return () => {} } },
    settings: undefined,
    // 不过栅栏：connection 服务缺席时宿主侧也不额外拦截（本地测试 server）
    connection: { requestRejection: () => undefined },
    tools: { register: (tool) => { tools.push(tool); return () => {} } },
    webServer: { register: (route) => { routes.push(route); return () => {} } },
    systemPrompt: { section: (s) => { sections.push(s); return () => {} } }
  }
  await host.apply(ctx, {})

  const server = http.createServer((req, res) => {
    const path = new URL(req.url || '/', 'http://127.0.0.1').pathname
    for (const route of routes) {
      const hit = route.kind === 'exact'
        ? path === route.path
        : path.startsWith(route.path)
      if (hit) return route.handler(req, res)
    }
    res.writeHead(404, { 'content-type': 'application/json' })
    res.end('{"error":"not_found"}')
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  return {
    tool: tools[0],
    sections,
    base: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

const session = { agent: { session: { id: 'sess-integration', header: { cwd: process.cwd() } } } }
// 宿主机 fetch：stub 掉 globalThis.fetch 做验证测试时，本文件访问本地 server 仍走它
const nativeFetch = globalThis.fetch

test('全链路：建卡 → pending → fill → 写文件 → 工具返回脱敏结果', async () => {
  const dir = tmp()
  const h = await boot()
  try {
    const file = join(dir, '.env')
    writeFileSync(file, '# 注释\nPORT=3000\n', 'utf8')

    const promise = h.tool.execute({
      target: file,
      key: 'OPENAI_API_KEY',
      format: 'env',
      label: 'OpenAI API Key',
      hint: '去 platform.openai.com 的 API keys 页面创建'
    }, session)

    // 卡片应出现在 /pending
    const pendingRes = await fetch(`${h.base}/dsh-secret-card/api/pending?sessionId=sess-integration`)
    const pending = await pendingRes.json()
    assert.equal(pendingRes.status, 200)
    assert.equal(pending.requests.length, 1)
    const card = pending.requests[0]
    assert.equal(card.key, 'OPENAI_API_KEY')
    assert.equal(card.file, file)
    assert.equal(card.masked, true)
    assert.equal(card.expiresAt > Date.now(), true)

    // 卡片渲染不得泄漏任何东西，且没有 secret 概念
    assert.doesNotMatch(JSON.stringify(card), /sk-integration/)

    // 未提交前工具不返回
    let settled = false
    promise.then(() => { settled = true }, () => { settled = true })
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(settled, false)

    // 提交密钥
    const fillRes = await fetch(`${h.base}/dsh-secret-card/api/fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: card.requestId, secret: SECRET })
    })
    assert.equal(fillRes.status, 200)
    const fill = await fillRes.json()
    assert.equal(fill.ok, true)
    assert.equal(fill.status, 'written')
    assert.equal(fill.validation, 'skipped')

    const result = await promise
    assert.equal(result.status, 'written')
    assert.equal(result.key, 'OPENAI_API_KEY')
    assert.equal(result.file, file)
    assert.match(result.backup, /\.bak-\d{8}-\d{9}$/)
    assert.equal(result.note, host.__internals.RESULT_NOTE)

    // 文件真写进去了
    const text = readFileSync(file, 'utf8')
    assert.match(text, /^OPENAI_API_KEY="sk-integration-9f8e7d6c5b4a"$/m)
    assert.match(text, /^# 注释$/m)

    // 脱敏红线：工具返回值与渲染内容都不含密钥
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
    const rendered = h.tool.output.render({ target: file, key: 'OPENAI_API_KEY' }, result)
    assert.ok(Array.isArray(rendered), 'render 必须返回内容块数组')
    assert.equal(rendered.length, 1)
    assert.equal(rendered[0].type, 'text')
    assert.doesNotMatch(rendered[0].text, new RegExp(SECRET.replace(/[.*+?^=${}()|[\]\\]/g, '\\$&')))
    assert.match(rendered[0].text, /密钥写入结果/)
    assert.match(rendered[0].text, /OPENAI_API_KEY/)
  } finally {
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('render 对失败结果也返回内容块数组（宿主 content.some 崩溃的回归）', async () => {
  const h = await boot()
  try {
    const rendered = h.tool.output.render({}, { status: 'failed', reason: 'file_missing', file: 'C:\\x\\.env', key: 'K' })
    assert.ok(Array.isArray(rendered))
    assert.equal(rendered[0].type, 'text')
    assert.match(rendered[0].text, /file_missing/)

    // render 收到的第二个参数才是结果；第一个参数是入参，不得被当成结果用
    const value = { status: 'busy', file: 'f', key: 'k' }
    const r2 = h.tool.output.render({ target: 'other.env' }, value)
    assert.match(r2[0].text, /busy/)
    assert.doesNotMatch(r2[0].text, /other\.env/)
  } finally {
    await h.close()
  }
})

test('参数不合法时立刻返回 failed，不建卡', async () => {
  const h = await boot()
  try {
    const res1 = await h.tool.execute({ key: 'K' }, session)
    assert.equal(res1.status, 'failed')
    assert.equal(res1.reason, 'bad_request')

    const res2 = await h.tool.execute({ target: 'C:\\x\\app.md', key: 'K' }, session)
    assert.equal(res2.status, 'failed')
    assert.equal(res2.reason, 'suffix_not_allowed')

    const pending = await (await fetch(`${h.base}/dsh-secret-card/api/pending`)).json()
    assert.equal(pending.requests.length, 0)

    const rendered = h.tool.output.render({}, res1)
    assert.ok(Array.isArray(rendered))
  } finally {
    await h.close()
  }
})

test('取消：/cancel 让工具返回 cancelled', async () => {
  const dir = tmp()
  const h = await boot()
  try {
    const file = join(dir, '.env')
    writeFileSync(file, 'A=1\n', 'utf8')
    const promise = h.tool.execute({ target: file, key: 'K' }, session)
    const card = (await (await fetch(`${h.base}/dsh-secret-card/api/pending`)).json()).requests[0]

    const cancelRes = await fetch(`${h.base}/dsh-secret-card/api/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: card.requestId })
    })
    assert.equal(cancelRes.status, 200)

    const result = await promise
    assert.equal(result.status, 'cancelled')
    assert.equal(result.reason, 'user_cancelled')

    // 取消后文件不动
    assert.equal(readFileSync(file, 'utf8'), 'A=1\n')

    // 已结算的请求再提交 → 404，客户端据此提示「请求已结束」
    const late = await fetch(`${h.base}/dsh-secret-card/api/fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: card.requestId, secret: SECRET })
    })
    assert.equal(late.status, 404)
    assert.equal((await late.json()).error, 'request_not_found')
  } finally {
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('busy：一次只允许一张卡；同签名重复请求合并到同一张卡', async () => {
  const dir = tmp()
  const h = await boot()
  try {
    const file = join(dir, '.env')
    writeFileSync(file, 'A=1\n', 'utf8')

    const p1 = h.tool.execute({ target: file, key: 'K1' }, session)
    // 同一会话同一文件同一键 → 合并（不应返回 busy）
    const p2 = h.tool.execute({ target: file, key: 'K1' }, session)
    // 不同键 → busy
    const p3 = await h.tool.execute({ target: file, key: 'K2' }, session)
    assert.equal(p3.status, 'busy')

    const pending = (await (await nativeFetch(`${h.base}/dsh-secret-card/api/pending`)).json()).requests
    assert.equal(pending.length, 1)
    assert.equal(p3 === p1, false)
    // execute 是 async 函数，合并时返回的是「被 adopt 的同一个结果对象」，
    // promise 标识本身不同属正常，结果对象必须同一个
    const filled = await nativeFetch(`${h.base}/dsh-secret-card/api/fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: pending[0].requestId, secret: SECRET })
    })
    assert.equal((await filled.json()).ok, true)
    const r1 = await p1
    const r2 = await p2
    assert.equal(r1.status, 'written')
    assert.equal(r2.status, 'written')
    assert.equal(r2, r1, '合并的两次调用拿到同一条结果')
  } finally {
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('验证：HTTP 校验通过时 passed，密钥只进请求头', async () => {
  const dir = tmp()
  const h = await boot()
  const realFetch = globalThis.fetch
  try {
    const file = join(dir, '.env')
    writeFileSync(file, 'A=1\n', 'utf8')
    globalThis.fetch = async (url, init) => {
      assert.equal(init.headers.Authorization, `Bearer ${SECRET}`)
      return { status: 204, text: async () => 'never-read' }
    }

    const promise = h.tool.execute({
      target: file,
      key: 'OPENAI_API_KEY',
      validation: JSON.stringify({
        kind: 'http',
        method: 'GET',
        url: 'https://api.example.com/v1/verify',
        header: { Authorization: 'Bearer %%SECRET%%' },
        expectStatus: 204
      })
    }, session)

    const card = (await (await nativeFetch(`${h.base}/dsh-secret-card/api/pending`)).json()).requests[0]
    assert.equal(card.willValidate, true)

    const filledRes = await nativeFetch(`${h.base}/dsh-secret-card/api/fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: card.requestId, secret: SECRET })
    })
    const fill = await filledRes.json()
    assert.equal(fill.validation, 'passed')
    assert.equal(fill.validationDetail, 'http 204')

    const result = await promise
    assert.equal(result.validation, 'passed')
    assert.match(result.fingerprint, /^sha256:[0-9a-f]{8}$/)
    assert.doesNotMatch(JSON.stringify(result), new RegExp(SECRET.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  } finally {
    globalThis.fetch = realFetch
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('验证失败不影响写入：密钥落盘 + validation=failed', async () => {
  const dir = tmp()
  const h = await boot()
  const realFetch = globalThis.fetch
  try {
    const file = join(dir, '.env')
    writeFileSync(file, 'A=1\n', 'utf8')
    globalThis.fetch = async () => ({ status: 401, text: async () => '{"error":"invalid key"}' })

    const promise = h.tool.execute({
      target: file,
      key: 'OPENAI_API_KEY',
      validation: JSON.stringify({ kind: 'http', method: 'GET', url: 'https://api.example.com/v1/verify', header: { Authorization: 'Bearer %%SECRET%%' }, expectStatus: 200 })
    }, session)
    const card = (await (await nativeFetch(`${h.base}/dsh-secret-card/api/pending`)).json()).requests[0]
    const filledRes = await nativeFetch(`${h.base}/dsh-secret-card/api/fill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: card.requestId, secret: SECRET })
    })
    const fill = await filledRes.json()
    assert.equal(fill.ok, true)
    assert.equal(fill.validation, 'failed')
    assert.match(fill.validationDetail, /^http 401/)

    const result = await promise
    assert.equal(result.status, 'written')
    assert.equal(result.validation, 'failed')
    assert.match(readFileSync(file, 'utf8'), /^OPENAI_API_KEY="sk-integration-9f8e7d6c5b4a"$/m)
    assert.doesNotMatch(JSON.stringify(result), /invalid key|sk-integration/)
  } finally {
    globalThis.fetch = realFetch
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SSE：连接建立即补推当前卡片（断线重连不丢卡）', async () => {
  const dir = tmp()
  const h = await boot()
  try {
    const file = join(dir, '.env')
    writeFileSync(file, 'A=1\n', 'utf8')
    const promise = h.tool.execute({ target: file, key: 'K' }, session)

    // 用裸 socket 读 SSE 流
    const frames = await new Promise((resolve, reject) => {
      const chunks = []
      const req = http.request(`${h.base}/dsh-secret-card/api/events`, (res) => {
        res.setEncoding('utf8')
        res.on('data', (chunk) => {
          chunks.push(chunk)
          if (chunks.join('').includes('card.request')) {
            res.destroy()
            resolve(chunks.join(''))
          }
        })
        res.on('error', () => resolve(chunks.join('')))
      })
      req.on('error', reject)
      req.end()
      setTimeout(() => { req.destroy(); resolve(chunks.join('')) }, 2000)
    })

    assert.match(frames, /^: connected\n\n/)
    assert.match(frames, /data: \{"type":"card.request"/)
    assert.match(frames, /"key":"K"/)
    assert.doesNotMatch(frames, /sk-integration/)

    // 收尾：取消，避免 promise 悬挂
    const card = (await (await fetch(`${h.base}/dsh-secret-card/api/pending`)).json()).requests[0]
    await fetch(`${h.base}/dsh-secret-card/api/cancel`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ requestId: card.requestId })
    })
    await promise
  } finally {
    await h.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
