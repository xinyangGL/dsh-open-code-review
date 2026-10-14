#!/usr/bin/env node
/**
 * 打包体检（批 3）：`npm pack --dry-run` 到底会把什么发到社区。
 *
 * 为什么要单独一条：这份包是给人从 GitHub `dsh plugin add github:…` 装的 ——
 * 包里多带一份活配置（`config.json`）、一份内部自评（写着「还不成熟」）、或者少一张 README 里
 * 链过去的图，都不是「代码对不对」的问题，但都是上架时会绊人的问题。
 *
 * 这里只做**可核对的断言**（不评价内容好坏）：
 *   1. 版本号三处一致：package.json / npm 打出来的包 / CHANGELOG 最新一节；
 *   2. 必需文件在包里；
 *   3. 危险或内部文件不在包里（活配置、日志、测试、内部计划与自评、.git/node_modules）；
 *   4. README（中英）里每个 `docs/…` 引用，要么就在包里，要么写成了 GitHub 绝对链接。
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
let pass = 0;
let fail = 0;
function check(name, ok, detail = "") {
  if (ok) {
    pass += 1;
    console.log(`PASS ${name}${detail ? ` — ${detail}` : ""}`);
  } else {
    fail += 1;
    console.log(`FAIL ${name}${detail ? ` — ${detail}` : ""}`);
  }
}

const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
/* Windows 上 npm 是 npm.cmd，必须过 shell；其它平台直接 spawn 更省一层。 */
const raw = execFileSync("npm", ["pack", "--dry-run", "--json"], {
  cwd: root,
  encoding: "utf8",
  shell: process.platform === "win32",
  stdio: ["ignore", "pipe", "pipe"],
});
const packed = JSON.parse(raw)[0];
const files = (packed.files ?? []).map((f) => String(f.path).replace(/\\/g, "/"));

/* ---------- 1. 版本号三处一致 ---------- */
const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
const top = changelog.match(/^##\s*\[([0-9]+\.[0-9]+\.[0-9]+)\]/m);
check(
  "打包体检：版本号三处一致（package.json / npm pack / CHANGELOG 最新一节）",
  Boolean(top) && top[1] === pkg.version && pkg.version === packed.version,
  `package.json=${pkg.version} · pack=${packed.version} · CHANGELOG=${top ? top[1] : "（没找到 ## [x.y.z]）"}`,
);

/* ---------- 2. 必需文件在包里 ---------- */
const required = [
  "package.json",
  "lib/index.js",
  "lib/client.js",
  "README.md",
  "README.zh.md",
  "CHANGELOG.md",
  "LICENSE",
  "icon.svg",
  "config.example.json",
  "cordis.patch.yml",
  "docs/host-contract.md",
  "docs/settings-basic.png",
  "docs/settings-advanced.png",
];
const missing = required.filter((path) => !files.includes(path));
check("打包体检：必需文件都在包里（插件主体 + 两份 README + 示例配置 + README 里链到的图/文档）", missing.length === 0, missing.length === 0 ? `${files.length} 个文件` : `缺：${missing.join("、")}`);

/* ---------- 3. 危险/内部文件不在包里 ---------- */
const forbidden = [
  { test: (p) => p === "config.json", why: "活配置（从别处复制来的 ocrPath / 密钥引用不该跟着包走）" },
  { test: (p) => p.startsWith("test/"), why: "测试" },
  { test: (p) => /\.log$/.test(p), why: "日志" },
  { test: (p) => p.startsWith(".git/") || p.startsWith("node_modules/"), why: ".git / node_modules" },
  { test: (p) => p.startsWith(".graphflow") || p.startsWith("graphflow-out/"), why: "GraphFlow 产物" },
  { test: (p) => p === "docs/maturity-assessment-2026-10-10.md", why: "内部自评（写着「还不成熟」）" },
  { test: (p) => p === "docs/ROADMAP.md", why: "内部路线图" },
  { test: (p) => /^docs\/(usability|review-quality)-plan-/.test(p), why: "内部工作计划" },
];
const leaked = [];
for (const path of files) {
  for (const rule of forbidden) {
    if (rule.test(path)) leaked.push(`${path}（${rule.why}）`);
  }
}
check("打包体检：活配置 / 日志 / 测试 / 内部计划与自评都没进包", leaked.length === 0, leaked.length === 0 ? `检查了 ${forbidden.length} 类` : leaked.join("；"));

/* ---------- 4. README 里的 docs/ 引用必须能被装到包的人打开 ---------- */
const refs = new Map();
for (const name of ["README.md", "README.zh.md"]) {
  const text = readFileSync(join(root, name), "utf8");
  for (const line of text.split(/\r?\n/)) {
    const absolute = /https?:\/\/(?:www\.)?github\.com\//.test(line);
    for (const m of line.matchAll(/docs\/[A-Za-z0-9._/-]+\.(?:md|png|svg|jpg)/g)) {
      const spots = refs.get(m[0]) ?? [];
      spots.push({ name, absolute });
      refs.set(m[0], spots);
    }
  }
}
const broken = [];
for (const [path, spots] of refs) {
  if (files.includes(path)) continue;
  const local = spots.filter((s) => !s.absolute).map((s) => s.name);
  if (local.length > 0) broken.push(`${path}（${local.join(" / ")} 本地引用，但没进包）`);
}
check(
  "打包体检：README 里提到的每个 docs/ 文件，要么进包、要么写成 GitHub 绝对链接",
  broken.length === 0,
  broken.length === 0 ? `${refs.size} 个引用` : broken.join("；"),
);

console.log(`\n打包体检：${pass} 项通过${fail > 0 ? ` · ${fail} 项失败` : ""}（共 ${pass + fail} 项）`);
process.exit(fail === 0 ? 0 : 1);
