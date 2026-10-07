# dsh-secret-card

> 源码与问题反馈：<https://github.com/dacenss/dsh-secret-card> · npm 包名 `dsh-secret-card`

dsh 插件 · **密钥安全输入卡片**。

AI 在配置过程里需要密钥（API Key / Token / 密码 / Webhook 密钥）时，通用做法是让
用户把密钥贴进对话 —— 于是密钥永久留在会话记录里。本插件换一条路：**AI 只描述
「密钥该写到哪」，密钥由用户在弹出的卡片里直接输入，由插件写进配置文件，AI 全程
看不到明文，只拿到「写入成功了吗 / 密钥生效了吗」这两个结论。**

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

## 开发

```bash
npm run check           # node --check 宿主与客户端源码
npm run build:client    # client/index.js → client/bundle.js（loader 外壳）
npm test                # 单元 36 项 + 集成 8 项 + 文案红线 1 项（共 45 项）
```

**改完源码要同步进 profile**：本地安装走的是 `file:` 协议，pnpm 在源码变更后不会
重新拷贝（实测 `pnpm add file:` 对已装的 file 依赖是空操作）。因此：

```powershell
npm run build:client
pwsh scripts\install-local.ps1            # 把 src/client/… 镜像进 desktop profile
pwsh scripts\install-local.ps1 -Profile web   # 其他 profile 用 -Profile 指定
```

然后重启 DSH 生效。脚本按自身所在位置推导工作区与 profile 目录，不写死任何路径。

**给模型看的文案里不要出现成对的双花括号**（两个连续左花括号包一段名字、再两个
连续右花括号收尾）：宿主的系统提示模板会把它当变量引用，大写变量名会让整段
section 注册失败、本轮运行直接报错 `malformed prompt variable reference`。密钥
占位符因此用 `%%SECRET%%`，`test/copy-guard.test.mjs` 里有回归断言守着这条线。

客户端是纯 DOM 实现，不依赖 React，因此 build 脚本只是把源码原样嵌进
`window.__ModuleLoader__.load({ id, factory })` 外壳。

## 发布到 npm

npm 开了两步验证（`auth-and-writes`）。**先确认你的账号用的是哪种 2FA**，两种走法完全不同：

| 账号 2FA 方式 | npm 发布时要什么 | 本仓库的做法 |
| --- | --- | --- |
| 只有**安全密钥**（security keys，如指纹 / 硬件键） | 不输任何码，在浏览器里摸一下钥匙 | 直接 `npm run publish`，npm 自己开浏览器 |
| 有**认证器 App**（TOTP，6 位滚动码） | 一个 6 位验证码 | 让 AI 弹卡片收码，AI 看不到明文 |

### 情况一：只有安全密钥（本机当前就是这种）

账号设置页显示 `2 security keys`、没有任何 Authenticator App —— 这种账号**根本没有 6 位滚动码可输**。
npm CLI 对此有内置的「网页授权」流程（`npm/lib/utils/auth.js` 里那段 `webAuthOpener`）：
发布请求被 401 打回时，npm 自动打开浏览器，你在浏览器里完成安全密钥验证，它拿到令牌后自己重试发布。

这条路**唯一的硬条件是必须跑在真实终端里**，所以那条命令要你自己在 PowerShell 窗口敲：

```powershell
cd C:\Users\izhjs\Documents\deepseek-harness\default-workspace\dsh-secret-card
npm run publish        # 先 npm pack，再 npm publish <tarball>
```

浏览器弹出 npm 授权页后，用你的安全密钥（指纹）确认一下即可，全程不需要输任何东西。

### 情况二：有认证器 App

这时可以用本插件来收验证码，**AI 全程看不到码**：

```
AI 调 secret_card(target=.publish.env, key=NPM_OTP)   ← 只描述位置，参数里没有码
   ▼
你在弹窗卡片里输入 6 位验证码 → 插件写进 .publish.env（文件不在 git、不在发布包里）
   ▼
npm run publish        ← 读 .publish.env → npm pack → npm publish <tarball>
   ▼
.publish.env 用完即删
```

验证码只走环境变量（`NPM_CONFIG_OTP`，npm 原生支持），**不进命令行参数**，
进程列表里看不到；`.publish.env` 用完立即删除，`.gitignore` 里也挡着。

### 为什么要「先 pack 再发布」

`scripts/publish.mjs` 走的是**先 `npm pack` 打好包、再发布这个 tarball**：
发布已打好的 tarball 时 npm 不跑任何生命周期脚本，所以 `prepublishOnly`（构建 + 检查 + 45 项测试）
那几秒不会挤占验证窗口。人工直接敲 `npm publish` 时 `prepublishOnly` 照样会跑。

改完代码先自己跑一遍，全绿再发：

```powershell
npm test               # 36 单元 + 8 集成 + 1 文案红线守卫
```

## 安装

**从 npm 安装（推荐）**——进入 DSH 的 profile 目录，用 DSH 自带的 pnpm 安装：

```powershell
cd $env:USERPROFILE\.dsh\profiles\<profile 名，通常是 desktop>
pnpm add dsh-secret-card
```

再把 `dsh-secret-card` 追加进该 profile `package.json` 的 `dsh.profile.bundles`
数组，然后重启 DSH。

> 不确定 profile 名的话，看 `$env:USERPROFILE\.dsh\profiles\` 下有哪几个目录；
> 装了插件市场的话也可以直接从界面里添加。

**本地源码安装（改代码自用）**：在 profile 目录下
`pnpm add "file:<本插件源码目录>"`，同样追加进 `dsh.profile.bundles` 后重启；
之后每次改源码按上面「开发」一节同步。

`cordis.patch.yml` 会把插件插进名册（`- insert: - id: dsh-secret-card / name: dsh-secret-card`），
宿主入口 `src/index.js`，客户端入口 `client/bundle.js`（已随 npm 包发布，装完即可用，
不需要额外构建）。

## 已知限制

- **AI 事后仍可能读回配置文件看到明文**：这是提示层约束（系统提示明令禁止 + 返回
  值里带 note），协议层无法物理阻止。敏感文件请用文件权限 / 加密卷进一步保护。
- 只支持根级键；嵌套 JSON/YAML 的深层路径需要后续版本。
- 卡片是单例的：一次只处理一个密钥，重复请求会合并到同一张卡。
- 通过 npm 分发，包名 `dsh-secret-card`（MIT）。安装方式见上一节。
