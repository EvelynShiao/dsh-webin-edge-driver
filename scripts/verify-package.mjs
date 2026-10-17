/**
 * 插件包自检 —— 本仓库的「装上不会崩」守卫。
 *
 * 用法：node scripts/verify-package.mjs      （或在仓库根目录 npm run verify）
 *
 * ## 为什么需要它
 *
 * 2026-10-16 踩过的坑：本插件是完整包 `dsh-webin-edge-driver`，但
 * `lib/client.js` / `lib/index.js` 是从上游（包名 `dsh-webin`）改出来的，
 * 里面的**注册名忘了跟着改**。后果是 DSH 启动直接报：
 *
 *     dsh-webin-edge-driver: import failed: loaded without registering
 *     "dsh-webin-edge-driver" via __ModuleLoader__.load
 *
 * 整条插件都不激活，而且报错信息指向 `__ModuleLoader__`，很难一眼看出
 * 是「注册名 ≠ 包名」。所以把这条检查固化成脚本 —— 改包名、改 id、
 * 换上游版本之前先跑一遍。
 *
 * 它检查的全是**结构性**问题（不联网、不起浏览器、不需要 DSH 在跑）。
 */
import { readFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const fail = [];
const ok = [];

function check(label, pass, detail = "") {
  if (pass) ok.push(label);
  else fail.push(`${label}${detail ? `  —— ${detail}` : ""}`);
}

// ── 1. 必备文件 ─────────────────────────────────────────────
const REQUIRED = [
  "package.json",
  "cordis.patch.yml",
  "lib/index.js",
  "lib/client.js",
  "lib/edge-driver.js",
  "lib/edge-driver-scripts.js",
  "lib/login-cookie-probe.js",
  "lib/login-cookie-probe-worker.js",
  "lib/credential-store.js",
  "lib/session-gc.js",
  "lib/slot-names.js",
];
for (const f of REQUIRED) {
  check(`存在 ${f}`, existsSync(join(root, f)), "缺了会导致加载即崩");
}

// Android/proot 下要靠这个启动器才能把 Chrome 起起来 —— 缺了不会崩，
// 但手机上必然复现「CDP 端口起来随即 SIGTRAP」那个静默崩溃。
check(
  "存在 scripts/chrome-proot-launcher.py",
  existsSync(join(root, "scripts/chrome-proot-launcher.py")),
  "缺了 Android/proot 下 Chrome 会静默自杀（DevTools listening 后立刻 SIGTRAP）",
);

// ── 2. package.json 字段 ────────────────────────────────────
let pkg = null;
try {
  pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  ok.push("package.json 是合法 JSON");
} catch (e) {
  fail.push(`package.json 解析失败 —— ${String(e?.message ?? e)}`);
}

let patchPath = "";
if (pkg !== null) {
  patchPath = String(pkg?.dsh?.bundle?.patch ?? "");
  check("有 dsh.bundle.patch 字段", patchPath !== "", "缺了 DSH 会拒绝安装（手机端就是这个报错）");
  check("main 指向 lib/index.js", String(pkg?.main ?? "") === "./lib/index.js");
  check('exports["./client"] 指向 lib/client.js', String(pkg?.exports?.["./client"]?.default ?? "") === "./lib/client.js");
  if (patchPath !== "") {
    const abs = join(root, patchPath.replace(/^\.\//, ""));
    check(`dsh.bundle.patch 指向的文件真实存在（${patchPath}）`, existsSync(abs));
  }
}

// ── 3. ★ 四方标识符一致（就是这次踩的坑）────────────────────
/**
 * 这四处必须完全相等，否则插件注册不上：
 *   ① package.json 的 name      —— DSH 按包名解析
 *   ② client.js 的注册 id        —— client-modules 按包名核对注册
 *   ③ index.js 的 const name     —— host 侧插件注册名
 *   ④ cordis.patch.yml 的 name   —— bundle 层要加载的模块名
 */
const pkgName = String(pkg?.name ?? "");

let clientId = "";
try {
  const head = readFileSync(join(root, "lib/client.js"), "utf8").split("\n", 40).join("\n");
  const m = head.match(/id:\s*"([^"]+)"/);
  clientId = m?.[1] ?? "";
} catch { /* 读不到就是空，下面会报 */ }

let hostName = "";
try {
  const src = readFileSync(join(root, "lib/index.js"), "utf8");
  const m = src.match(/^const name = "([^"]+)";/m);
  hostName = m?.[1] ?? "";
} catch { /* 同上 */ }

let patchName = "";
try {
  const yml = readFileSync(join(root, String(patchPath || "cordis.patch.yml")), "utf8");
  const m = yml.match(/name:\s*'([^']+)'/);
  patchName = m?.[1] ?? "";
} catch { /* 同上 */ }

const four = { "package.json name": pkgName, "client.js id": clientId, "index.js const name": hostName, "cordis.patch.yml name": patchName };
for (const [k, v] of Object.entries(four)) {
  check(`${k} 非空`, v !== "", "没抓到值，检查写法是否变了");
}
const uniq = [...new Set(Object.values(four).filter((v) => v !== ""))];
check(
  `★ 四处标识符完全一致（${pkgName}）`,
  uniq.length === 1 && pkgName !== "",
  uniq.length > 1 ? `不一致：${JSON.stringify(four)}` : "",
);

// ── 4. 入口能被加载（= 所有本地 import 都解析得到）──────────
try {
  const m = await import(`file://${join(root, "lib/index.js").replace(/\\/g, "/")}`);
  check("lib/index.js 可加载", true);
  check("导出 apply", typeof m.apply === "function");
  check("导出 inject", Array.isArray(m.inject));
  check("导出 name", typeof m.name === "string" && m.name === pkgName, `name=${m.name}`);
} catch (e) {
  check("lib/index.js 可加载", false, String(e?.message ?? e).slice(0, 200));
}

// ── 5. 不该动的内部约定（防止「顺手改名」改坏）──────────────
if (pkg !== null) {
  try {
    const host = readFileSync(join(root, "lib/index.js"), "utf8");
    const client = readFileSync(join(root, "lib/client.js"), "utf8");
    const apiHost = host.match(/const API_PREFIX = "([^"]+)"/)?.[1] ?? "";
    const apiClient = client.match(/const API_PREFIX = "([^"]+)"/)?.[1] ?? "";
    check("API_PREFIX 两半一致", apiHost !== "" && apiHost === apiClient, `host=${apiHost} client=${apiClient}`);
    check("API_PREFIX 仍为 /dsh-webin/api", apiHost === "/dsh-webin/api", `实际=${apiHost}（改它会让 host/client 之外的调用全 404）`);
  } catch { /* 上面已报 */ }
}

// ── 输出 ────────────────────────────────────────────────────
console.log(`\n插件包自检 · ${pkgName || "(包名未读到)"}\n${"─".repeat(60)}`);
for (const o of ok) console.log(`  ✅ ${o}`);
for (const f of fail) console.log(`  ❌ ${f}`);
console.log("─".repeat(60));
if (fail.length === 0) {
  console.log(`  全部通过（${ok.length} 项）\n`);
} else {
  console.log(`  ${ok.length} 通过 / ${fail.length} 失败 —— 修完再装，否则 DSH 会启动失败\n`);
  process.exitCode = 1;
}
