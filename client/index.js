/* eslint-disable */
/**
 * dsh-secret-card — 客户端：密钥输入卡片
 *
 * 纯 DOM 实现，不依赖 React：宿主通过 SSE 把「需要用户输入一个密钥」推给页面，
 * 页面弹出一张模态卡片；用户输入后用同源 fetch 提交，密钥走完那一次请求就交
 * 给宿主编入配置文件。卡片上明确告诉用户：内容不会进对话记录，AI 看不到。
 *
 * 产物由 scripts/build-client.mjs 包成 window.__ModuleLoader__.load(...) 外壳，
 * 本文件不要直接改产物。
 */

const CLIENT_NAME = 'dsh-secret-card'
const API = '/dsh-secret-card/api'
const STYLE_ID = 'dsc-secret-card-style'

// ── 多语言 ─────────────────────────────────────────────────────────────────
// 客户端没有宿主的 settings 通道，只能按浏览器自己的语言识别；识别不到一律英文。
// 宿主侧另有一张大表（src/index.js 的 MESSAGES），两边的档位判定保持一致：
// 只要语言串以 zh 开头（zh / zh-CN / zh-TW / zh-Hant…）就走中文，其余一律英文。

const CLIENT_MESSAGES = {
  zh: {
    emptySecret: '请先输入密钥。',
    writing: '正在写入配置文件…',
    submitFailed: '提交失败：网络错误或宿主无响应，可以重试或取消。',
    submitRetry: '卡片保持打开，可以重试或取消。',
    submitDone: '确定写入',
    submitOk: '完成',
    cancel: '取消',
    defaultTitle: '请输入密钥',
    placeholder: '在这里粘贴或输入密钥',
    show: '显示',
    hide: '隐藏',
    fileLabel: '将写入：',
    keyLabel: '　键名：',
    safetyTitle: '安全说明：',
    safetyBody: '你在这里输入的密钥不会出现在对话记录里，AI 也看不到；它只会被写入上面这个文件。',
    willValidate: '写入后会自动验证这个密钥是否生效，并把结果告诉助手。',
    seenBefore: '注意：这个键此前已经写入过一次，请确认要再次输入。',
    okNone: '已写入配置文件。',
    okPassed: d => `已写入，密钥生效${d}。`,
    okFailed: d => `已写入配置，但验证未通过${d}。`,
    wrapDetail: s => `（${s}）`,
    genericError: '写入失败',
    reasons: {
      file_missing: '目标文件不存在',
      read_failed: '读取目标文件失败',
      write_failed: '写入失败',
      rewrite_failed: '改写失败',
      verify_mismatch: '写入后校验不一致',
      key_exists: '该键已存在且不允许覆盖',
      request_not_found: '这次请求已经结束（可能等待超时被取消），请让助手重新发起',
      missing_requestId_or_secret: '提交内容不完整',
      http_401: '未授权（浏览器登录状态失效，刷新页面后重试）',
      http_403: '被宿主拒绝（安全校验未通过）',
      http_404: '这次请求已经结束（可能等待超时被取消），请让助手重新发起',
      http_400: '请求格式有误'
    },
    countdownLeft: s => `剩余 ${s} 未输入将自动取消`,
    countdownOver: '已超时，卡片关闭'
  },
  en: {
    emptySecret: 'Please enter the secret first.',
    writing: 'Writing to the config file…',
    submitFailed: 'Submission failed: network error or no response from the app. You can retry or cancel.',
    submitRetry: 'The card stays open — you can retry or cancel.',
    submitDone: 'Write it',
    submitOk: 'Done',
    cancel: 'Cancel',
    defaultTitle: 'Enter the secret',
    placeholder: 'Paste or type the secret here',
    show: 'Show',
    hide: 'Hide',
    fileLabel: 'Writing to: ',
    keyLabel: ' · key: ',
    safetyTitle: 'Security note: ',
    safetyBody: 'The secret you type here never appears in the conversation and the AI cannot see it. It only gets written into the file above.',
    willValidate: 'After writing, the plugin checks whether the secret works and tells the assistant.',
    seenBefore: 'Note: this key was already written once. Please confirm you want to enter it again.',
    okNone: 'Written to the config file.',
    okPassed: d => `Written, and the secret works${d}.`,
    okFailed: d => `Written, but validation failed${d}.`,
    wrapDetail: s => `(${s})`,
    genericError: 'Write failed',
    reasons: {
      file_missing: 'The target file does not exist',
      read_failed: 'Could not read the target file',
      write_failed: 'Write failed',
      rewrite_failed: 'Rewrite failed',
      verify_mismatch: 'Content check after writing did not match',
      key_exists: 'This key already exists and overwriting is not allowed',
      request_not_found: 'This request already ended (it may have timed out). Ask the assistant to start a new one.',
      missing_requestId_or_secret: 'The submission is incomplete',
      http_401: 'Not authorized (browser session expired — reload the page and retry)',
      http_403: 'Rejected by the host (security check failed)',
      http_404: 'This request already ended (it may have timed out). Ask the assistant to start a new one.',
      http_400: 'Malformed request'
    },
    countdownLeft: s => `${s} left before the card is cancelled`,
    countdownOver: 'Timed out — card closed'
  }
}

