# dsh-secret-card

> npm 包名 `dsh-secret-card` · 源码与问题反馈：<https://github.com/dacenss/dsh-secret-card> · MIT

dsh 插件 · **密钥安全输入卡片**。

AI 在配置过程里需要密钥（API Key / Token / 密码 / Webhook 密钥）时，通用做法是让
用户把密钥贴进对话 —— 于是密钥永久留在会话记录里。本插件换一条路：**AI 只描述
「密钥该写到哪」，密钥由用户在弹出的卡片里直接输入，由插件写进配置文件，AI 全程
看不到明文，只拿到「写入成功了吗 / 密钥生效了吗」这两个结论。**

## 安装

进入 DSH 的 profile 目录，用 DSH 自带的 pnpm 安装：

```powershell
cd $env:USERPROFILE\.dsh\profiles\<profile 名，通常是 desktop>
pnpm add dsh-secret-card
```

再把 `dsh-secret-card` 追加进该 profile `package.json` 的 `dsh.profile.bundles`
数组，然后重启 DSH。

> 不确定 profile 名的话，看 `$env:USERPROFILE\.dsh\profiles\` 下有哪几个目录；
> 装了插件市场的话也可以直接从界面里添加。装了插件市场的话也可以直接从界面里添加。

`cordis.patch.yml` 会把插件插进名册，客户端产物 `client/bundle.js` 已随 npm 包
预构建，装完即可用，不需要额外构建步骤。

## 它解决什么

| 以前的体验 | 有了它之后 |
| --- | --- |
| 「请把 API Key 发我」→ 密钥留在对话里 | AI 说「请在弹出的卡片里输入」→ 密钥进文件，不进对话 |
| AI 读配置文件来「确认写对了」→ 密钥再次进入模型上下文 | AI 只收到脱敏结果，不含密钥 |
| 密钥是否有效，要把密钥发给第三方服务试 → 又进一次上下文 | 插件带着密钥去验证，只回「生效 / 不生效」 |

## 工作方式

```
AI 调用 secret_card(file, key, format, label, hint, validation?)
   │  参数里没有任何密钥内容
   ▼
宿主生成 requestId，SSE 推给页面
   ▼
页面弹模态卡片 ← 用户输入密钥
   │  POST /api/dsh-secret-card/fill {requestId, secret}   ← 密钥唯一一次过网（同源）
   ▼
宿主：写入配置文件（先备份、临时文件 + rename 原子落盘、读回校验）
   │  可选：带着密钥去请求验证端点 / 执行 stdin 传密钥的命令
   ▼
resolve pending → 工具返回脱敏 JSON → AI 看到
{status, validation, validationDetail, file, key, backup, fingerprint, note}
```

## 密钥不会出现在哪里（硬性保证）

- 会话记录 / messages —— 密钥从不出现在任何 message，工具返回值与 output.render 均脱敏
- `ctx.logger` —— 只打 requestId / 文件 / 键名 / 状态，单测断言日志序列化不含密钥
- SSE 广播 —— 固定白名单字段，发送前断言不含密钥
- HTTP 响应体 —— `/fill` 只回 status / validation，不 echo
- 进程列表 —— 命令验证的 `%%SECRET%%` 只允许出现在 stdin，argv 出现即拒绝
- 备份文件 —— `<file>.bak-YYYYMMDD-HHmmssSSS` 与原文同敏感级，请一并保护

## 支持的写入格式（行级替换，保留注释与风格）

| 格式 | 写法 |
| --- | --- |
| `.env` / `.env.*` | `KEY="value"` |
| `.json` | `"KEY": "value"`（不做 parse/stringify，注释、键顺序、缩进、尾逗号原样保留） |
| `.yaml` / `.yml` | `KEY: "value"`（值无特殊字符时输出无引号形式） |
| `.toml` | `KEY = "value"` |

- 键已存在 → 覆盖（`overwrite:false` 时拒绝并返回 `key_exists`）
- 键不存在 → 追加到文件尾 / JSON 里插到最外层最后一个键之后
- **只处理根级键**；目标文件必须已存在，且后缀在设置的白名单内（默认 `.env env .json .yaml .yml .toml`）

## 可选的「密钥是否生效」验证

`validation` 参数是 JSON 字符串，`%%SECRET%%` 是唯一占位符：

> 为什么不用常见的那对花括号占位（左花括号 ×2 + SECRET + 右花括号 ×2）：宿主的
> 系统提示模板会把成对的花括号当变量引用，大写变量名会让整段插件提示注册失败
> （实测报错 `malformed prompt variable reference`，报错信息里会带上你写的那个
> 占位符原文）。`%%` 包裹则不冲突。

```jsonc
// HTTP 验证（推荐）
{"kind":"http","method":"GET","url":"https://api.example.com/v1/verify",
 "header":{"Authorization":"Bearer %%SECRET%%"},"expectStatus":200,"expectBodyContains":"ok"}

