// 文案红线检查：发给宿主的每一段文案，出现这些字面量会直接把插件 section 搞炸。
//   1) 成对双花括号（两个连续左花括号 ... 两个连续右花括号）—— 宿主当成 prompt 变量引用，
//      大写变量名会让整段 section 注册失败，报 malformed prompt variable reference
//   2) printf 风格占位，如 %s %d %i %f —— 宿主会做二次格式化，报 too few arguments / bad format
//   3) 控制字符 —— 宿主 normalize 时剥成乱码或直接拒绝
//
// 本项目唯一允许的占位符是 %%SECRET%%，由本文件末尾的 LEGIT 常量守着：
// 一旦有人把它"修"成双花括号版本或干脆删掉，这里立刻失败。
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const LEGIT = "%%SECRET%%";

const OPEN = "{" + "{"; // 只这样拼，不写连续字面量
const CLOSE = "}" + "}";

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else out.push(p);
  }
  return out;
}

// 只扫会进入 npm 发布包的文件：src / client / package.json / README / cordis.patch.yml
const PUBLISHED = ["src", "client", "package.json", "README.md", "cordis.patch.yml"];
const files = [];
for (const rel of PUBLISHED) {
  const abs = path.join(ROOT, rel);
  if (!fs.existsSync(abs)) continue;
  if (fs.statSync(abs).isDirectory()) walk(abs, files);
  else files.push(abs);
}

// [ 正则, 是否要先抹掉 %% 再查, 宿主侧症状 ]
const RULES = [
  [new RegExp(OPEN + "[^{}]*" + CLOSE, "g"), false, "宿主当 prompt 变量引用，大写变量名会让整段 section 注册失败"],
  [/%[sdifoexcgunp]/g, true, "宿主二次格式化时报 too few arguments / bad format"],
  [/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, false, "宿主 normalize 时剥成乱码或直接拒绝"],
];

let checked = 0;
const bad = [];
for (const f of files) {
  const text = fs.readFileSync(f, "utf8");
  checked++;
  for (const [re, stripPct, why] of RULES) {
    // %% 是本项目的合法占位符，查 printf 风格前先抹掉，否则 %%SECRET%% 会被误报
    const scan = stripPct ? text.split("%%").join("") : text;
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(scan)) !== null) {
      const line = scan.slice(0, m.index).split("\n").length;
      bad.push(path.relative(ROOT, f) + ":" + line + "  命中 " + JSON.stringify(m[0]) + "\n      → " + why);
    }
  }
}

// 合法占位符必须仍然存在
const all = files.map((f) => fs.readFileSync(f, "utf8")).join("\n");
if (!all.includes(LEGIT)) {
  bad.push("合法占位符 " + LEGIT + " 在所有发布文件里都找不到了 —— 检查是否被误改成双花括号版本");
}

if (bad.length) {
  console.error("文案红线检查失败（扫了 " + checked + " 个文件）：");
  for (const b of bad) console.error("  - " + b);
  process.exit(1);
}
console.log("文案红线 OK：" + checked + " 个文件，无双花括号 / printf 占位 / 控制字符，" + LEGIT + " 完好");
