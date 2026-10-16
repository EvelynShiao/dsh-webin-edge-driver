/**
 * 槽位名 / 快照名的**唯一**规则来源
 * ================================
 *
 * ## 为什么单独一个模块
 *
 * 槽位名（账号名）会同时落进**三个地方**：
 *
 *   1. 快照文件名：`<DSH_HOME>/webin/auth/<平台>#<槽位>.json`
 *   2. profile 目录名：`<DSH_HOME>/edge-ldw/<平台>/<槽位>/`
 *   3. 配置文件键：`accounts.<平台>.slots[]` / `.active`
 *
 * 这三处**必须用同一套规则**。历史上就是因为两处各自写了个
 * `replace(/[^A-Za-z0-9_-]/g, "_")`，而白名单又漏了分隔符 `#`，
 * 导致「所有槽位都落到同一个快照文件」的双向串号（commit 2cf780f 修的）。
 * 所以现在把规则收拢到这里，index.js 与 edge-driver.js 都 import 它 ——
 * **不要再各自写一份**。
 *
 * ## 规则：只挡真正危险的东西，中文原样放行
 *
 * 用户要中文账号名（他原来那个 py 里就有「奶奶」这种名字）。所以规则是
 * 「黑名单」而不是「白名单」—— 只屏蔽会出事的字符：
 *
 *   | 挡什么 | 为什么 |
 *   |---|---|
 *   | `/` `\` | 路径分隔，能造目录层级 ⇒ 路径穿越 |
 *   | `:` `*` `?` `"` `<` `>` `\|` | Windows 文件名保留字符，建不出来 |
 *   | 控制字符 `\x00-\x1f` | 文件名里非法 |
 *   | 恰好是 `.` 或 `..` | 目录穿越 |
 *   | 槽位名里的 `#` | 它是 `平台#槽位` 的分隔符；禁掉才能保证「组合名里只有一个 #」这个不变量 |
 *
 * 中文、日文、emoji、空格、点（`a.b`）都放行。
 */

/** 槽位名长度上限（**字符数**，不是字节数 —— 中文一个字算一个）。 */
export const SLOT_MAX_LEN = 48;

/**
 * 快照名的长度上限。
 *
 * 组合名 = `平台名` + `#` + `槽位名`，而平台名上限 64、槽位上限 48
 * ⇒ 最长 64 + 1 + 48 = 113。取 160 留余量。
 *
 * ⚠️ 历史坑：旧代码这里写的是 64 —— 于是长名字也被静默打回默认槽位。
 */
export const SNAPSHOT_MAX_LEN = 160;

/** 文件名里一律禁止的字符（含路径分隔与 Windows 保留字符）。 */
const FORBIDDEN = /[/\\:*?"<>|\x00-\x1f]/;

/**
 * 「快照名」是否可用：`平台#槽位`（**允许** `#`）或裸平台名。
 *
 * 注意这是**第二道防线**：组合名的两段在各自入口已经校验过，
 * 这里再确认一次，防的是「以后有人绕过入口直接拼名字」。
 */
export function isSafeSnapshotName(s) {
  if (typeof s !== "string") return false;
  const v = s.trim();
  if (v === "" || v.length > SNAPSHOT_MAX_LEN) return false;
  if (v === "." || v === "..") return false;
  return !FORBIDDEN.test(v);
}

/**
 * 「槽位名」是否可用（比快照名更严：不许含 `#`，且有 48 长度上限）。
 *
 * @param {unknown} s
 * @returns {boolean}
 */
export function isSafeSlotName(s) {
  if (typeof s !== "string") return false;
  const v = s.trim();
  if (v.length > SLOT_MAX_LEN) return false;
  if (v.includes("#")) return false;
  return isSafeSnapshotName(v);
}

/**
 * 把任意字符串净化成**可安全当路径段**的形式（保留中文）。
 *
 * 用途：profile 目录名（`edge-ldw/<平台>/<槽位>`）。
 *
 * ⚠️ 与旧实现的区别：旧的是 `replace(/[^A-Za-z0-9_-]/g, "_")` ——
 * 把**所有非 ASCII 都换成下划线**，于是「奶奶」和「爷爷」会变成同一个
 * `__`，两个账号共用一个浏览器 profile（登录态互相覆盖）。
 * 现在只替换**危险字符**，中文原样保留，从根上消掉这个碰撞。
 *
 * @param {unknown} s
 * @param {string} fallback 净化后为空时用它（避免生成空目录名）
 */
export function safePathSegment(s, fallback = "default") {
  const raw = typeof s === "string" ? s.trim() : "";
  let out = raw.replace(new RegExp(FORBIDDEN.source, "g"), "_");
  /** 首尾的点会让 Windows 建目录行为诡异（如以点结尾的目录名），顺手去掉。 */
  out = out.replace(/^\.+/, "").replace(/\.+$/, "");
  out = out.slice(0, SLOT_MAX_LEN);
  return out === "" ? fallback : out;
}

/** 给人看的规则说明（报错信息里用，避免各处措辞不一致）。 */
export function slotRuleText() {
  return `槽位名不能为空、不超过 ${SLOT_MAX_LEN} 个字符，且不能含 / \\ : * ? " < > | # 或控制字符（中文可以）`;
}
