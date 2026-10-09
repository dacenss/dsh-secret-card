/* eslint-disable */
/**
 * dsh-secret-card — 客户端：密钥输入卡片 + 设置面板
 *
 * 纯 DOM 实现，不依赖 React：宿主通过 SSE 把「需要用户输入一个密钥」推给页面，
 * 页面底部停靠一张卡片；用户输入后用同源 fetch 提交，密钥走完那一次请求就交
 * 给宿主编入配置文件。卡片上明确告诉用户：内容不会进对话记录，AI 看不到。
 *
 * 视觉契约对齐宿主内置的提问卡片（@deepseek-ai/dsh-client-ui-user-questions 的
 * QuestionComposer）：同一套 dsw-alias / dsw-radius / dsh-content-font 主题变量、
 * 同一套圆角/边框/标签色阶、同一套 Button 样式，浅色深色自动跟随。
 *
 * 会话门禁：只给「当前正在看的会话」弹卡片。别的会话来的请求先排队，切过去再弹；
 * 读不到当前会话时不弹（除非排队超过 8 秒，作为兜底避免插件像坏掉一样没反应）。
 *
 * 产物由 scripts/build-client.mjs 包成 window.__ModuleLoader__.load(...) 外壳，
 * 本文件不要直接改产物。
 */

const CLIENT_NAME = 'dsh-secret-card'
const API = '/dsh-secret-card/api'
const STYLE_ID = 'dsc-secret-card-style'

// 读不到当前会话时，排队中的卡片最多等这么久就放行（兜底，避免插件像没装）
const UNKNOWN_GRACE_MS = 8000

// ── 多语言 ─────────────────────────────────────────────────────────────────
// 语言优先级：宿主推送的 card.locale（来自插件设置里的 language）> 浏览器语言。
// 宿主侧另有一张大表（src/index.js 的 MESSAGES），两边判定保持一致：
// 只要语言串以 zh 开头（zh / zh-CN / zh-TW / zh-Hant…）就走中文，其余一律英文。

