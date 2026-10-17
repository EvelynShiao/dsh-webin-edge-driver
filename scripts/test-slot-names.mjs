/**
 * 槽位名规则的常驻测试（`node scripts/test-slot-names.mjs`）。
 *
 * 为什么值得留一个：槽位名同时决定**快照文件名**、**profile 目录名**、
 * **配置键**，规则一旦写错就是「多账号互相串号」这种不报错、极难查的故障
 * （commit 2cf780f 修过一次：白名单漏了分隔符 `#`，所有槽位全落到同一个文件）。
 * 所以规则改动后必须跑这个。
 */
import {
  SLOT_MAX_LEN,
  isSafeSlotName,
  isSafeSnapshotName,
  safePathSegment,
} from "../lib/slot-names.js";

let pass = 0;
const fails = [];
function eq(label, got, want) {
  if (got === want) { pass++; return; }
  fails.push(`${label}：期望 ${JSON.stringify(want)}，实际 ${JSON.stringify(got)}`);
}

// ── 1. 槽位名：该放行的 ─────────────────────────────────────
for (const v of ["default", "second", "work", "工作号", "奶奶", "爷爷", "a b", "a.b", "号-1_2", "😀号"]) {
  eq(`isSafeSlotName(${JSON.stringify(v)})`, isSafeSlotName(v), true);
}

// ── 2. 槽位名：该挡的 ───────────────────────────────────────
for (const v of ["", "   ", ".", "..", "a/b", "a\\b", "a:b", "a*b", "a?b", 'a"b', "a<b", "a>b", "a|b", "a#b", "a\u0000b"]) {
  eq(`isSafeSlotName(${JSON.stringify(v)}) 应拒绝`, isSafeSlotName(v), false);
}
eq(`长度 ${SLOT_MAX_LEN} 应通过`, isSafeSlotName("x".repeat(SLOT_MAX_LEN)), true);
eq(`长度 ${SLOT_MAX_LEN + 1} 应拒绝`, isSafeSlotName("x".repeat(SLOT_MAX_LEN + 1)), false);
/** 非字符串一律拒绝（防 `{}`/`[]` 之类把路径搞坏）。 */
for (const v of [undefined, null, 123, {}, []]) eq(`isSafeSlotName(${String(v)}) 应拒绝`, isSafeSlotName(v), false);

// ── 3. 快照名：必须**允许** `#`（这就是那个 bug）──────────────
for (const v of ["deepseek", "deepseek#second", "deepseek#奶奶", "deepseek#" + "x".repeat(60)]) {
  eq(`isSafeSnapshotName(${JSON.stringify(v)})`, isSafeSnapshotName(v), true);
}
for (const v of ["../etc/passwd", "a/b", "a\\b", ".", "..", "a:b"]) {
  eq(`isSafeSnapshotName(${JSON.stringify(v)}) 应拒绝`, isSafeSnapshotName(v), false);
}

// ── 4. safePathSegment：中文必须保留，且不同中文名不能撞车 ──
eq("safePathSegment(奶奶)", safePathSegment("奶奶"), "奶奶");
eq("safePathSegment(爷爷)", safePathSegment("爷爷"), "爷爷");
eq("两个中文名不撞车", safePathSegment("奶奶") === safePathSegment("爷爷"), false);
/** 旧实现会把这两个都变成 "__"，共用一个浏览器 profile —— 用它当反例。 */
eq("旧实现确实会撞车（反例）", "奶奶".replace(/[^A-Za-z0-9_-]/g, "_") === "爷爷".replace(/[^A-Za-z0-9_-]/g, "_"), true);
eq("路径分隔被替换", safePathSegment("a/b"), "a_b");
eq("空串走 fallback", safePathSegment(""), "default");
/**
 * ⚠️ 全是分隔符时得到 `___` 而**不是** `default` —— 这是**刻意**的：
 * 若把它归到 `default`，一个名叫 `///` 的槽位就会和默认槽位**共用同一个
 * 浏览器 profile**，登录态互相覆盖。宁可留个难看的目录名，也不能撞。
 * 而且 `///` 这类名字在 API 入口就被 `isSafeSlotName` 拒了，
 * 这里的替换只是纵深防御。
 */
eq("全是分隔符也不回落到 default", safePathSegment("///"), "___");
eq("长度被截断", safePathSegment("x".repeat(200)).length, SLOT_MAX_LEN);

// ── 5. 路径隔离：不同槽位必须落到不同文件 ───────────────────
/** 复刻 snapshotPath 的判定（与 lib/index.js 保持一致）。 */
const snap = (name) => `auth/${isSafeSnapshotName(name) ? name : "default"}.json`;
eq("default 槽位", snap("deepseek"), "auth/deepseek.json");
eq("第二个槽位", snap("deepseek#second"), "auth/deepseek#second.json");
eq("中文槽位", snap("deepseek#奶奶"), "auth/deepseek#奶奶.json");
/**
 * ⚠️ 含 `/` 的组合名被**整体拒掉**、回落到 default —— 这是安全边界在工作。
 * （第一道防线是入口处按段校验，这里是第二道：万一有人绕过入口直接拼名字，
 * 也不能让它造出目录层级。）
 */
eq("含路径分隔被整体拒绝", snap("deepseek#../x"), "auth/default.json");
const uniq = new Set([snap("deepseek"), snap("deepseek#a"), snap("deepseek#b"), snap("deepseek#奶奶")]);
eq("四个槽位四个文件", uniq.size, 4);

// ── 6. 交叉验证：profile 目录必须与快照名的规则一致 ──────────
/**
 * 这是那个串号 bug 的**同类风险点**：`edge-driver.js` 的 `userDataDirFor()`
 * （浏览器实际用哪个 profile）与 `index.js` 的 `edgeProfileDirFor()`
 * （登录判据去哪读 cookie）必须算出**同一个目录**。两处都改成共用
 * `safePathSegment` 之后，这里至少把 driver 那侧真跑一遍。
 */
const { EdgeDriver, EDGE_DRIVER_DEFAULTS } = await import("../lib/edge-driver.js");
const drv = new EdgeDriver({
  config: { ...EDGE_DRIVER_DEFAULTS, enabled: false, userDataDir: "X:\\fake-ldw" },
  log: { info() {}, warn() {}, debug() {} },
  getProvider: () => undefined,
});
const dir = (slot) => drv.userDataDirFor("deepseek", slot);
eq("default 槽位不拼账号层", dir("default"), "X:\\fake-ldw\\deepseek");
eq("中文槽位被保留", dir("奶奶"), "X:\\fake-ldw\\deepseek\\奶奶");
eq("两个中文槽位不撞车", dir("奶奶") === dir("爷爷"), false);
eq("英文槽位照常", dir("work"), "X:\\fake-ldw\\deepseek\\work");
/** 危险字符即使绕过入口校验，也不会造出目录层级。 */
eq("斜杠不会造层级", dir("a/b"), "X:\\fake-ldw\\deepseek\\a_b");
eq("穿越不会逃逸", dir(".."), "X:\\fake-ldw\\deepseek");

// ── 输出 ────────────────────────────────────────────────────
console.log("\n槽位名规则测试\n" + "─".repeat(56));
if (fails.length === 0) {
  console.log(`  全部通过（${pass} 项）\n`);
} else {
  for (const f of fails) console.log(`  ❌ ${f}`);
  console.log(`\n  ${pass} 通过 / ${fails.length} 失败\n`);
  process.exitCode = 1;
}
