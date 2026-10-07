// 发布助手：把 npm 两步验证码（OTP）交给自己，不交给 AI。
//
// 分工：
//   AI    —— 只调用 secret_card 描述「写到哪个文件、哪个键」，从来看不到 OTP
//   用户  —— 在弹窗卡片里输 6 位验证码，插件直接写进 .publish.env
//   本脚本 —— 从 .publish.env 读 OTP，转成 NPM_CONFIG_OTP 环境变量喂给 npm publish
//
// 为了把「用户输完码」到「码提交给 npm」之间的时间压到最短（验证码约 30 秒过期），
// 这里走「先 npm pack 打好包、再 npm publish <tarball>」两步：
//   npm pack     : 只跑 prepack/postpack，本包没有这俩脚本，秒完
//   npm publish  : 发布一个已打好的 tarball 时 npm 不跑任何 lifecycle 脚本，
//                  所以不会把 prepublishOnly（构建+检查+45 项测试）那几秒耗在验证码窗口里
// 发布的正确性由调用方在弹卡片之前先跑一遍 npm test 保证，prepublishOnly 仍然留在
// package.json 里，人工直接 npm publish 时照样会触发。
//
// OTP 只在环境变量里存在，不进命令行参数（进程列表看不到），用完立刻删掉临时文件。
// 本文件自身也守一条红线：代码里出现成对双花括号会让宿主把这段 section 当模板炸掉，
// 所以下面一律用拼接 / 变量，绝不写两个连续花括号。
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ENV_FILE = path.join(ROOT, ".publish.env");
const OPEN = "{" + "{"; // 只这样拼，不写连续字面量

function die(msg) {
  console.error("[publish] " + msg);
  process.exit(1);
}

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

if (!fs.existsSync(ENV_FILE)) {
  die("找不到 .publish.env —— 先让插件弹卡片、由你输入验证码写进这个文件，再跑 npm run publish");
}

const otp = readOtp();
if (!otp) {
  die(".publish.env 里没有 NPM_OTP= 这一行（卡片是不是没写成功？）");
}
if (!/^\d{6}$/.test(otp)) {
  die("NPM_OTP 不是 6 位数字（长度=" + otp.length + "）—— 验证码有有效期，重新弹一次卡片吧");
}

// 1) 先打包（不跑生命周期脚本，毫秒级）
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
const tarball = path.join(packDir, "dsh-secret-card-" + JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")).version + ".tgz");
if (!fs.existsSync(tarball)) {
  die("打包产物没找到：" + tarball);
}

// 2) 直接发布这个 tarball：不跑 prepublishOnly，验证码窗口不被测试耗时吃掉
console.log("[publish] 提交发布（OTP 只经环境变量 NPM_CONFIG_OTP，不进命令行）…");
const pub = spawnSync("npm", ["publish", tarball, "--access", "public"], {
  cwd: ROOT,
  stdio: "inherit",
  env: { ...process.env, NPM_CONFIG_OTP: otp },
  shell: true,
});

// 3) 清理：临时目录 + 含验证码的 .publish.env，无论成败都删
try {
  fs.rmSync(packDir, { recursive: true, force: true });
} catch {}
try {
  fs.rmSync(ENV_FILE, { force: true });
  console.log("[publish] .publish.env 已删除");
} catch (e) {
  console.error("[publish] 警告：.publish.env 删除失败，请手动删除 —— " + e.message);
}

if (pub.status !== 0) {
  console.error("[publish] 发布失败。最常见原因是验证码过期（约 30 秒）—— 重新弹一次卡片、马上再试即可");
}

process.exit(pub.status === null ? 1 : pub.status);