function detectLocale () {
  try {
    const langs = (typeof navigator !== 'undefined' && Array.isArray(navigator.languages))
      ? navigator.languages
      : ((typeof navigator !== 'undefined' && navigator.language) ? [navigator.language] : [])
    for (const raw of langs) {
      const tag = String(raw || '').toLowerCase()
      if (tag.startsWith('zh')) return 'zh'
      if (tag) return 'en'
    }
  } catch {}
  return 'en'
}


// ── 样式（全部用宿主主题变量 + 兜底色值，浅色/深色自适应）───────────────────

const STYLE = `<style id="${STYLE_ID}">
.dsc-overlay{position:fixed;inset:0;z-index:9998;display:flex;align-items:center;justify-content:center;padding:24px;background:color-mix(in srgb, var(--dsw-alias-bg-layer-1, #101014) 55%, transparent);backdrop-filter:blur(2px)}
.dsc-card{width:min(460px,94vw);display:flex;flex-direction:column;gap:12px;padding:20px;border-radius:14px;border:1px solid var(--dsw-alias-border-l1, #2a2a30);background:var(--dsw-alias-bg-layer-2, #1c1c22);color:var(--dsw-alias-label-primary, #f2f2f5);font-family:var(--dsw-font-family, system-ui, sans-serif);font-size:var(--dsw-font-sm-14, 14px);box-shadow:var(--dsw-shadow-lv2, 0 12px 40px rgba(0,0,0,.45))}
.dsc-title{display:flex;align-items:center;gap:8px;font-size:15px;font-weight:600;color:var(--dsw-alias-label-primary, #f2f2f5)}
.dsc-title::before{content:"";width:8px;height:8px;border-radius:50%;background:var(--dsw-alias-state-business-primary, #4c8dff)}
.dsc-file{display:flex;flex-direction:column;gap:2px;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1, #14141a);border:1px solid var(--dsw-alias-border-l2, #33333c);font-size:var(--dsw-font-xs-13, 12px);color:var(--dsw-alias-label-secondary, #b8b8c2);word-break:break-all}
.dsc-file b{color:var(--dsw-alias-label-primary, #f2f2f5);font-weight:600}
.dsc-hint{padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-layer-1, #14141a);border:1px dashed var(--dsw-alias-border-l2, #33333c);font-size:var(--dsw-font-xs-13, 12px);line-height:1.6;color:var(--dsw-alias-label-secondary, #b8b8c2);white-space:pre-wrap}
.dsc-safety{font-size:var(--dsw-font-xs-13, 12px);line-height:1.6;color:var(--dsw-alias-label-tertiary, #8b8b96)}
.dsc-safety b{color:var(--dsw-alias-state-business-primary, #4c8dff);font-weight:600}
.dsc-field{display:flex;gap:8px;align-items:stretch}
.dsc-input{flex:1;min-width:0;min-height:38px;padding:8px 12px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2, #33333c);background:var(--dsw-alias-bg-layer-1, #14141a);color:var(--dsw-alias-label-primary, #f2f2f5);font-size:13.5px;font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;outline:none;box-sizing:border-box}
.dsc-input:focus{border-color:var(--dsw-alias-state-business-primary, #4c8dff)}
.dsc-input::placeholder{color:var(--dsw-alias-label-tertiary, #8b8b96)}
.dsc-toggle{flex:0 0 auto;padding:0 12px;min-height:38px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2, #33333c);background:var(--dsw-alias-bg-layer-1, #14141a);color:var(--dsw-alias-label-secondary, #b8b8c2);font-size:12.5px;cursor:pointer;font-family:var(--dsw-font-family, system-ui, sans-serif)}
.dsc-toggle:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))}
.dsc-status{min-height:18px;font-size:var(--dsw-font-xs-13, 12px);line-height:1.5;color:var(--dsw-alias-label-secondary, #b8b8c2)}
.dsc-countdown{font-size:var(--dsw-font-xs-13, 12px);line-height:1.5;color:var(--dsw-alias-label-tertiary, #8b8b96);text-align:right}
.dsc-status.ok{color:var(--dsw-alias-state-success-primary, #34a853)}
.dsc-status.err{color:var(--dsw-alias-state-error-primary, #ea4335)}
.dsc-actions{display:flex;gap:10px;justify-content:flex-end;margin-top:2px}
.dsc-btn{display:inline-flex;align-items:center;justify-content:center;gap:6px;min-height:34px;padding:6px 18px;border-radius:9px;border:1px solid var(--dsw-alias-border-l2, #33333c);background:var(--dsw-alias-bg-layer-3, #26262e);color:var(--dsw-alias-label-primary, #f2f2f5);font-size:13px;font-weight:500;cursor:pointer;font-family:var(--dsw-font-family, system-ui, sans-serif);white-space:nowrap}
.dsc-btn:hover{border-color:var(--dsw-alias-border-l3, #44444f);background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))}
.dsc-btn:disabled{opacity:.5;cursor:not-allowed}
.dsc-btn-primary{background:var(--dsw-alias-state-business-primary, #4c8dff);border-color:transparent;color:var(--dsw-alias-label-primary-inverted, #fff)}
.dsc-btn-primary:hover{filter:brightness(1.06)}
.dsc-spin{width:14px;height:14px;border-radius:50%;border:2px solid rgba(255,255,255,.35);border-top-color:#fff;animation:dscspin .7s linear infinite}
@keyframes dscspin{to{transform:rotate(360deg)}}
</style>`