const CLIENT_MESSAGES = {
  zh: {
    eyebrow: '安全输入',
    emptySecret: '请先输入密钥。',
    writing: '正在写入配置文件…',
    submitFailed: '提交失败：网络错误或宿主无响应，可以重试或取消。',
    submitRetry: '卡片保持打开，可以重试或取消。',
    submitDone: '确定写入',
    submitOk: '完成',
    cancel: '取消',
    minimize: '收起',
    expand: '展开',
    dismiss: '关闭',
    defaultTitle: '请输入密钥',
    placeholder: '在这里粘贴或输入密钥',
    show: '显示',
    hide: '隐藏',
    fileLabel: '写入文件',
    keyLabel: '键名',
    safetyTitle: '安全说明：',
    safetyBody: '你在这里输入的密钥不会出现在对话记录里，AI 也看不到；它只会被写入上面这个文件。',
    autoCancel: '倒计时结束前没有输入，这次请求会自动取消，不会写入任何内容。',
    willValidate: '写入后会自动验证这个密钥是否生效，并把结果告诉助手。',
    seenBefore: '注意：这个键此前已经写入过一次，请确认要再次输入。',
    waiting: '已为其他会话暂存这张卡片，切回该会话后会显示。',
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
    countdownLeft: s => `剩余 ${s}`,
    countdownOver: '已超时',
    // ── 设置面板 ──
    tabLabel: '密钥卡片',
    itemSummary: '密钥安全输入：AI 需要密钥时弹卡，由你直接输入并写入配置文件。',
    settingsLanguage: '界面语言',
    settingsLanguageHelp: '自动 = 跟随应用语言。',
    settingsLanguageAuto: '自动',
    settingsTimeout: '等待输入的超时时间',
    settingsTimeoutHelp: '秒。超过这个时间还没输入，卡片会自动取消，助手会收到取消结果。',
    settingsTimeoutInvalid: '请填 5 到 600 之间的整数。',
    settingsBackup: '写入前备份原文件',
    settingsBackupHelp: '改配置前先把原文件复制一份，出问题可以回退。',
    settingsBackupKeep: '保留几份备份',
    settingsBackupKeepHelp: '0 到 50 之间的整数，填 0 表示只留一份。',
    settingsBackupKeepInvalid: '请填 0 到 50 之间的整数。',
    settingsCommandValidation: '允许命令验证',
    settingsCommandValidationHelp: '写入后可以运行一条命令来确认密钥是否生效。默认关闭，开启后命令只能来自本插件的请求。',
    settingsSuffixes: '允许写入的文件类型',
    settingsSuffixesHelp: '用逗号分隔，例如 .env, .json, .yaml。不在这里的后缀会被拒绝。',
    settingsSuffixesInvalid: '至少填一个后缀。',
    settingsDenyHosts: '命令验证禁止访问的地址',
    settingsDenyHostsHelp: '用逗号分隔。这些地址不会被命令验证访问，用于挡住本机和内网元数据接口。',
    settingsDenyHostsInvalid: '请按逗号分隔填写。',
    settingsSave: '保存',
    settingsSaved: '已保存',
    settingsReset: '恢复默认',
    settingsLoadFailed: '读不到当前设置，显示的是默认值。',
    settingsSaveFailed: '保存失败，可以重试。',
    settingsPersistFailed: '没能写进配置文件，这次改动重启后会丢',
    settingsDefault: '默认'
  },
  en: {
    eyebrow: 'Secure input',
    emptySecret: 'Please enter the secret first.',
    writing: 'Writing to the config file…',
    submitFailed: 'Submission failed: network error or no response from the app. You can retry or cancel.',
    submitRetry: 'The card stays open — you can retry or cancel.',
    submitDone: 'Write it',
    submitOk: 'Done',
    cancel: 'Cancel',
    minimize: 'Collapse',
    expand: 'Expand',
    dismiss: 'Close',
    defaultTitle: 'Enter the secret',
    placeholder: 'Paste or type the secret here',
    show: 'Show',
    hide: 'Hide',
    fileLabel: 'File',
    keyLabel: 'Key',
    safetyTitle: 'Security note: ',
    safetyBody: 'The secret you type here never appears in the conversation and the AI cannot see it. It only gets written into the file above.',
    autoCancel: 'If nothing is entered before the timer runs out, the request is cancelled and nothing is written.',
    willValidate: 'After writing, the plugin checks whether the secret works and tells the assistant.',
    seenBefore: 'Note: this key was already written once. Please confirm you want to enter it again.',
    waiting: 'Held for another session — it shows up when you switch back to it.',
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
    countdownLeft: s => `${s} left`,
    countdownOver: 'Timed out',
    // ── Settings panel ──
    tabLabel: 'Secret Card',
    itemSummary: 'Secure input: when the AI needs a secret, a card asks you to type it straight into the config file.',
    settingsLanguage: 'Language',
    settingsLanguageHelp: 'Auto follows the app language.',
    settingsLanguageAuto: 'Auto',
    settingsTimeout: 'How long to wait for input',
    settingsTimeoutHelp: 'Seconds. Past this the card cancels itself and the assistant gets a cancelled result.',
    settingsTimeoutInvalid: 'Enter a whole number between 5 and 600.',
    settingsBackup: 'Back up the file before writing',
    settingsBackupHelp: 'Copy the original file first so you can roll back.',
    settingsBackupKeep: 'Backups to keep',
    settingsBackupKeepHelp: 'Whole number from 0 to 50; 0 keeps a single backup.',
    settingsBackupKeepInvalid: 'Enter a whole number between 0 and 50.',
    settingsCommandValidation: 'Allow command validation',
    settingsCommandValidationHelp: 'After writing, a command may run to confirm the secret works. Off by default; when on, only this plugin can trigger it.',
    settingsSuffixes: 'File types that may be written',
    settingsSuffixesHelp: 'Comma separated, e.g. .env, .json, .yaml. Other suffixes are refused.',
    settingsSuffixesInvalid: 'Enter at least one suffix.',
    settingsDenyHosts: 'Hosts command validation may not touch',
    settingsDenyHostsHelp: 'Comma separated. Blocks localhost and internal metadata endpoints.',
    settingsDenyHostsInvalid: 'Use comma separated values.',
    settingsSave: 'Save',
    settingsSaved: 'Saved',
    settingsReset: 'Reset to defaults',
    settingsLoadFailed: 'Could not read current settings — showing defaults.',
    settingsSaveFailed: 'Saving failed — you can retry.',
    settingsPersistFailed: 'Could not write the config file — this change is lost on restart',
    settingsDefault: 'Default'
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

// 语言档位归一，与宿主侧 SUPPORTED_LOCALES 同规则：只认 zh / en，其余算 auto
function normLocale (raw) {
  const v = String(raw || '').trim().toLowerCase()
  return (v === 'zh' || v === 'en') ? v : 'auto'
}


// ── 样式（全部用宿主主题变量 + 兜底色值，浅色/深色自适应）───────────────────
// 形状与内置提问卡片一致：圆角 var(--dsw-radius-xl)、面板阴影、标签三级色阶、
// 输入区一条 0.5px 描边在 focus-within 时变主题色。卡片是底部停靠、非模态，
// 不再盖全屏遮罩，避免把用户正在看的页面整个抢走。

const STYLE = `<style id="${STYLE_ID}">
.dsc-frame{position:fixed;left:0;right:0;bottom:0;z-index:900;display:flex;justify-content:center;padding:6px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 10px;pointer-events:none}
/* 宿主「输入框座位」插槽（conversation.composer，chain + overlay）的落脚外形。
   逐条复刻内置 QuestionComposer 的 .frame：宿主选举出这张卡时，会把含输入框的
   那一整块 fallback 用 display:none 藏掉 —— 卡片一出来输入框就让位，收起来再回来 */
.dsc-composer{display:flex;justify-content:center;flex:none;padding:6px calc(var(--dsh-composer-side-clearance, 0px) + 16px) 10px}
/* 等宿主插槽来接的过渡态：先占着位但完全隐形，接上了再显形，避免闪一下 */
.dsc-frame.dsc-pending{opacity:0;pointer-events:none}
/* 「用户在不在会话页」探针：挂进宿主输入框上方的插槽里，display:contents 不占任何布局，
   只用来在会话页挂载/卸载时给插件一个信号（用户回来了 / 用户走了） */
.dsc-probe{display:contents}
/* 挂进插槽后就不再抢屏幕：位置和宽度全部交给插槽，fixed 兜底形态只在插槽不可用时出现 */
.dsc-frame.dsc-docked{position:static;padding:0;pointer-events:auto;width:100%;justify-content:center}
.dsc-card{pointer-events:auto;box-sizing:border-box;width:100%;max-width:var(--dsh-chat-content-width, 768px);--dsw-elevation-stroke-color:var(--dsw-alias-border-l2-darkmode-thin, var(--dsw-alias-border-l2, #33333c));border:0;border-radius:var(--dsw-radius-xl, 16px);background:var(--dsw-specific-input-major, var(--dsw-alias-bg-layer-2, #1c1c22));color:var(--dsw-alias-label-primary, #f2f2f5);box-shadow:var(--dsw-elevation-panel, 0 12px 40px rgba(0,0,0,.45));font-family:inherit;font-size:var(--dsh-content-font-size, 14px);line-height:calc(24px + var(--dsh-content-font-delta, 0px));--dsh-scrollbar-thumb:var(--dsw-alias-scrollbar-bg-l2, rgba(127,127,127,.32));--dsh-scrollbar-thumb-hover:var(--dsw-alias-scrollbar-hover-l2, rgba(127,127,127,.45));max-height:min(60vh,520px);display:flex;flex-direction:column;padding:0 0 10px;overflow:hidden;animation:dsc-in .16s ease-out}
.dsc-card *{box-sizing:border-box}
@keyframes dsc-in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}
.dsc-header{flex-shrink:0;justify-content:space-between;align-items:flex-start;gap:16px;padding:20px 16px 0 20px;display:flex}
/* 标题与正文之间的发丝线：左右各让 20px，和正文边距对齐 */
.dsc-divider{flex:none;height:1px;margin:14px 20px 12px;background:var(--dsw-alias-border-l1, rgba(127,127,127,.18))}
.dsc-headingBlock{min-width:0}
.dsc-eyebrow{color:var(--dsw-alias-label-tertiary, #8b8b96);margin-bottom:5px;font-size:11px;line-height:16px}
.dsc-title{margin:0;font-size:16px;font-weight:500;line-height:22px;color:var(--dsw-alias-label-primary, #f2f2f5);overflow-wrap:anywhere}
/* 头部右侧两个图标按钮（收起 / 关闭），逐条复刻内置提问卡片的 .iconButton：
   24px 圆形热区、默认三级色、悬停才浮出底色并提亮 */
.dsc-headerActions{flex-shrink:0;align-items:center;gap:4px;display:flex}
.dsc-iconButton{corner-shape:round;width:24px;height:24px;flex:none;color:var(--dsw-alias-label-tertiary, #8b8b96);cursor:pointer;background:0 0;border:none;border-radius:999px;place-items:center;padding:0;display:grid}
.dsc-iconButton svg{width:16px;height:16px;display:block}
.dsc-iconButton:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06));color:var(--dsw-alias-label-primary, #f2f2f5)}
.dsc-iconButton:disabled{color:var(--dsw-alias-label-dimmed, #5c5c66);cursor:default}
/* 收起态：只留标题一行，和内置卡片的 .cardMinimized 一致 */
.dsc-card.dsc-cardMinimized{max-height:none}
.dsc-card.dsc-cardMinimized .dsc-header{padding-bottom:14px}
.dsc-card.dsc-cardMinimized .dsc-divider{display:none}
.dsc-body{overscroll-behavior:contain;flex:auto;min-height:0;display:flex;flex-direction:column;overflow-y:auto}
/* 以下规则逐条对齐 DSH 内置「问题卡片」（QuestionComposer）的视觉契约：
   同一个 token 体系、同一套间距与字号，两张卡并排时应该像同一个组件 */
.dsc-detail{margin:0 20px 8px;color:var(--dsw-alias-label-tertiary, #8b8b96);font-size:var(--dsh-content-font-size, 14px);line-height:calc(24px + var(--dsh-content-font-delta, 0px));white-space:pre-wrap;overflow-wrap:anywhere}
/* 目标信息两行：复刻内置卡片的编号选项行（.option / .number / .optionLine / .optionLabel / .description） */
.dsc-info{flex-direction:column;gap:1px;margin:8px 0 0;padding:4px 12px;display:flex}
.dsc-infoRow,.dsc-customRow{border-radius:var(--dsw-radius-md, 8px);width:100%;min-height:40px;align-items:flex-start;gap:8px;flex-shrink:0;padding:8px 12px 8px 8px;display:flex}
.dsc-infoRow{border:1px solid transparent;transition:background-color .12s,border-color .12s}
.dsc-number{border-radius:var(--dsw-radius-xs, 4px);background:var(--dsw-alias-bg-overlay, rgba(127,127,127,.14));width:20px;height:20px;color:var(--dsw-alias-label-secondary, #b8b8c2);flex:0 0 20px;place-items:center;margin-top:2px;font-size:12px;font-weight:500;line-height:18px;display:grid}
.dsc-number svg{width:12px;height:12px;display:block}
.dsc-optionCopy{flex:1;min-width:0;display:flex;flex-wrap:wrap;align-items:baseline;gap:2px 6px}
.dsc-optionLabel{font-size:14px;font-weight:500;line-height:24px;color:var(--dsw-alias-label-primary, #f2f2f5)}
.dsc-description{color:var(--dsw-alias-label-tertiary, #8b8b96);font-size:14px;font-weight:400;line-height:24px;overflow-wrap:anywhere}
/* 输入行：复刻内置卡片的 .customRow——和选项行同一套几何（透明底、细边、40px 高），
   悬停/聚焦才浮出底色与描边，不额外套一个方盒子 */
.dsc-customRow{border:1px solid transparent;transition:background-color .12s,border-color .12s;align-items:center}
.dsc-customRow:hover,.dsc-customRow:focus-within{background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))}
.dsc-customRow:focus-within{border-color:var(--dsw-alias-border-l2, #33333c)}
.dsc-customRow .dsc-number{margin-top:0}
.dsc-input{flex:1;min-width:0;height:24px;padding:0;border:none;outline:none;background:0 0;color:var(--dsw-alias-label-primary, #f2f2f5);caret-color:var(--dsw-alias-state-business-primary, #4c8dff);font-family:inherit;font-size:var(--dsh-content-font-size, 14px);line-height:24px}
.dsc-input::placeholder{color:var(--dsw-alias-label-caption, #8b8b96)}
.dsc-toggle{flex:none;height:28px;padding:0 10px;border-radius:var(--dsw-radius-sm, 6px);border:none;background:transparent;color:var(--dsw-alias-label-secondary, #b8b8c2);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;display:inline-flex;align-items:center;gap:4px}
.dsc-toggle:hover{background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))}
/* 说明文字：复刻内置卡片的 .reviewNote——三级色、14px、左右 12px */
.dsc-notes{margin:8px 0 0;display:flex;flex-direction:column;gap:0}
.dsc-note{color:var(--dsw-alias-label-tertiary, #8b8b96);font-size:14px;line-height:24px;padding:8px 20px;overflow-wrap:anywhere}
.dsc-note.warn{color:var(--dsw-alias-state-warn-primary, #e8a33d)}
/* 底栏：复刻内置卡片的 .footer / .pager / .progress / .feedback / .footerActions */
.dsc-footer{flex-shrink:0;justify-content:space-between;align-items:center;gap:12px;margin-top:12px;padding:0 10px 0 18px;display:flex}
.dsc-pager{flex-shrink:0;align-items:center;gap:6px;display:flex}
.dsc-progress{color:var(--dsw-alias-label-secondary, #b8b8c2);white-space:nowrap;word-spacing:-2px;padding:0 4px;font-size:14px;font-weight:500;line-height:24px}
.dsc-feedback{min-height:16px;color:var(--dsw-alias-label-secondary, #b8b8c2);text-align:right;flex:1;font-size:11px;line-height:16px;overflow-wrap:anywhere}
.dsc-feedback.err{color:var(--dsw-alias-state-error-primary, #ea4335)}
.dsc-feedback.ok{color:var(--dsw-alias-state-success-primary, #34a853)}
/* 设置表单里的状态行沿用内置 settings-form 的 .help 规格 */
.dsc-status{min-height:16px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary, #b8b8c2);overflow-wrap:anywhere}
.dsc-status.ok{color:var(--dsw-alias-state-success-primary, #34a853)}
.dsc-status.err{color:var(--dsw-alias-state-error-primary, #ea4335)}
.dsc-statusHead{font-weight:600}
.dsc-statusDetail{margin-top:2px;font-size:11px;line-height:15px;opacity:.85;white-space:pre-wrap}
.dsc-footerActions{flex-shrink:0;align-items:center;gap:12px;display:flex}
.dsc-btn{display:inline-flex;align-items:center;justify-content:center;gap:4px;height:36px;padding:0 14px;border:none;border-radius:var(--dsw-radius-md, 8px);cursor:pointer;font-family:inherit;font-size:14px;line-height:22px;color:var(--dsw-alias-label-primary, #f2f2f5);background:transparent;white-space:nowrap}
.dsc-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))}
.dsc-btn:disabled{opacity:.4;cursor:not-allowed}
.dsc-btn-primary{background:var(--dsw-alias-button-primary-fill, var(--dsw-alias-state-business-primary, #4c8dff));color:var(--dsw-alias-label-primary-foreground, #fff)}
.dsc-btn-primary:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover, var(--dsw-alias-button-primary-fill, #4c8dff))}
.dsc-btn-outline{border:.5px solid var(--dsw-alias-border-l3, #44444f);background:transparent}
.dsc-btn-outline:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover, rgba(255,255,255,.06))}
.dsc-btn-sm{height:28px;padding:0 10px;font-size:12px;line-height:18px;border-radius:var(--dsw-radius-sm, 6px)}
.dsc-card :focus-visible{outline:2px solid var(--dsw-focus-ring-color, var(--dsw-alias-state-business-primary, #4c8dff));outline-offset:1px}
.dsc-spin{width:14px;height:14px;border-radius:50%;border:2px solid currentColor;border-top-color:transparent;opacity:.7;animation:dscspin .7s linear infinite;display:block}
@keyframes dscspin{to{transform:rotate(360deg)}}
/* 内联到宿主「插件 → 插件名」详情页时的容器：窗口外壳由宿主提供，这里只调内容自身的间距 */
.dsc-settingsHost{display:block}
.dsc-settingsHostSlot{display:block}
.dsc-settingsHost .dsc-settingsBody{margin-top:4px;padding:0;flex:none;overflow:visible}
.dsc-settingsHost .dsc-settingsFooter{padding:12px 0 0}
.dsc-fieldRow{display:flex;flex-direction:column;gap:6px;padding:12px 0}
.dsc-fieldRow + .dsc-fieldRow{border-top:.5px solid var(--dsw-alias-border-l2, #33333c)}
.dsc-fieldHead{display:flex;align-items:center;justify-content:space-between;gap:12px}
.dsc-fieldLabel{flex:1;font-size:13px;font-weight:500;line-height:1.5;color:var(--dsw-alias-label-primary, #f2f2f5)}
.dsc-fieldHelp{padding:0;font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary, #b8b8c2);white-space:pre-wrap;overflow-wrap:anywhere}
.dsc-fieldHint{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-tertiary, #8b8b96)}
.dsc-fieldInvalid{font-size:12px;line-height:1.6;color:var(--dsw-alias-state-error-primary, #ea4335)}
.dsc-fieldInput{height:34px;width:100%;box-sizing:border-box;padding:0 12px;border:.5px solid var(--dsw-alias-border-l4, #3a3a44);border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-3, #26262e);font-family:inherit;font-size:13px;color:var(--dsw-alias-label-primary, #f2f2f5)}
.dsc-fieldInput:focus-visible{border-color:var(--dsw-alias-state-business-primary, #4c8dff);outline:none}
.dsc-fieldInput[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary, #ea4335)}
.dsc-switch{position:relative;width:36px;height:20px;padding:2px;border:0;border-radius:999px;corner-shape:round;background:var(--dsw-alias-border-l3, #44444f);cursor:pointer;flex:none}
.dsc-switch[aria-checked=true]{background:var(--dsw-alias-brand-primary, #4c8dff)}
.dsc-switchThumb{display:block;width:16px;height:16px;border-radius:50%;background:var(--dsw-alias-label-primary-foreground, #fff);transition:transform 120ms ease}
.dsc-switch[aria-checked=true] .dsc-switchThumb{transform:translateX(16px)}
.dsc-switch[aria-checked=false] .dsc-switchThumb{background:var(--dsw-alias-switch-thumb, #fff)}
.dsc-segment{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:var(--dsw-radius-md, 8px);background:var(--dsw-alias-bg-layer-3, #26262e)}.dsc-segment button{height:28px;padding:0 12px;border:none;border-radius:var(--dsw-radius-sm, 6px);background:transparent;color:var(--dsw-alias-label-secondary, #b8b8c2);font-family:inherit;font-size:12px;line-height:18px;cursor:pointer;white-space:nowrap}
.dsc-segment button[aria-pressed=true]{background:var(--dsw-alias-bg-overlay, rgba(127,127,127,.2));color:var(--dsw-alias-label-primary, #f2f2f5);font-weight:500}
@media (width<=720px){
  /* 与内置问题卡片同一套窄屏断点 */
  .dsc-frame{padding:6px 12px 10px}
  .dsc-composer{padding:6px 12px 10px}
  .dsc-header{padding:10px 12px 0 18px}
  .dsc-title{font-size:15px;line-height:21px}
  .dsc-detail{margin:0 12px 8px}
  .dsc-info{padding:4px 12px}
  .dsc-infoRow,.dsc-customRow{padding:8px 6px}
  .dsc-note{padding:8px 12px}
  .dsc-footer{align-items:flex-end;padding:0 10px}
}
@media (prefers-reduced-motion:reduce){
  .dsc-card{animation:none}
  .dsc-switchThumb{transition:none}
  .dsc-infoRow,.dsc-customRow{transition:none}
}
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

// ── 图标（内联 SVG，描边跟随 currentColor，自动适配主题色）────────────────

const ICON_LOCK = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><rect x="3.2" y="7" width="9.6" height="6.8" rx="1.6"/><path d="M5.6 7V5.2a2.4 2.4 0 0 1 4.8 0V7"/></svg>'
const ICON_FILE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 2.6h4.8l3.2 3.2v7.6a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V3.6a1 1 0 0 1 1-1z"/><path d="M8.8 2.6v3.2H12"/></svg>'
const ICON_KEY = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><circle cx="5.4" cy="10.6" r="2.6"/><path d="M7.4 8.6l4.8-4.8M10.4 5.6l1.6 1.6M12 4l1.6 1.6"/></svg>'
const ICON_CHEVRON_DOWN = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 6.2l4 4 4-4"/></svg>'
const ICON_CHEVRON_UP = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 9.8l4-4 4 4"/></svg>'
const ICON_CLOSE = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><path d="M4.2 4.2l7.6 7.6M11.8 4.2l-7.6 7.6"/></svg>'

function iconNode (markup) {
  const host = document.createElement('div')
  host.innerHTML = markup
  return host.firstElementChild
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

function clampInt (value, min, max) {
  if (!Number.isFinite(value)) return min
  return Math.min(max, Math.max(min, Math.round(value)))
}

function splitList (raw) {
  return String(raw || '')
    .split(/[,，\n\r\t]+/)
    .map((s) => s.trim())
    .filter(Boolean)
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
  // slots：宿主设置页的插槽表（静态模块，开机就在），用来把设置面板注册进
  // 左侧面板「插件 → 插件名」这个 tab 里
  inject: ['sessions', 'slots', 'uiSession'],
  apply (ctx) {
    return ctx.effect(() => {
      ensureStyles()
      if (typeof document === 'undefined') return () => {}

      // 语言：先按浏览器猜，宿主每张卡片都会带上生效语言，收到就校正
      let locale = detectLocale()
      const t = () => CLIENT_MESSAGES[locale] || CLIENT_MESSAGES.en
      const applyLocale = (tag) => {
        if (tag === 'zh' || tag === 'en') locale = tag
      }

      // 当前可见会话。只有它名下的请求才弹卡片，别的会话先排队
      let current = { kind: 'unknown', id: '' }
      const refreshSession = () => { current = readCurrentSession(ctx.sessions) }

      // 宿主「输入框座位」插槽（conversation.composer，chain + overlay）给出的容器。
      // 宿主渲染这个链时带 overlay:true：选举出的那一项一渲染，含输入框的 fallback 就被
      // display:none 整块藏掉。所以卡片挂进来之后，输入框自动让位、收起/关掉再回来，
      // 和内置问答卡片弹出来时的行为完全一致。
      // 插槽从来没挂上过（宿主版本不支持）时，才退回 body 上的底部停靠兜底形态。
      let seatHost = null
      let seatEverMounted = false
      let seatLive = false
      let seatDeclined = false
      let seatDisposer = null
      // 「用户在不在会话页」探针的注册结果与实时状态。conversation.input.dock 只有会话页
      // 才会挂载，所以拿它当探针最准；probeRegistered 表示宿主认这个插槽
      let probeDisposer = null
      let probeRegistered = false
      let pageLive = false
      // 先占个位：真正实现在文件后面（要用到 React 探测和 open/waiting 这些表），
      // 但 openCard / closeCard 会调它，先给个空实现，免得碰上声明时序问题
      let syncComposerSeat = () => {}

      const open = new Map()    // requestId → entry（页面上挂着的卡片）
      const waiting = new Map() // requestId → { card, since }（别的会话的请求，排队中）

      // ── 事件化：让宿主知道「这个会话有人在等我」 ──
      // 走宿主官方接口 ctx.uiSession.registerPendingInteraction(precedence)：拿到一个
      // publish 函数，往会话状态里发一条 kind 为 question 的「待应答」。宿主会话列表立刻
      // 亮黄点（status.waitingAnswer / state:warning），dsh-notify-me 也会弹一次提醒。
      // 卡片一关就调 remove() 撤下，绝不留下僵尸提醒。
      // 注意：uiSession 必须写进本模块的 inject 列表（官方 approval 插件就是这么干的），
      // 否则 ctx.uiSession 是 undefined，这一段会静默失效、黄点和提醒都不出现。
      // precedence 传 () => 0，和官方 approval 域一致：同会话多条待应答时按注册先后，
      // 后注册的不抢占先来的（>= 才替换），内置问答卡片优先级同样为 0，互不覆盖。
      let publishInteraction = null
      let interactionTried = false
      const getPublisher = () => {
        if (interactionTried) return publishInteraction
        interactionTried = true
        try {
          const svc = ctx.uiSession
          if (svc && typeof svc.registerPendingInteraction === 'function') {
            publishInteraction = svc.registerPendingInteraction(() => 0)
          }
        } catch {
          publishInteraction = null
        }
        // 拿不到就留个痕迹：否则「事件化没生效」会像这次一样只能靠用户截图才发现
        if (!publishInteraction && typeof console !== 'undefined' && console.warn) {
          console.warn('[dsh-secret-card] 拿不到 ctx.uiSession，会话黄点/提醒不会亮；检查 inject 列表是否含 uiSession')
        }
        return publishInteraction
      }
      // 已登记的待应答：requestId → 撤下函数。
      // 单独一张表、不挂在卡片对象上，是因为「登记」和「卡片有没有显示出来」是两件事：
      // 用户不在会话页时卡片在排队（waiting）不显示，但「有人在等你」这个事实已经成立，
      // 黄点和提醒必须立刻亮。早先只在 openCard 里登记，结果非要等用户切回会话才提醒。
      const announced = new Map()
      // 发一条待应答。文本字段按 dsh-notify-me 的 textFromPayload 取值顺序给足，
      // 它取第一个非空字符串（title 优先），所以这里 title 就是提醒正文
      const announceCard = (card) => {
        const requestId = card && card.requestId
        if (typeof requestId !== 'string' || announced.has(requestId)) return
        const publish = getPublisher()
        if (!publish) return
        try {
          const label = typeof card.label === 'string' && card.label.trim() ? card.label.trim() : t().defaultTitle
          announced.set(requestId, publish({
            key: `${CLIENT_NAME}:${requestId}`,
            sessionId: typeof card.sessionId === 'string' ? card.sessionId : '',
            kind: 'question',
            title: label,
            hint: typeof card.hint === 'string' ? card.hint : ''
          }, async () => {}))
        } catch {
          announced.delete(requestId)
        }
      }
      const retractCard = (requestId) => {
        const remove = announced.get(requestId)
        if (typeof remove !== 'function') return
        announced.delete(requestId)
        try { remove() } catch {}
      }

      // ── 卡片 ──
      const closeCard = (requestId, reason) => {
        const entry = open.get(requestId)
        if (!entry) return
        open.delete(requestId)
        if (entry.detachKey) { try { entry.detachKey() } catch {} }
        if (entry.tick) { try { clearInterval(entry.tick) } catch {} }
        if (entry.pendingTimer) { try { clearTimeout(entry.pendingTimer) } catch {} }
        // 输入框里的值先抹掉再拆 DOM，减少残留窗口
        try {
          if (entry.input) entry.input.value = ''
          if (entry.input) entry.input.blur()
        } catch {}
        try { entry.frame.remove() } catch {}
        // 取消时顺手告知宿主，让工具尽快返回 cancelled
        if (reason === 'user') {
          fetch(`${API}/cancel`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ requestId })
          }).catch(() => {})
        }
        // 卡片少了一张：重新选举一次，让剩下的卡片接上位、或者把输入框放回来
        retractCard(entry.requestId)
        try { syncComposerSeat() } catch {}
      }

      const setStatus = (entry, text, kind) => {
        if (!entry.statusNode) return
        entry.statusNode.className = `dsc-feedback${kind ? ' ' + kind : ''}`
        entry.statusNode.textContent = text
      }

      const submit = async (entry) => {
        const requestId = entry.requestId
        const secret = entry.input ? entry.input.value : ''
        if (!secret) {
          setStatus(entry, t().emptySecret, 'err')
          try { entry.input.focus() } catch {}
          return
        }
        const submitBtn = entry.buttons.submit
        const cancelBtn = entry.buttons.cancel
        submitBtn.disabled = true
        cancelBtn.disabled = true
        submitBtn.textContent = ''
        submitBtn.appendChild(el('span', { class: 'dsc-spin' }))
        setStatus(entry, t().writing)
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
          setStatus(entry, t().submitFailed, 'err')
          submitBtn.disabled = false
          cancelBtn.disabled = false
          submitBtn.textContent = t().submitDone
          return
        }
        if (payload.ok === false) {
          const code = payload.reason || payload.error || ''
          const text = (t().reasons && t().reasons[code]) || code || t().genericError
          setStatus(entry, `${text}${t().submitRetry}`, 'err')
          submitBtn.disabled = false
          cancelBtn.disabled = false
          submitBtn.textContent = t().submitDone
          return
        }
        const v = payload.validation
        const detail = payload.validationDetail ? t().wrapDetail(payload.validationDetail) : ''
        if (v === 'passed') setStatus(entry, t().okPassed(detail), 'ok')
        else if (v === 'failed') setStatus(entry, t().okFailed(detail), 'err')
        else setStatus(entry, t().okNone, 'ok')
        submitBtn.textContent = t().submitOk
        submitBtn.disabled = true
        setTimeout(() => closeCard(requestId), 1600)
      }

      const openCard = (card) => {
        if (!card || typeof card.requestId !== 'string') return
        if (open.has(card.requestId)) return
        applyLocale(card.locale)
        const title = typeof card.label === 'string' && card.label.trim() ? card.label.trim() : t().defaultTitle
        const targetFile = typeof card.file === 'string' ? card.file : ''
        const targetKey = typeof card.key === 'string' ? card.key : ''
        const masked = card.masked !== false

        const statusNode = el('div', { class: 'dsc-feedback' })
        const input = el('input', {
          class: 'dsc-input',
          type: masked ? 'password' : 'text',
          placeholder: t().placeholder,
          autocomplete: 'new-password',
          autocapitalize: 'off',
          autocorrect: 'off',
          spellcheck: 'false'
        })
        const toggleBtn = el('button', {
          class: 'dsc-toggle',
          type: 'button',
          text: masked ? t().show : t().hide,
          onclick: () => {
            const nowHidden = input.type === 'password'
            input.type = nowHidden ? 'text' : 'password'
            toggleBtn.textContent = nowHidden ? t().hide : t().show
          }
        })
        const submitBtn = el('button', { class: 'dsc-btn dsc-btn-primary dsc-btn-sm', type: 'button', text: t().submitDone })
        const cancelBtn = el('button', { class: 'dsc-btn dsc-btn-outline dsc-btn-sm', type: 'button', text: t().cancel })

        // 目标信息两行 + 输入行，全都落进同一个容器：和内置卡片的「编号选项 + 自定义输入行」
        // 是同一套排布（20px 方块 + 同一行基线文案），看起来像同一个组件画出来的
        const infoRow = (icon, label, value) => el('div', { class: 'dsc-infoRow' }, [
          el('div', { class: 'dsc-number' }, [iconNode(icon)]),
          el('div', { class: 'dsc-optionCopy' }, [
            el('div', { class: 'dsc-optionLabel', text: label }),
            el('div', { class: 'dsc-description', text: value })
          ])
        ])
        const infoBlock = el('div', { class: 'dsc-info' }, [
          infoRow(ICON_FILE, t().fileLabel, targetFile),
          infoRow(ICON_KEY, t().keyLabel, targetKey),
          el('div', { class: 'dsc-customRow' }, [
            el('div', { class: 'dsc-number' }, [iconNode(ICON_LOCK)]),
            input,
            toggleBtn
          ])
        ])

        const deadline = typeof card.expiresAt === 'number' && card.expiresAt > Date.now() ? card.expiresAt : null

        const bodyNodes = []
        if (typeof card.hint === 'string' && card.hint.trim()) {
          bodyNodes.push(el('div', { class: 'dsc-detail', text: card.hint }))
        }
        bodyNodes.push(infoBlock)
        // 备注最多两条：安全说明常驻，再按情况补一条（重复写入提醒 > 将要验证 > 超时取消）。
        // 内置卡片整个 body 只有一行 .reviewNote，这里不堆叠一摞说明文字
        const notes = [el('div', { class: 'dsc-note' }, [
          el('b', { text: t().safetyTitle }),
          t().safetyBody
        ])]
        if (card.seenBefore) notes.push(el('div', { class: 'dsc-note warn', text: t().seenBefore }))
        else if (card.willValidate) notes.push(el('div', { class: 'dsc-note', text: t().willValidate }))
        else if (deadline) notes.push(el('div', { class: 'dsc-note', text: t().autoCancel }))
        bodyNodes.push(el('div', { class: 'dsc-notes' }, notes))

        // 底栏左侧沿用内置卡片的 .pager / .progress 位置，放这张卡还能挂多久
        const countdownNode = el('div', { class: 'dsc-progress' })
        const pager = el('div', { class: 'dsc-pager' }, [countdownNode])

        // 头部右上角：收起 + 关闭，和内置提问卡片同一套 24px 图标按钮。
        // 收起只留标题一行（写长的密钥时先把中间让开），关闭等同于取消这次请求
        let minimized = false
        let chevron = iconNode(ICON_CHEVRON_DOWN)
        const minimizeBtn = el('button', {
          class: 'dsc-iconButton',
          type: 'button',
          title: t().minimize,
          'aria-label': t().minimize,
          'aria-expanded': 'true'
        }, [chevron])
        const dismissBtn = el('button', {
          class: 'dsc-iconButton',
          type: 'button',
          title: t().dismiss,
          'aria-label': t().dismiss
        }, [iconNode(ICON_CLOSE)])
        const bodyEl = el('div', { class: 'dsc-body' }, bodyNodes)
        const footerEl = el('footer', { class: 'dsc-footer' }, [
          pager,
          statusNode,
          el('div', { class: 'dsc-footerActions' }, [cancelBtn, submitBtn])
        ])
        const cardEl = el('section', { class: 'dsc-card' }, [
          el('header', { class: 'dsc-header' }, [
            el('div', { class: 'dsc-headingBlock' }, [
              el('div', { class: 'dsc-eyebrow', text: t().eyebrow }),
              el('h2', { class: 'dsc-title', text: title })
            ]),
            el('div', { class: 'dsc-headerActions' }, [minimizeBtn, dismissBtn])
          ]),
          // 标题与正文之间一条细线（对齐宿主面板用的那条 .5px 发丝线），
          // 让「这是标题、那是正文」一眼分得开
          el('div', { class: 'dsc-divider', role: 'separator' }),
          bodyEl,
          footerEl
        ])
        minimizeBtn.addEventListener('click', () => {
          minimized = !minimized
          cardEl.className = minimized ? 'dsc-card dsc-cardMinimized' : 'dsc-card'
          bodyEl.style.display = minimized ? 'none' : ''
          footerEl.style.display = minimized ? 'none' : ''
          minimizeBtn.removeChild(chevron)
          chevron = iconNode(minimized ? ICON_CHEVRON_UP : ICON_CHEVRON_DOWN)
          minimizeBtn.appendChild(chevron)
          const label = minimized ? t().expand : t().minimize
          minimizeBtn.title = label
          minimizeBtn.setAttribute('aria-label', label)
          minimizeBtn.setAttribute('aria-expanded', minimized ? 'false' : 'true')
          if (!minimized) { try { input.focus() } catch {} }
        })
        dismissBtn.addEventListener('click', () => closeCard(card.requestId, 'user'))

        const frame = el('div', { class: 'dsc-frame' })
        frame.appendChild(cardEl)

        const entry = {
          requestId: card.requestId,
          sessionId: typeof card.sessionId === 'string' ? card.sessionId : '',
          card,
          frame,
          input,
          statusNode,
          buttons: { submit: submitBtn, cancel: cancelBtn },
          tick: null,
          pendingTimer: null,
          detachKey: null,
          docked: false
        }
        open.set(card.requestId, entry)
        // 排队时可能已经登记过（announced 表按 requestId 去重），这里是兜底
        announceCard(card)

        // 倒计时：让用户知道这张卡还能挂多久；到点自己收掉并通知宿主取消，
        // 避免「卡片一直挂着没人管」的观感
        if (deadline) {
          entry.tick = setInterval(() => {
            const left = Math.max(0, deadline - Date.now())
            countdownNode.textContent = left > 0
              ? t().countdownLeft(`${Math.floor(left / 60000)}:${String(Math.floor(left % 60000 / 1000)).padStart(2, '0')}`)
              : t().countdownOver
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
        const onKey = (event) => {
          if (event.key === 'Escape' && open.has(card.requestId)) {
            event.preventDefault()
            closeCard(card.requestId, 'user')
          }
        }
        document.addEventListener('keydown', onKey)
        entry.detachKey = () => document.removeEventListener('keydown', onKey)

        // 挂载：先以隐形过渡态落在 body 上，然后立刻去宿主「输入框座位」插槽挂号。
        // 宿主收到 markDirty 会重渲染、重跑 select；一旦选举出这张卡，ComposerSeat 就会
        // 把它搬进会话列，同时宿主把含输入框的那一块整块藏掉 —— 和内置问答卡片一致。
        // 挂号之后座位迟迟不来，才由兜底计时器决定：退回 body 底部停靠、或者继续隐形等
        frame.className = 'dsc-frame dsc-pending'
        document.body.appendChild(frame)
        entry.pendingTimer = setTimeout(() => {
          entry.pendingTimer = null
          if (entry.docked || !frame.parentNode) return
          // 宿主正在忙自己的事（内置问答卡片、计划评审之类）：让位，卡片先隐形等着，
          // 那边一收工，宿主重渲染又会重新选举，这张卡自然接上位
          if (seatDeclined) return
          frame.className = 'dsc-frame'
        }, 600)
        try { syncComposerSeat() } catch {}
        setTimeout(() => { try { input.focus() } catch {} }, 30)
      }

      // ── 会话门禁 ──
      // 判定一张卡现在该不该弹：会话对得上才弹；读不到当前会话时不弹，
      // 交给 drainWaiting 的兜底时限处理
      const gateOpen = (card) => {
        const sid = typeof card.sessionId === 'string' && card.sessionId ? card.sessionId : ''
        if (!sid) return true // 宿主没带会话信息：按老行为放行
        if (current.kind !== 'session') return false
        return current.id === sid
      }

      const offer = (card) => {
        if (!card || typeof card.requestId !== 'string') return
        if (open.has(card.requestId) || waiting.has(card.requestId)) return
        // 先登记「待应答」再管显示：卡片还在排队（用户不在会话页）时，
        // 黄点和提醒也该亮着，否则非得等用户切回会话才通知，那提醒就白做了
        announceCard(card)
        if (!gateOpen(card)) {
          waiting.set(card.requestId, { card, since: Date.now() })
          return
        }
        // 探针能注册成功、但现在没挂上，说明用户根本不在会话页（在设置页/插件页/别的地方）。
        // 这种情况下继续排队，绝不把卡片丢到屏幕上抢用户的页面
        if (probeRegistered && !pageLive) {
          waiting.set(card.requestId, { card, since: Date.now() })
          return
        }
        openCard(card)
      }

      const drainWaiting = () => {
        if (!waiting.size) return
        for (const [requestId, item] of [...waiting]) {
          const sid = typeof item.card.sessionId === 'string' && item.card.sessionId ? item.card.sessionId : ''
          const mine = !sid || (current.kind === 'session' && current.id === sid)
          // 读不到当前会话时的兜底：等太久还是放出来，否则插件会像坏掉一样没反应。
          // 但探针既然能用的，就老老实实等用户切回会话，不拿兜底去抢非会话页面
          const expired = !probeRegistered && current.kind !== 'session' && Date.now() - item.since > UNKNOWN_GRACE_MS
          if (mine || expired) {
            waiting.delete(requestId)
            openCard(item.card)
          }
        }
      }

      // 切到别的会话时，把不属于它的卡片撤下、放回排队，切回来再弹。
      // 但卡片一旦进过宿主的「输入框座位」，visibility 就整块交给宿主管了：
      // 切走时那个座位随会话一起卸掉，卡片自然看不见；切回来 select 重新选举，
      // 它又自己接上位。所以这里只收拾 body 兜底形态的那些卡。
      const reconcile = () => {
        if (current.kind === 'session' && !seatEverMounted) {
          for (const [requestId, entry] of [...open]) {
            if (entry.sessionId && current.id !== entry.sessionId) {
              closeCard(requestId)
              waiting.set(requestId, { card: entry.card, since: Date.now() })
            }
          }
        }
        drainWaiting()
      }

      // ── 设置面板（只以宿主「插件 → 插件名」详情页的内联形态存在） ──

      // 读当前设置；读不到时退回内置默认值，界面上给一句提示
      const loadSettingsPayload = async () => {
        let settings = null
        let defaults = null
        let settingsError = null
        try {
          const res = await fetch(`${API}/settings`)
          if (res.ok) {
            const payload = await res.json().catch(() => null)
            if (payload && payload.settings) settings = payload.settings
            if (payload && payload.defaults) defaults = payload.defaults
            if (payload && typeof payload.settingsError === 'string') settingsError = payload.settingsError
          }
        } catch {}
        const fallback = defaults || {
          enabled: true,
          timeoutMs: 180000,
          backup: true,
          backupKeep: 3,
          allowedSuffixes: ['.env', 'env', '.json', '.yaml', '.yml', '.toml'],
          allowCommandValidation: false,
          denyHosts: ['localhost', '127.0.0.1', '::1', '0.0.0.0', '169.254.169.254', 'metadata.google.internal'],
          language: 'auto'
        }
        return { s: settings || fallback, fallback, loaded: !!settings, settingsError }
      }

      // 构建设置表单。宿主「插件 → 插件名」详情页的配置区已经把窗口、标题、说明都画好了，
      // 这里只提供字段与保存/恢复，不自带头部（否则同一页出现两遍标题）。
      const buildSettingsForm = (s, fallback, loaded) => {
        const statusNode = el('div', { class: 'dsc-status' })
        const makeSwitch = (on) => {
          const btn = el('button', {
            class: 'dsc-switch',
            type: 'button',
            role: 'switch',
            'aria-checked': on ? 'true' : 'false'
          })
          btn.appendChild(el('span', { class: 'dsc-switchThumb' }))
          btn.addEventListener('click', () => {
            btn.setAttribute('aria-checked', btn.getAttribute('aria-checked') === 'true' ? 'false' : 'true')
          })
          return btn
        }

        const row = (labelText, control, helpText) => {
          const node = el('div', { class: 'dsc-fieldRow' }, [
            el('div', { class: 'dsc-fieldHead' }, [
              el('div', { class: 'dsc-field-label', text: labelText }),
              control
            ])
          ])
          if (helpText) node.appendChild(el('div', { class: 'dsc-field-help', text: helpText }))
          return node
        }
        const rowStack = (labelText, control, helpText, hintNode) => {
          const node = el('div', { class: 'dsc-fieldRow' }, [
            el('div', { class: 'dsc-field-label', text: labelText })
          ])
          node.appendChild(control)
          if (hintNode) node.appendChild(hintNode)
          if (helpText) node.appendChild(el('div', { class: 'dsc-field-help', text: helpText }))
          return node
        }

        const segLanguage = (() => {
          const wrap = el('div', { class: 'dsc-segment', role: 'group' })
          const value = { current: normLocale(s.language) }
          const paint = () => {
            for (const btn of wrap.querySelectorAll('button')) {
              btn.setAttribute('aria-pressed', btn.dataset.value === value.current ? 'true' : 'false')
            }
          }
          for (const v of ['auto', 'zh', 'en']) {
            const btn = el('button', {
              type: 'button',
              'data-value': v,
              text: v === 'auto' ? t().settingsLanguageAuto : (v === 'zh' ? '中文' : 'English'),
              onclick: () => { value.current = v; paint() }
            })
            wrap.appendChild(btn)
          }
          paint()
          value.wrap = wrap
          return value
        })()

        const timeoutHint = el('div', { class: 'dsc-fieldHint' })
        const timeoutInput = el('input', {
          class: 'dsc-fieldInput',
          type: 'number',
          inputmode: 'numeric',
          min: '5',
          max: '600',
          step: '1',
          value: String(clampInt(Math.round((Number(s.timeoutMs) || 180000) / 1000), 5, 600))
        })

        const swBackup = makeSwitch(s.backup !== false)
        const keepHint = el('div', { class: 'dsc-fieldHint' })
        const keepInput = el('input', {
          class: 'dsc-fieldInput',
          type: 'number',
          inputmode: 'numeric',
          min: '0',
          max: '50',
          step: '1',
          value: String(clampInt(Number(s.backupKeep) || 0, 0, 50))
        })

        const swCommand = makeSwitch(s.allowCommandValidation === true)

        const suffixHint = el('div', { class: 'dsc-fieldHint' })
        const suffixInput = el('input', {
          class: 'dsc-fieldInput',
          type: 'text',
          value: (Array.isArray(s.allowedSuffixes) ? s.allowedSuffixes : []).join(', ')
        })
        const denyHint = el('div', { class: 'dsc-fieldHint' })
        const denyInput = el('input', {
          class: 'dsc-fieldInput',
          type: 'text',
          value: (Array.isArray(s.denyHosts) ? s.denyHosts : []).join(', ')
        })

        const clearInvalid = (input, hint) => {
          input.removeAttribute('aria-invalid')
          hint.className = 'dsc-fieldHint'
          hint.textContent = ''
        }
        const markInvalid = (input, hint, text) => {
          input.setAttribute('aria-invalid', 'true')
          hint.className = 'dsc-fieldInvalid'
          hint.textContent = text
        }
        timeoutInput.addEventListener('input', () => clearInvalid(timeoutInput, timeoutHint))
        keepInput.addEventListener('input', () => clearInvalid(keepInput, keepHint))
        suffixInput.addEventListener('input', () => clearInvalid(suffixInput, suffixHint))
        denyInput.addEventListener('input', () => clearInvalid(denyInput, denyHint))

        const body = el('div', { class: 'dsc-settingsBody' }, [
          loaded ? null : el('div', { class: 'dsc-fieldHelp', text: t().settingsLoadFailed }),
          row(t().settingsLanguage, segLanguage.wrap, t().settingsLanguageHelp),
          rowStack(t().settingsTimeout, timeoutInput, t().settingsTimeoutHelp, timeoutHint),
          row(t().settingsBackup, swBackup, t().settingsBackupHelp),
          rowStack(t().settingsBackupKeep, keepInput, t().settingsBackupKeepHelp, keepHint),
          row(t().settingsCommandValidation, swCommand, t().settingsCommandValidationHelp),
          rowStack(t().settingsSuffixes, suffixInput, t().settingsSuffixesHelp, suffixHint),
          rowStack(t().settingsDenyHosts, denyInput, t().settingsDenyHostsHelp, denyHint)
        ])

        const saveBtn = el('button', { class: 'dsc-btn dsc-btn-primary', type: 'button', text: t().settingsSave })
        const resetBtn = el('button', { class: 'dsc-btn dsc-btn-outline dsc-btn-sm', type: 'button', text: t().settingsReset })

        const doSave = async () => {
          let ok = true
          const sec = Number.parseInt(String(timeoutInput.value || ''), 10)
          if (!Number.isInteger(sec) || sec < 5 || sec > 600) {
            markInvalid(timeoutInput, timeoutHint, t().settingsTimeoutInvalid); ok = false
          }
          const keep = Number.parseInt(String(keepInput.value || ''), 10)
          if (!Number.isInteger(keep) || keep < 0 || keep > 50) {
            markInvalid(keepInput, keepHint, t().settingsBackupKeepInvalid); ok = false
          }
          const suffixes = splitList(suffixInput.value)
          if (!suffixes.length) {
            markInvalid(suffixInput, suffixHint, t().settingsSuffixesInvalid); ok = false
          }
          const hosts = splitList(denyInput.value)
          if (!ok) { setSettingsStatus(t().settingsSaveFailed, 'err'); return }
          const patch = {
            language: segLanguage.current,
            timeoutMs: clampInt(sec * 1000, 5000, 600000),
            backup: swBackup.getAttribute('aria-checked') === 'true',
            backupKeep: clampInt(keep, 0, 50),
            allowCommandValidation: swCommand.getAttribute('aria-checked') === 'true',
            allowedSuffixes: suffixes.map((x) => x.toLowerCase()),
            denyHosts: hosts
          }
          saveBtn.disabled = true
          try {
            const res = await fetch(`${API}/settings`, {
              method: 'PUT',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(patch)
            })
            const payload = await res.json().catch(() => null)
            if (!res.ok) throw new Error((payload && payload.settingsError) || `http_${res.status}`)
            applyLocale(patch.language === 'auto' ? detectLocale() : patch.language)
            // 落盘成功才说「已保存」；host 那边留了失败原因就照实说
            if (payload && typeof payload.settingsError === 'string' && payload.settingsError) {
              warnSettings(payload.settingsError, t().settingsPersistFailed)
            } else {
              setSettingsStatus(t().settingsSaved, 'ok')
            }
            return
          } catch (error) {
            warnSettings((error && error.message) || String(error), t().settingsSaveFailed)
          } finally {
            saveBtn.disabled = false
          }
        }
        const setSettingsStatus = (text, kind) => {
          statusNode.className = `dsc-status${kind ? ' ' + kind : ''}`
          statusNode.textContent = text
        }
        // 「没能落盘」的真实原因：标题一行 + 细节一行。设置只在本次运行生效是
        // 最难自查的一类故障，不能只写在控制台里，要摆到用户眼前。
        const warnSettings = (detail, title) => {
          try {
            statusNode.className = 'dsc-status err'
            statusNode.textContent = ''
            statusNode.appendChild(el('div', { class: 'dsc-statusHead', text: title || '' }))
            statusNode.appendChild(el('div', { class: 'dsc-statusDetail', text: String(detail || '') }))
          } catch {}
        }

        const applyDefaults = () => {
          const d = fallback
          swBackup.setAttribute('aria-checked', d.backup !== false ? 'true' : 'false')
          swCommand.setAttribute('aria-checked', d.allowCommandValidation === true ? 'true' : 'false')
          timeoutInput.value = String(clampInt(Math.round((Number(d.timeoutMs) || 180000) / 1000), 5, 600))
          keepInput.value = String(clampInt(Number(d.backupKeep) || 0, 0, 50))
          suffixInput.value = (Array.isArray(d.allowedSuffixes) ? d.allowedSuffixes : []).join(', ')
          denyInput.value = (Array.isArray(d.denyHosts) ? d.denyHosts : []).join(', ')
          segLanguage.current = normLocale(d.language)
          for (const btn of segLanguage.wrap.querySelectorAll('button')) {
            btn.setAttribute('aria-pressed', btn.dataset.value === segLanguage.current ? 'true' : 'false')
          }
          for (const pair of [[timeoutInput, timeoutHint], [keepInput, keepHint], [suffixInput, suffixHint], [denyInput, denyHint]]) {
            clearInvalid(pair[0], pair[1])
          }
          setSettingsStatus('')
        }

        saveBtn.addEventListener('click', doSave)
        resetBtn.addEventListener('click', applyDefaults)

        const footer = el('div', { class: 'dsc-settingsFooter' }, [statusNode, resetBtn, saveBtn])

        return {
          body,
          footer,
          warn: warnSettings,
          // 卸载时把输入框里的内容抹掉，减少残留窗口
          destroy: () => {
            try { timeoutInput.value = ''; keepInput.value = ''; suffixInput.value = ''; denyInput.value = '' } catch {}
          }
        }
      }

      // 内联形态：挂进宿主「插件 → 插件名」详情页的配置区里
      const mountSettingsInline = (host) => {
        let destroyed = false
        let form = null
        loadSettingsPayload().then(({ s, fallback, loaded, settingsError }) => {
          if (destroyed) return
          try {
            form = buildSettingsForm(s, fallback, loaded)
            host.appendChild(el('div', { class: 'dsc-settingsHost' }, [form.body, form.footer]))
            // 上一次保存没能落盘时，一进设置页就把真实原因摆出来，
            // 而不是让用户以为「已保存」就完了。
            if (settingsError && form.warn) {
              form.warn(settingsError, t().settingsPersistFailed)
            }
          } catch {}
        }).catch(() => {})
        return {
          destroy: () => {
            destroyed = true
            try { if (form) form.destroy() } catch {}
          }
        }
      }

      // ── React 桥接 + 宿主「插件」面板卡片位 ──
      // 左侧面板「插件」页由内置插件 @deepseek-ai/dsh-client-ui-plugin-manager 提供，
      // 它注册主面板 main(key=插件) 并声明子插槽 plugins.item(kind:"list", scope:"root")，
      // 再按 entry.options.id 与 only 过滤渲染。所以这里注册进去后，用户就能在
      // 左侧面板 → 插件 → 官方 → 「密钥卡片」里看到并打开设置。
      // 宿主渲染这个组件两次：view="summary" 给卡片和详情页各一行说明文案，
      // view="page" 才挂真正的设置表单（见 plugin-manager.js 的 ItemCard / ItemDetail）。
      let reactModule = null
      let reactProbed = false
      const getReact = () => {
        if (reactProbed) return reactModule
        reactProbed = true
        try {
          if (typeof require !== 'function') return null
          const mod = require('react')
          if (mod && typeof mod.createElement === 'function' &&
              typeof mod.useRef === 'function' && typeof mod.useEffect === 'function') {
            reactModule = mod
          }
        } catch {}
        return reactModule
      }

      // ── 把卡片挂进宿主「输入框座位」插槽（conversation.composer） ──
      // 这是 chain 型插槽，宿主渲染它时带 overlay:true：谁被 select 选举出来，宿主就把
      // 含输入框的 fallback 整块 display:none。所以卡片一进这个座位，输入框就自动让位，
      // 收起/关掉后再回来 —— 和内置问答卡片（QuestionComposer）弹出来时的行为一模一样。
      // 内置那边靠宿主自己的 pendingInteraction 状态变化触发重渲染来重跑 select；
      // 插件没有这个状态源，所以每开一张卡就注册一次、每关一张卡就注销一次，
      // 用 markDirty 逼宿主重渲染、重跑选举。注销再注册会让 React 组件重挂一次，
      // 但它只负责搬 DOM、不存任何自己的状态，所以无感。
      const findElectable = (sid) => {
        if (!sid) return null
        // 同一会话名下只取最早开着的那张：座位只有一个，后来的先等一等
        for (const entry of open.values()) {
          if (!entry.sessionId || entry.sessionId === sid) return entry
        }
        return null
      }

      // 「用户在不在会话页」探针。conversation.input.dock 是宿主渲染在输入框上方的 list
      // 插槽，只有会话页会挂它 —— 拿它当探针，比轮询侧边栏稳得多。display:contents 的
      // 空容器不占布局、不画东西，纯粹给插件一个「会话页挂上了 / 卸掉了」的信号。
      const PageProbe = (props) => {
        const React = getReact()
        const sid = props && typeof props.sessionId === 'string' ? props.sessionId : ''
        React.useEffect(() => {
          pageLive = true
          return () => {
            pageLive = false
          }
        }, [sid])
        return React.createElement('div', { className: 'dsc-probe' })
      }

      const registerPageProbe = () => {
        const React = getReact()
        const slots = ctx.slots
        if (!React || !slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false
        try {
          const handle = slots.inject('conversation.input.dock', () => slots.register({
            name: 'conversation.input.dock',
            id: CLIENT_NAME,
            order: 20,
            inject: (sessionId) => ({ sessionId: typeof sessionId === 'string' ? sessionId : '' })
          }, PageProbe))
          if (typeof handle === 'function') probeDisposer = handle
          else if (handle && typeof handle.dispose === 'function') probeDisposer = () => { try { handle.dispose() } catch {} }
          probeRegistered = true
          return true
        } catch {
          return false
        }
      }

      const ComposerSeat = (props) => {
        const React = getReact()
        const hostRef = React.useRef(null)
        const matched = props && props.matched
        const requestId = matched && typeof matched.requestId === 'string' ? matched.requestId : ''
        React.useEffect(() => {
          const host = hostRef.current
          if (!host || !requestId) return undefined
          const entry = open.get(requestId)
          if (!entry) return undefined
          seatLive = true
          seatEverMounted = true
          seatHost = host
          host.className = 'dsc-composer'
          entry.docked = true
          if (entry.pendingTimer) { try { clearTimeout(entry.pendingTimer) } catch {} entry.pendingTimer = null }
          entry.frame.className = 'dsc-frame dsc-docked'
          if (entry.frame.parentNode !== host) {
            try { entry.frame.remove() } catch {}
            try { host.appendChild(entry.frame) } catch {}
          }
          setTimeout(() => { try { entry.input.focus() } catch {} }, 30)
          return () => {
            if (seatHost === host) { seatHost = null; seatLive = false }
            // 座位卸下 = 这次选举结束了（用户切走、或者宿主自己在出内置卡片）。
            // 卡片不销毁，只收回成隐形过渡态：宿主机下次重渲染重新选举到它，
            // 它又自己回到座位里
            if (entry.docked) {
              entry.docked = false
              entry.frame.className = 'dsc-frame dsc-pending'
            }
          }
        }, [requestId])
        return React.createElement('div', { ref: hostRef, className: 'dsc-composer' })
      }

      const disposeSeat = () => {
        if (seatDisposer) { try { seatDisposer() } catch {} }
        seatDisposer = null
      }

      const registerSeat = () => {
        const React = getReact()
        const slots = ctx.slots
        if (!React || !slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false
        try {
          // inject 的返回值就是这次注册的注销器（宿主官方用法：const dispose = slots.inject(...)）
          const handle = slots.inject('conversation.composer', () => slots.register({
            name: 'conversation.composer',
            order: 20,
            select: (ownerProps) => {
              const p = ownerProps || {}
              // 宿主自己在等用户操作（内置问答卡片、计划评审…）：一律让位，
              // 绝不覆盖内置功能。
              // 但「我自己发出去的那条待应答」不算——它就是为了让会话列表亮黄点、
              // 让 dsh-notify-me 提醒而登记的，认得出来（key 带本插件前缀）。
              // 不认的话会自己把自己挤下台：一发布 pendingInteraction，
              // 宿主就认为「有人在等用户」，本插件的座位按上面的规则让位，卡片当场消失。
              const mine = p.pendingInteraction &&
                typeof p.pendingInteraction.key === 'string' &&
                p.pendingInteraction.key.indexOf(`${CLIENT_NAME}:`) === 0
              if (p.pendingInteraction && !mine) { seatDeclined = true; return null }
              const sid = typeof p.sessionId === 'string' ? p.sessionId : ''
              const entry = findElectable(sid)
              if (!entry) { seatDeclined = true; return null }
              seatDeclined = false
              return { requestId: entry.requestId }
            }
          }, ComposerSeat))
          if (typeof handle === 'function') seatDisposer = handle
          else if (handle && typeof handle.dispose === 'function') seatDisposer = () => { try { handle.dispose() } catch {} }
          return true
        } catch {
          return false
        }
      }

      syncComposerSeat = () => {
        // 一张卡都没有：注销，宿主就把输入框放回来
        if (open.size === 0) { disposeSeat(); return }
        // 有卡：注销再注册，逼宿主重跑一次选举
        disposeSeat()
        registerSeat()
      }

      const SettingsItem = (props) => {
        const React = getReact()
        const view = (props && props.view) || 'page'
        // hooks 必须无条件调用：summary 分支只少渲染一个容器 div，不能少 hook
        const hostRef = React.useRef(null)
        React.useEffect(() => {
          if (view !== 'page') return undefined
          const host = hostRef.current
          if (!host) return undefined
          let mounted = null
          try { mounted = mountSettingsInline(host) } catch {}
          return () => { try { if (mounted) mounted.destroy() } catch {} }
        }, [view])
        if (view === 'summary') return t().itemSummary
        return React.createElement('div', { ref: hostRef, className: 'dsc-settingsHostSlot' })
      }

      // 注册进「插件 → 插件名」。设置只在宿主插件页里出现：卡片本身不放设置入口，
      // 也不在角落里挂浮动按钮，免得和宿主自己的界面抢位置。
      let tabLive = false
      let tabDisposer = null
      let bundleDisposer = null
      // 「左侧面板 → 插件 → 点开本插件」这一页，配置区读的是 plugins.bundle.config
      // 这个带键位（keyed）的插槽，键就是插件的包名。用户在自己插件的详情页里
      // 就能直接看到设置表单 —— 这才是「插件 → 插件名」该有的位置。
      // 另外再往 plugins.item 注册一张卡片（官方组里），多一条能点进去的路。
      const registerSettingsTab = () => {
        if (tabLive) return true
        const React = getReact()
        const slots = ctx.slots
        if (!React || !slots || typeof slots.inject !== 'function' || typeof slots.register !== 'function') return false
        try {
          const bundle = slots.inject('plugins.bundle.config', () => slots.register({
            name: 'plugins.bundle.config',
            key: CLIENT_NAME,
            order: 20
          }, SettingsItem))
          if (bundle && typeof bundle.dispose === 'function') {
            bundleDisposer = () => { try { bundle.dispose() } catch {} }
          }
          const item = slots.inject('plugins.item', () => slots.register({
            name: 'plugins.item',
            id: CLIENT_NAME,
            order: 20, // 排在内置的「终端」(shell) 之后
            label: () => t().tabLabel
          }, SettingsItem))
          if (item && typeof item.dispose === 'function') tabDisposer = () => { try { item.dispose() } catch {} }
          tabLive = true
          return true
        } catch {
          return false
        }
      }
      registerSettingsTab()
      // 「用户在不在会话页」探针：注册一次、一直挂着，专门给 offer 的门禁用
      registerPageProbe()

      // ── 事件与轮询 ──
      const handleEvent = (raw) => {
        let payload
        try { payload = JSON.parse(raw) } catch { return }
        if (!payload || typeof payload !== 'object') return
        if (payload.type === 'card.request') offer(payload)
        else if (payload.type === 'card.cancel') {
          waiting.delete(payload.requestId)
          retractCard(payload.requestId)
          const entry = open.get(payload.requestId)
          if (entry && entry.detachKey) entry.detachKey()
          closeCard(payload.requestId)
        } else if (payload.type === 'card.result') {
          // 宿主已结算（写入成功/失败/取消/超时）：本地这张卡必须收掉，否则会出现
          // 「已经写完了卡片还挂着」的观感（bug：输入密码后卡片不消失）
          waiting.delete(payload.requestId)
          retractCard(payload.requestId)
          const entry = open.get(payload.requestId)
          if (entry && entry.detachKey) entry.detachKey()
          closeCard(payload.requestId)
        }
      }

      const fetchPending = async () => {
        try {
          const session = readCurrentSession(ctx.sessions)
          current = session
          const url = session.kind === 'session'
            ? `${API}/pending?sessionId=${encodeURIComponent(session.id)}`
            : `${API}/pending`
          const res = await fetch(url)
          if (!res.ok) return
          const payload = await res.json().catch(() => null)
          const list = payload && Array.isArray(payload.requests) ? payload.requests : []
          for (const card of list) offer(card)
          drainWaiting()
        } catch {}
      }

      const onSessionMaybeChanged = () => {
        const before = `${current.kind}/${current.id}`
        refreshSession()
        if (`${current.kind}/${current.id}` !== before) reconcile()
        else drainWaiting()
      }

      let unwatchSession = null
      try {
        const list = ctx.sessions && ctx.sessions.list
        if (list && typeof list.subscribe === 'function') {
          const off = list.subscribe(() => onSessionMaybeChanged())
          if (typeof off === 'function') unwatchSession = off
        }
      } catch {}
      if (!unwatchSession) {
        // 拿不到订阅就退化成 1 秒轮询：会话切换必须能及时反应，否则卡片会跟错会话
        const sessionPoll = setInterval(onSessionMaybeChanged, 1000)
        unwatchSession = () => { try { clearInterval(sessionPoll) } catch {} }
      }

      let es = null
      const start = () => {
        try {
          es = new EventSource(`${API}/events`)
          es.onmessage = (event) => handleEvent(event.data)
          es.onerror = () => { /* EventSource 自带重连；pending 轮询兜底 */ }
        } catch {}
      }

      start()
      fetchPending()
      const poll = setInterval(() => { if (open.size > 0 || waiting.size > 0) fetchPending() }, 10000)
      const onVisible = () => { if (document.visibilityState === 'visible') fetchPending() }
      document.addEventListener('visibilitychange', onVisible)

      return () => {
        try { clearInterval(poll) } catch {}
        try { document.removeEventListener('visibilitychange', onVisible) } catch {}
        try { unwatchSession() } catch {}
        try { if (es) es.close() } catch {}
        try { if (tabDisposer) tabDisposer() } catch {}
        try { if (bundleDisposer) bundleDisposer() } catch {}
        try { if (seatDisposer) seatDisposer() } catch {}
        try { if (probeDisposer) probeDisposer() } catch {}
        // 收工：所有登记的「待应答」全部撤下，别在会话里留僵尸黄点
        for (const requestId of [...announced.keys()]) retractCard(requestId)
        for (const requestId of [...open.keys()]) {
          const entry = open.get(requestId)
          if (entry && entry.detachKey) entry.detachKey()
          closeCard(requestId)
        }
      }
    }, `${CLIENT_NAME}: card`)
  }
}
