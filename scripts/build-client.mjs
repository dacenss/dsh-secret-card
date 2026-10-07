#!/usr/bin/env node
/**
 * 把 client/index.js 包成客户端 bundle（window.__ModuleLoader__.load 外壳）。
 *
 * 客户端是纯 DOM 实现，不 import 任何平台模块，因此不需要 esbuild：把原文件
 * 原样嵌进 loader 契约的 factory 里即可。产物 client/bundle.js 由本脚本生成，
 * 不要手改。
 *
 * 用法：node scripts/build-client.mjs（或 npm run build:client）
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
const source = readFileSync(join(root, 'client', 'index.js'), 'utf8').replace(/\s+$/, '')

const banner = `/* Generated from client/index.js by scripts/build-client.mjs — do not edit by hand.
 * Regenerate with: npm run build:client
 */
window.__ModuleLoader__.load({
  id: ${JSON.stringify(pkg.name)},
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" })
`

const footer = `
    return module.exports
  }
})
`

const outPath = join(root, 'client', 'bundle.js')
writeFileSync(outPath, `${banner}${source}\n${footer}`, 'utf8')
console.log(`[${pkg.name}] client bundle written: client/bundle.js (${banner.length + source.length + footer.length + 1} bytes)`)