function ensureStyles () {
  if (typeof document === 'undefined') return
  if (document.getElementById(STYLE_ID)) return
  const host = document.createElement('div')
  host.innerHTML = STYLE
  const style = host.firstElementChild
  if (style && style.parentNode) style.parentNode.removeChild(style)
  if (style) document.head.appendChild(style)
}

// ── DOM 小工具 ──────────────────────────────────────────────────────────────

function el (tag, attrs, children) {
  const node = document.createElement(tag)
  if (attrs) {
    for (const key of Object.keys(attrs)) {
      const value = attrs[key]
      if (value === undefined || value === null || value === false) continue
      if (key === 'class') node.className = value
      else if (key === 'text') node.textContent = value
      else if (key === 'style' && typeof value === 'object') Object.assign(node.style, value)
      else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2), value)
      else node.setAttribute(key, value === true ? '' : String(value))
    }
  }
  for (const child of Array.isArray(children) ? children : (children === undefined || children === null ? [] : [children])) {
    if (child === null || child === undefined || child === false) continue
    node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
  }
  return node
}

// ── 会话读取（对齐 dsh-mcp-manager 客户端：读不到就分 unknown，不清任何东西）──

function readCurrentSession (sessions) {
  try {
    const list = sessions && sessions.list
    if (!list || typeof list.getSnapshot !== 'function') return { kind: 'unknown' }
    const snap = list.getSnapshot()
    const byId = snap && snap.byId
    const ids = snap && snap.ids
    if (!byId || !Array.isArray(ids)) return { kind: 'unknown' }
    for (const id of ids) {
      const row = byId[id]
      if (row && row.retainedBy && Number(row.retainedBy.mainView) > 0) {
        return { kind: 'session', id: String(id), cwd: typeof row.cwd === 'string' ? row.cwd : undefined }
      }
    }
  } catch {}
  return { kind: 'unknown' }
}

// ── 插件本体 ────────────────────────────────────────────────────────────────

