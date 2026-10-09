'use strict'
/**
 * Config 必须是「ESM import 能看见的具名导出」。
 *
 * 宿主 cordis-plugin-loader/lib/index.js:451 是 `await import(插件名)` —— ESM 动态
 * import。CJS 模块被这样 import 时，只有 cjs-module-lexer 静态认得的属性才会成为
 * 具名导出；其余属性只藏在 default 里。而 0.1.7 loader 的 schema 发现走
 * entry.fiber.runtime.Config，读的就是具名导出那一份。
 *
 * 实测这个 lexer 的脾气（%TEMP%\dsc-lex 五组对照）：
 *   { name:'x', inject:['a'], Config }        → 一个都不认
 *   { name:'x', inject:['a'], Config: Config } → 同样不认
 *   { Config, name:'x' }                       → 认
 *   exports.Config = Config                    → 认
 *   Object.defineProperty(module.exports, 'Config', {get}) → 不认
 * 关键在 `inject: [...]` 这种数组字面量会让 lexer 半路放弃，**排在它后面的属性全丢**。
 *
 * 本插件实际踩过：named keys 只有 default,module.exports,name，而 m.default.Config
 * 是好的 —— 于是宿主报 No configurable plugin entry "dsh-secret-card"，
 * 设置页保存两条路全断。所以 Config 必须排在 module.exports 对象字面量的第一位。
 *
 * 这条用例就是钉子：谁把 Config 挪到 inject 后面、或改回 `Config: Config ?? undefined`，
 * 这里立刻红。
 */

import assert from 'node:assert/strict'
import { existsSync, readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, join } from 'node:path'

const here = dirname(fileURLToPath(import.meta.url))
const entry = join(here, '..', 'src', 'index.js')

let passed = 0
const failures = []
const notes = []
const check = (name, fn) => {
  try { fn(); passed += 1 } catch (error) { failures.push(`${name}: ${error.message}`) }
}

// 运行时真正被宿主加载的那一份。工作区副本没有 node_modules，schemastery 解析不到，
// Config 必然是 undefined —— 那是环境问题不是代码问题。所以「值」这一组断言改成
// 遍历所有候选副本，只要有一份能解析出真 schema 就算过；一份都没有才报红。
const candidates = [entry]
// install-local.ps1 的落点：<DSH_HOME>/profiles/*/node_modules/dsh-secret-card。
// 它在工作区目录树之外，只能按 DSH_HOME 显式找。注意 DSH_HOME 本身就是 .dsh 这一层
// （本机实测 = C:\Users\izhjs\.dsh），别再拼一次 .dsh；只有走 USERPROFILE 兜底时才拼
const dshRoot = process.env.DSH_HOME
  ? process.env.DSH_HOME
  : join(process.env.USERPROFILE || process.env.HOME || '', '.dsh')
if (dshRoot) {
  try {
    const { readdirSync } = await import('node:fs')
    for (const profile of readdirSync(join(dshRoot, 'profiles'), { withFileTypes: true })) {
      if (!profile.isDirectory()) continue
      const installed = join(dshRoot, 'profiles', profile.name, 'node_modules', 'dsh-secret-card', 'src', 'index.js')
      if (existsSync(installed) && !candidates.includes(installed)) candidates.push(installed)
    }
  } catch {}
}
for (let dir = here, i = 0; i < 6; i += 1) {
  const installed = join(dir, 'node_modules', 'dsh-secret-card', 'src', 'index.js')
  if (existsSync(installed) && !candidates.includes(installed)) candidates.push(installed)
  const parent = dirname(dir)
  if (parent === dir) break
  dir = parent
}

const resolvable = candidates.filter((file) => {
  try { createRequire(file)('@deepseek-ai/schemastery'); return true } catch { return false }
})
const withSchema = []
for (const file of resolvable) {
  try {
    const mod = await import(pathToFileURL(file).href)
    if (mod && typeof mod.Config === 'function' && 'toJSON' in mod.Config) withSchema.push(mod)
  } catch {}
}
notes.push(`候选副本 ${candidates.length} 份，其中 schemastery 可解析 ${resolvable.length} 份、拿到真 schema ${withSchema.length} 份`)