// 命令验证（默认关闭，需在设置里打开）
{"kind":"command","argv":["npm","run","check"],"stdinTemplate":"%%SECRET%%\n"}
```

返回给 AI 的只有 `passed / failed / skipped` 加一行原因（如 `http 403`、`exit 0`、
`denied_host`），**响应体、响应头、退出输出都不外传**。

SSRF 护栏：只允许 http/https；不跟随重定向；目标主机命中拒绝名单（本机、内网、
云元数据地址，默认 `localhost 127.0.0.1 ::1 0.0.0.0 169.254.169.254
metadata.google.internal`，可在设置里增删）时直接拒绝。

## 给模型的约束（系统提示自动注入）

插件通过 `ctx.systemPrompt.section` 注入一段说明：需要密钥必须调 `secret_card`，
禁止把密钥写进参数/消息/文件名/shell 命令，禁止要求用户在对话里贴密钥，禁止读回
刚写入的文件值，一次只处理一个密钥（`busy` 是「还有一张卡片开着」的意思）。

## 配置项（设置页可改）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 停用后工具直接返回 `disabled` |
| `timeoutMs` | `180000` | 卡片等待输入的最长时间，到期返回 `timeout` |
| `backup` | `true` | 写入前备份原文件 |
| `backupKeep` | `3` | 同一文件保留几份备份 |
| `allowedSuffixes` | 见上 | 允许写入的文件后缀白名单 |
| `allowCommandValidation` | `false` | 是否允许 AI 提供命令验证 |
| `denyHosts` | 见上 | HTTP 验证禁止访问的主机 |
| `language` | `auto` | 界面语言：`auto` 按本机语言识别、`zh` 中文、`en` 英文 |

## 界面语言

界面文字分两处，各自按本机语言识别，**识别不到一律用英文**：

| 位置 | 文字给谁看 | 识别方式 |
| --- | --- | --- |
| 输入卡片 | 用户 | 浏览器语言（`navigator.language`） |
| 工具说明 / 回执 / 系统提示 | 模型 | 环境变量 `LC_ALL` / `LC_MESSAGES` / `LANG` / `LANGUAGE`，再兜到系统locale |

语言串只要以 `zh` 开头（`zh`、`zh-CN`、`zh-TW`…）就走中文，其余全部走英文。
想固定语言，改设置页的 `language`：填 `zh` 或 `en` 就锁死不动，填 `auto` 恢复自动识别。

## 工具返回值契约

```json
{
  "status": "written | already-written | cancelled | timeout | aborted | busy | failed",
  "reason": "…（仅 failed/busy 有）",
  "validation": "passed | failed | skipped",
  "validationDetail": "http 204",
  "file": "C:\\proj\\.env",
  "key": "OPENAI_API_KEY",
  "backup": ".env.bak-20261007-073004821",
  "fingerprint": "sha256:1a2b3c4d",
  "note": "密钥已由用户在卡片中直接输入并写入文件；本结果不含密钥明文，也不要去读该文件的值。"
}
```

`fingerprint` 只是写入内容的哈希前 8 位，用于肉眼核对，不足以反推密钥。

## 已知限制

- **AI 事后仍可能读回配置文件看到明文**：这是提示层约束（系统提示明令禁止 +
  返回值里带 note），协议层无法物理阻止。敏感文件请用文件权限 / 加密卷进一步保护。
- 只支持根级键；嵌套 JSON/YAML 的深层路径需要后续版本。
- 卡片是单例的：一次只处理一个密钥，重复请求会合并到同一张卡。

## 本地开发

客户端是纯 DOM 实现，不依赖 React，因此 build 脚本只是把源码原样嵌进
`window.__ModuleLoader__.load({ id, factory })` 外壳。

```bash
npm run check           # node --check 宿主与客户端源码
npm run build:client    # client/index.js → client/bundle.js
npm test                # 单元 41 项 + 集成 8 项 + 文案红线 1 项（共 50 项）
```

加新语言要动两处：`src/index.js` 里的 `MESSAGES` 表（模型看的文案）、
`client/index.js` 里的 `CLIENT_MESSAGES` 表（用户看的卡片文案）。两边按同一
套判定分档（`zh` 开头走中文、其余英文），`test/secret-card.test.mjs` 里有断言
要求两张表的键逐一对齐——漏一个键就是漏一句话。

用 `file:` 协议把源码装进 profile 的话，改完源码必须手动同步（pnpm 对已装的
file 依赖不会重新拷贝），然后重启 DSH：

```powershell
npm run build:client
pwsh scripts\install-local.ps1              # 默认同步进 desktop profile
pwsh scripts\install-local.ps1 -Profile web # 其他 profile 用 -Profile 指定
```

脚本按自身所在位置推导工作区与 profile 目录，不写死任何路径。

**改给模型看的文案时有一条红线**：不能出现成对的双花括号（两个连续左花括号包
一段名字、再两个连续右花括号收尾）。宿主的系统提示模板会把它当变量引用，大写
变量名会让整段 section 注册失败、本轮运行直接报错
`malformed prompt variable reference`。密钥占位符因此用 `%%SECRET%%`，
`test/copy-guard.test.mjs` 里有回归断言守着这条线。