module.exports = {
  name: CLIENT_NAME,
  inject: ['sessions'],
  apply (ctx) {
    return ctx.effect(() => {
      ensureStyles()
      if (typeof document === 'undefined') return () => {}

      const open = new Map() // requestId → { card, overlay, input, statusNode, buttons }
      let es = null
      const m = CLIENT_MESSAGES[detectLocale()] || CLIENT_MESSAGES.en

      const closeCard = (requestId, reason) => {
        const entry = open.get(requestId)
        if (!entry) return
        open.delete(requestId)
        if (entry.detachKey) { try { entry.detachKey() } catch {} }
        if (entry.tick) { try { clearInterval(entry.tick) } catch {} }
        // 输入框里的值先抹掉再拆 DOM，减少残留窗口
        try {
          if (entry.input) entry.input.value = ''
          if (entry.input) entry.input.blur()
        } catch {}
        try { entry.overlay.remove() } catch {}
        // 取消时顺手告知宿主，让工具尽快返回 cancelled
        if (reason === 'user') {
          fetch(`${API}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId })
          }).catch(() => {})
        }
      }

      const setStatus = (entry, text, kind) => {
        if (!entry.statusNode) return
        entry.statusNode.className = `dsc-status${kind ? ' ' + kind : ''}`
        entry.statusNode.textContent = text
      }

      const submit = async (entry) => {
        const requestId = entry.requestId
        const secret = entry.input ? entry.input.value : ''
        if (!secret) {
          setStatus(entry, m.emptySecret, 'err')
          try { entry.input.focus() } catch {}
          return
        }
        const submitBtn = entry.buttons.submit
        const cancelBtn = entry.buttons.cancel
        submitBtn.disabled = true
        cancelBtn.disabled = true
        cancelBtn.textContent = m.cancel
        submitBtn.textContent = ''
        submitBtn.appendChild(el('span', { class: 'dsc-spin' }))
        setStatus(entry, m.writing)
        let payload
        try {
          const res = await fetch(`${API}/fill`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId, secret })
          })
          if (!res.ok) {
            // 401/403 多半是宿主的跨站校验拦住了这次提交；404 多半是请求已超时被清掉
            payload = { ok: false, error: `http_${res.status}` }
          } else {
            payload = await res.json().catch(() => null)
          }
        } catch (error) {
          payload = null
        }
        // 密钥使命完成：立刻从 DOM 上抹掉
        try { if (entry.input) entry.input.value = '' } catch {}
        if (!payload) {
          setStatus(entry, m.submitFailed, 'err')
          submitBtn.disabled = false
          cancelBtn.disabled = false
          submitBtn.textContent = m.submitDone
          return
        }
        if (payload.ok === false) {
          const code = payload.reason || payload.error || ''
          const text = (m.reasons && m.reasons[code]) || code || m.genericError
          setStatus(entry, `${text}${m.submitRetry}`, 'err')
          submitBtn.disabled = false
          cancelBtn.disabled = false
          submitBtn.textContent = m.submitDone
          return
        }
        const v = payload.validation
        const detail = payload.validationDetail ? m.wrapDetail(payload.validationDetail) : ''
        if (v === 'passed') setStatus(entry, m.okPassed(detail), 'ok')
        else if (v === 'failed') setStatus(entry, m.okFailed(detail), 'err')
        else setStatus(entry, m.okNone, 'ok')
        submitBtn.textContent = m.submitOk
        submitBtn.disabled = true
        setTimeout(() => closeCard(requestId), 1600)
      }

      const openCard = (card) => {
        if (!card || typeof card.requestId !== 'string') return
        if (open.has(card.requestId)) return
        const title = typeof card.label === 'string' && card.label.trim() ? card.label.trim() : m.defaultTitle
        const targetFile = typeof card.file === 'string' ? card.file : ''
        const targetKey = typeof card.key === 'string' ? card.key : ''
        const masked = card.masked !== false

        const statusNode = el('div', { class: 'dsc-status' })
        const input = el('input', {
          class: 'dsc-input',
          type: masked ? 'password' : 'text',
          placeholder: m.placeholder,
          autocomplete: 'new-password',
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: 'false'
        })
        const toggleBtn = el('button', {
          class: 'dsc-toggle',
          type: 'button',
          text: masked ? m.show : m.hide,
          onclick: () => {
            const nowHidden = input.type === 'password'
            input.type = nowHidden ? 'text' : 'password'
            toggleBtn.textContent = nowHidden ? m.hide : m.show
          }
        })
        const submitBtn = el('button', { class: 'dsc-btn dsc-btn-primary', type: 'button', text: m.submitDone })
        const cancelBtn = el('button', { class: 'dsc-btn', type: 'button', text: m.cancel })

        const overlay = el('div', {
          class: 'dsc-overlay',
          role: 'dialog',
          'aria-modal': 'true',
          'aria-label': title
        })
        const cardNodes = [
          el('div', { class: 'dsc-title', text: title }),
          el('div', { class: 'dsc-file' }, [
            m.fileLabel,
            el('b', { text: targetFile }),
            m.keyLabel,
            el('b', { text: targetKey })
          ])
        ]
        if (typeof card.hint === 'string' && card.hint.trim()) {
          cardNodes.push(el('div', { class: 'dsc-hint', text: card.hint }))
        }
        cardNodes.push(el('div', {
          class: 'dsc-safety'
        }, [
          el('b', { text: m.safetyTitle }),
          m.safetyBody
        ]))
        if (card.willValidate) {
          cardNodes.push(el('div', { class: 'dsc-safety', text: m.willValidate }))
        }
        if (card.seenBefore) {
          cardNodes.push(el('div', { class: 'dsc-safety', text: m.seenBefore }))
        }
        const countdownNode = el('div', { class: 'dsc-countdown' })
        cardNodes.push(countdownNode)
        cardNodes.push(el('div', { class: 'dsc-field' }, [input, toggleBtn]))
        cardNodes.push(statusNode)
        cardNodes.push(el('div', { class: 'dsc-actions' }, [cancelBtn, submitBtn]))
        const cardEl = el('div', { class: 'dsc-card' }, cardNodes)
        overlay.appendChild(cardEl)

        const entry = { requestId: card.requestId, overlay, input, statusNode, buttons: { submit: submitBtn, cancel: cancelBtn }, tick: null }
        open.set(card.requestId, entry)

        // 倒计时：让用户知道这张卡还能挂多久；到点自己收掉并通知宿主取消，
        // 避免「卡片一直挂着没人管」的观感
        const deadline = typeof card.expiresAt === 'number' && card.expiresAt > Date.now() ? card.expiresAt : null
        if (deadline) {
          entry.tick = setInterval(() => {
            const left = Math.max(0, deadline - Date.now())
            countdownNode.textContent = left > 0
              ? m.countdownLeft(`${Math.floor(left / 60000)}:${String(Math.floor(left % 60000 / 1000)).padStart(2, '0')}`)
              : m.countdownOver
            if (left <= 0) {
              clearInterval(entry.tick)
              closeCard(card.requestId, 'user')
            }
          }, 1000)
        }

        submitBtn.addEventListener('click', () => { submit(entry) })
        cancelBtn.addEventListener('click', () => closeCard(card.requestId, 'user'))
        input.addEventListener('keydown', (event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            submit(entry)
          }
        })
        overlay.addEventListener('mousedown', (event) => {
          if (event.target === overlay) closeCard(card.requestId, 'user')
        })
        const onKey = (event) => {
          if (event.key === 'Escape' && open.has(card.requestId)) {
            event.preventDefault()
            closeCard(card.requestId, 'user')
          }
        }
        document.addEventListener('keydown', onKey)
        entry.detachKey = () => document.removeEventListener('keydown', onKey)

        document.body.appendChild(overlay)
        setTimeout(() => { try { input.focus() } catch {} }, 30)
      }

      const handleEvent = (raw) => {
        let payload
        try { payload = JSON.parse(raw) } catch { return }
        if (!payload || typeof payload !== 'object') return
        if (payload.type === 'card.request') openCard(payload)
        else if (payload.type === 'card.cancel') {
          const entry = open.get(payload.requestId)
          if (entry && entry.detachKey) entry.detachKey()
          closeCard(payload.requestId)
        } else if (payload.type === 'card.result') {
          // 宿主已结算（写入成功/失败/取消/超时）：本地这张卡必须收掉，否则会出现
          // 「已经写完了卡片还挂着」的观感（bug：输入密码后卡片不消失）
          const entry = open.get(payload.requestId)
          if (entry && entry.detachKey) entry.detachKey()
          closeCard(payload.requestId)
        }
      }

      const fetchPending = async () => {
        try {
          const session = readCurrentSession(ctx.sessions)
          const url = session.kind === 'session'
            ? `${API}/pending?sessionId=${encodeURIComponent(session.id)}`
            : `${API}/pending`
          const res = await fetch(url)
          if (!res.ok) return
          const payload = await res.json().catch(() => null)
          const list = payload && Array.isArray(payload.requests) ? payload.requests : []
          for (const card of list) openCard(card)
        } catch {}
      }

      const start = () => {
        try {
          es = new EventSource(`${API}/events`)
          es.onmessage = (event) => handleEvent(event.data)
          es.onerror = () => { /* EventSource 自带重连；pending 轮询兜底 */ }
        } catch {}
      }

      start()
      fetchPending()
      const poll = setInterval(() => { if (open.size > 0) fetchPending() }, 10000)
      const onVisible = () => { if (document.visibilityState === 'visible') fetchPending() }
      document.addEventListener('visibilitychange', onVisible)

      return () => {
        try { clearInterval(poll) } catch {}
        try { document.removeEventListener('visibilitychange', onVisible) } catch {}
        try { if (es) es.close() } catch {}
        for (const requestId of [...open.keys()]) {
          const entry = open.get(requestId)
          if (entry && entry.detachKey) entry.detachKey()
          closeCard(requestId)
        }
      }
    }, `${CLIENT_NAME}: card`)
  }
}
