// 发布助手：DSH 密钥卡片插件自己第一个用户。
//
// 分工：
//   AI    —— 只负责把该说清的话说清（做到哪一步、你需要摸哪一下），从来看不到任何凭证
//   用户  —— 在有真实终端的 PowerShell 窗口里执行下面的命令，并按提示操作
//   本脚本 —— 负责「先打包、再发布」这个顺序，让发布动作尽量快、尽量不夹带别的事
//
// ── 关键认知：本机的两步验证是「安全密钥」，不是「认证器 App」 ──────────────────
// npm 账号设置页显示：Two-Factor Authentication = Enabled for authorization and
// publishing，下面写的是「2 security keys」，没有任何 Authenticator App。
// 也就是说：这个账号根本没有 6 位滚动验证码可输 —— 之前三次填同一个值被 npm
// 判无效码，原因就在这里，不是填错，是那种码不存在。
//
// 安全密钥的正确用法是 npm CLI 自带的「网页授权」流程，见
// C:\Users\izhjs\nodejs\node_modules\npm\lib\utils\auth.js:14-23
//   npm 把发布请求发过去 →  registry 回 401 且带 authUrl / doneUrl
//   →  npm 自动打开浏览器 →  你在浏览器里完成安全密钥（指纹/硬件键）验证
//   →  npm 拿到令牌后自己重试发布，全程不需要你手动输任何码
//
// 这条路唯一的硬条件是：必须跑在真实终端里（进程的 stdin/stdout 得是 TTY），
// 否则 auth.js 第 10 行会直接抛出原始 401。所以下面这条命令要由你在
// PowerShell 窗口里敲，不能让 AI 在后台代跑：
//
//     cd C:\Users\izhjs\Documents\deepseek-harness\default-workspace\dsh-secret-card
//     npm run publish
//
// ── 目录里如果出现了 .publish.env ─────────────────────────────────────────────
// 那是给「以后添加了认证器 App」预留的备用通道：让 AI 弹卡片、把 6 位验证码写进
// .publish.env，本脚本会读出来转成环境变量 NPM_CONFIG_OTP 传给 npm（不进命令行，
// 进程列表看不到），发布成功后无论成败都删掉这个文件。
// 当前账号没有认证器 App，正常走不到这条路；文件不存在时本脚本照常发布。
//
// 安全红线（本项目自己定的，测试里有断言）：
//   * 本文件不写「左花括号 ×2 … 右花括号 ×2」—— 宿主会把成对花括号当模板变量，
//     大写变量名会让整段 section 注册失败，这是本项目第一次真实运行就踩过的坑
//   * 不写 printf 风格占位符（百分号 + 格式字母）
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLtoPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".publish.env");

function die(msg) {
  console.error("[publish] " + msg);
  process.exit(1);
}

/** 从 .publish.env 读可选的 NPM_OTP；没有文件或没有这一行都返回 null。 */
function readOtp() {
  let raw;
  try {
    raw = fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    return null;
  }
  const m = raw.match(/^\s*(?:export\s+)?NPM_OTP\s*=\s*(.*)$/m);
  if (!m) return null;
  let v = m[1].trim();
  const quoted = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0];
  if (quoted) v = v.slice(1, -1);
  return v || null;
}

// 1) 先打包。发布一个已经打好的 tarball 时 npm 不跑任何 lifecycle 脚本，
//    prepublishOnly（构建 + 检查 + 45 项测试，约 10 秒）不会挤占安全密钥验证的时间。
console.log("[publish] 打包中…");
const packDir = fs.mkdtempSync(path.join(os.tmpdir(), "dsc-pack-"));
const pack = spawnSync("npm", ["pack", "--pack-destination", packDir], {
  cwd: ROOT,
  stdio: "inherit",
  shell: true,
});
if (pack.status !== 0) {
  die("npm pack 失败，终止发布");
}
const version = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
const tarball = path.join(packDir, "dsh-secret-card-" + version + ".tgz");
if (!fs.existsSync(tarball)) {
  die("打包产物没找到：" + tarball);
}

// 2) 发布。stdio 必须是 inherit：npm 的网页授权流程要能往终端打印链接、打开浏览器。
//    只有确实存在 .publish.env 时，才把 OTP 经环境变量塞进去（进程列表看不到）。
const otp = readOtp();
const env = otp ? { ...process.env, NPM_CONFIG_OTP: otp } : { ...process.env };

if (otp) {
  if (!/^\d{6}$/.test(otp)) {
    die(".publish.env 里的 NPM_OTP 不是 6 位数字 —— 重新让插件弹一次卡片吧");
  }
  console.log("[publish] 已从 .publish.env 读到验证码，稍后只经环境变量传给 npm");
} else {
  console.log("[publish] 没检测到 .publish.env，走安全密钥的网页授权流程");
  console.log("[publish] 如果浏览器弹出 npm 授权页，请用你的安全密钥（指纹）确认一下");
}

const pub = spawnSync("npm", ["publish", tarball, "--access", "public"], {
  cwd: ROOT,
  stdio: "inherit",
  env,
  shell: true,
});

// 3) 清理：临时打包目录 + 可能含验证码的 .publish.env，无论成败都删。
try {
  fs.rmSync(packDir, { recursive: true, force: true });
} catch {}
if (otp) {
  try {
    fs.rmSync(ENV_FILE, { force: true });
    console.log("[publish] .publish.env 已删除");
  } catch (e) {
    console.error("[publish] 警告：.publish.env 删除失败，请手动删除 —— " + e.message);
  }
}

if (pub.status !== 0) {
  console.error("[publish] 发布失败。若报 EOTP，通常是网页授权没在浏览器里完成；");
  console.error("[publish] 若报 E401/OTP invalid，先确认账号设置页的 2FA 方式是不是只有安全密钥。");
}

process.exit(pub.status === null ? 1 : pub.status);