// 1. 具名导出里必须有 Config（宿主唯一会看的那一份）
check('Config 是具名导出', () => {
  assert.ok(withSchema.length > 0,
    '没有任何副本能通过 ESM import() 拿到 Config —— 宿主会认为本插件没有设置项')
  for (const mod of withSchema) {
    assert.equal(typeof mod.Config, 'function', 'import() 后 mod.Config 应是 schema 构造函数')
  }
})

// 2. 必须是宿主认得的 schema 形状（schema() 要求 "toJSON" in schema）
check('Config 带 toJSON（宿主 schema() 的准入条件）', () => {
  for (const mod of withSchema) {
    assert.ok('toJSON' in mod.Config, '缺 toJSON，宿主 schema() 会当成无设置项')
  }
})

// 3. 字段齐全且都声明了 volatile（否则写回时 validatePaths 抛 not volatile）
check('Config.dict 八个字段齐全', () => {
  for (const mod of withSchema) {
    assert.deepEqual(Object.keys(mod.Config.dict).sort(), [
      'allowCommandValidation', 'allowedSuffixes', 'backup', 'backupKeep',
      'denyHosts', 'enabled', 'language', 'timeoutMs'
    ])
  }
})

// 4. 静态形状断言：防 lexer 半路放弃。要求 Config 出现在 module.exports 对象字面量里、
//    且位置在 inject 之前（数组字面量是 lexer 的放弃点）
const src = readFileSync(entry, 'utf8')
check('Config 排在 inject 之前（lexer 遇数组字面量即放弃后续属性）', () => {
  const at = src.indexOf('module.exports = {')
  assert.ok(at >= 0, '找不到 module.exports 对象字面量')
  const body = src.slice(at, src.indexOf('\n}', at))
  const configAt = body.search(/^\s*Config\s*[,:]/m)
  const injectAt = body.search(/^\s*inject\s*:/m)
  assert.ok(configAt >= 0, 'module.exports 对象字面量里没有 Config')
  assert.ok(injectAt >= 0, 'module.exports 对象字面量里没有 inject')
  assert.ok(configAt < injectAt, `Config(${configAt}) 必须排在 inject(${injectAt}) 之前`)
})

// 5. 不能是取值器形状（defineProperty getter 不被 lexer 识别）
check('Config 不是 defineProperty/getter 形式', () => {
  assert.ok(!/defineProperty\(\s*module\.exports\s*,\s*['"]Config['"]/.test(src),
    'defineProperty 导出的 Config 不会被 cjs-module-lexer 识别')
})

// 6. 其余导出不受影响
check('name / inject / __internals 仍在', () => {
  const mod = withSchema[0]
  assert.ok(mod, '没有可断言的副本')
  assert.equal(mod.default.name, 'dsh-secret-card')
  assert.deepEqual(mod.default.inject,
    ['tools', 'webServer', 'systemPrompt', 'connection', 'settings'])
  assert.equal(typeof mod.default.__internals.safeSettings, 'function')
})

// 7. default 与具名导出是同一份值（改导出形状时不能悄悄复制出两份）
check('具名 Config 与 default.Config 同源', () => {
  const mod = withSchema[0]
  assert.ok(mod, '没有可断言的副本')
  assert.equal(mod.Config, mod.default.Config)
})

// ── 结果 ──
if (failures.length > 0) {
  console.error(`export-shape: ${failures.length} 失败 / ${passed} 通过`)
  for (const line of failures) console.error('  ✗ ' + line)
  process.exit(1)
}
console.log(`export-shape: ${passed} 项全部通过${notes.length ? '（' + notes.join('；') + '）' : ''}`)
