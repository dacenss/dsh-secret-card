// 发布助手：把 npm 两步验证码（OTP）交给自己，不交给 AI。
//
// 分工：
//   AI    —— 只调用 secret_card 描述「写到哪个文件、哪个键」，从来看不到 OTP
//   用户  —— 在弹窗卡片里输 6 位验证码，插件直接写进 .publish.env
//   本脚本 —— 从 .publish.env 读 OTP，转成 NPM_CONFIG_OTP 环境变量喂给 npm publish
//
// OTP 只在环境变量里存在，不进命令行参数（进程列表看不到），用完立刻删掉 .publish_env。
// 本文件自身也守一条红线：代码里出现成对双花括号会让宿主把这段 section 当模板炸掉，
// 所以下面一律用拼接 / 数组下标，绝不写 $ { ... } 两个连续花括号。
const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const ENV_FILE = path.join(ROOT, ".publish.env");

function die(msg) {
  console.error("[publish] " + msg);
  process.exitCode = 1;
}

function readOtp() {
  let raw;
  try {
    raw = fs.readFileSync(ENV_FILE, "utf8");
  } catch {
    return null;
  }
  // 支持 NPM_OTP="123456" / NPM_OTP=123456 / export NPM_OTP=...
  const m = raw.match(/^\s*(?:export\s+)?NPM_OTP\s*=\s*(.*)$/m);
  if (!m) return null;
  let v = m[1].trim();
  const quoted = v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0];
  if (quoted) v = v.slice(1, -1);
  return v || null;
}

if (!fs.existsSync(ENV_FILE)) {
  die("找不到 .publish.env —— 先让插件弹卡片、由你输入验证码写进这个文件，再跑 npm run publish");
  process.exit(process.exitCode);
}

const otp = readOtp();
if (!otp) {
  die(".publish.env 里没有 NPM_OTP= 这一行（卡片是不是没写成功？）");
  process.exit(process.exitCode);
}
if (!/^\d{6}$/.test(otp)) {
  die("NPM_OTP 不是 6 位数字（长度=" + otp.length + "）—— 验证码有有效期，重新弹一次卡片吧");
  process.exit(process.exitCode);
}

console.log("[publish] 已从 .publish.env 读到 6 位验证码，开始 npm publish …");
console.log("[publish] OTP 只通过环境变量传递，不进命令行参数");

// OTP 走环境变量 NPM_CONFIG_OTP：npm 原生支持，且不出现在进程命令行里
const r = spawnSync("npm", ["publish", "--access", "public"], {
  cwd: ROOT,
  stdio: "inherit",
  env: Object.assign({}, process.env, { NPM_CONFIG_OTP: otp }),
  shell: true,
});

try {
  fs.rmSync(ENV_FILE, { force: true });
  console.log("[publish] .publish.env 已删除");
} catch (e) {
  console.error("[publish] 警告：.publish.env 删除失败，请手动删除 —— " + e.message);
}

process.exit(r.status === null ? 1 : r.status);
