/**
 * 登录态探针（读 Edge profile 的 Cookie，**零依赖、不起浏览器**）
 * ============================================================
 *
 * ## 为什么需要这个
 *
 * webin 的登录判据 `isPlatformLoggedIn()` 只认 `~/.dsh/webin/auth/<平台>.json`
 * 快照。而快照**只在任务跑通之后**才写（edge-driver 领活成功 → runJob 成功
 * → 顺手写快照）。于是形成死锁：
 *
 * ```
 *   未登录快照 ⇒ host 门禁判 false ⇒ 任务不入队
 *              ⇒ driver 领不到活 ⇒ runJob 不跑 ⇒ 快照永远写不出来
 * ```
 *
 * 用户看到的：**「我明明登录了，它一直说我没登录」**。
 *
 * ## 解法：直接读真 Edge profile 里的 Cookie
 *
 * 登录态的真正载体是 **Edge profile 的 cookie**（`<profile>/Default/Network/Cookies`，
 * SQLite 库）。所以：
 *
 *   - **零成本**：只读文件，不起 Edge、不联网、不占内存（用户对常驻进程敏感）
 *   - **跨重启**：cookie 是持久化的，重启 DSH 后判据依然成立
 *   - **不碰指纹**：纯本地读文件，页面侧完全无感
 *   - **不解密**：只看 cookie **名**与**密文长度**，不尝试解密值
 *     （Chromium 的加密值要用 DPAPI + AES-GCM 解，没必要也不该做）
 *
 * ## 判据设计：为什么「名字 + 密文长度」就够
 *
 * Chromium 里登出会**删掉** cookie（或把它清成空值）。所以「该平台的特征
 * cookie 存在且密文非空」是登录态的可靠证据。实测四个平台各取自己的特征名：
 *
 * | 平台 | 特征 cookie | 实测密文长度 |
 * |---|---|---|
 * | 元宝 yuanbao | `hy_token` | 663 B |
 * | 千问 qwen | `tongyi_sso_ticket` | 140 B |
 * | 豆包 doubao | `sid_guard` | 156 B |
 * | DeepSeek | `ds_session_id` | 95 B |
 *
 * 阈值取 20 字节：既排除「空值/占位」，又不会因为 cookie 变短而误判。
 * 每个平台配**多个候选名**（任一命中即算登录），防止单一 cookie 改名就失效。
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";

/**
 * `node:sqlite` 是 Node 22+ 内置模块，**无需任何依赖**。
 * ESM 里没有 `require`，用 `createRequire` 拿一个（同步、零开销）。
 */
const require = createRequire(import.meta.url);

/**
 * 各平台的特征登录 cookie。
 *
 * `hostSuffix` 用来确认 cookie 确实属于该平台（而不是同域下别的服务的同名 cookie）。
 * `names` 是候选名，**任一**存在且密文非空即算登录。
 */
export const LOGIN_COOKIE_RULES = {
  yuanbao: {
    hostSuffix: "tencent.com",
    names: ["hy_token", "hy_user"],
  },
  qwen: {
    hostSuffix: "qianwen.com",
    names: ["tongyi_sso_ticket", "tongyi_sso_ticket_hash"],
  },
  doubao: {
    hostSuffix: "doubao.com",
    names: ["sid_guard", "sessionid", "sessionid_ss"],
  },
  deepseek: {
    hostSuffix: "deepseek.com",
    names: ["ds_session_id"],
  },
};

/** 密文长度下限：低于这个值视为空值/占位（登出后 Chromium 会留空 cookie）。 */
const MIN_CIPHER_BYTES = 20;

/**
 * 只读打开某个 profile 的 cookie 库，返回 {host,name,elen} 列表。
 *
 * ⚠️ **必须用只读模式**（`readOnly: true`）：
 *   - Edge 运行时 cookie 库可能被锁；只读能避免 SQLITE_BUSY
 *   - 绝不能写用户的 cookie 库 —— 那是登录态的家
 *
 * 打不开时返回 null（不是空数组）—— 调用方据此区分「没有登录 cookie」和
 * 「读不了（Edge 锁着 / 库坏了）」，前者是明确未登录，后者应该回退到旧判据。
 *
 * @returns {Array<{host:string,name:string,elen:number}>|null}
 */
export function readProfileCookies(profileDir) {
  const file = join(profileDir, "Default", "Network", "Cookies");
  if (!existsSync(file)) return null;
  let db;
  try {
    const { DatabaseSync } = require("node:sqlite");
    db = new DatabaseSync(file, { readOnly: true });
    const rows = db
      .prepare("SELECT host_key AS host, name, length(encrypted_value) AS elen FROM cookies")
      .all();
    return rows.map((r) => ({ host: String(r.host ?? ""), name: String(r.name ?? ""), elen: Number(r.elen ?? 0) }));
  } catch {
    return null;
  } finally {
    try { db?.close(); } catch { /* 关不掉也不影响 */ }
  }
}

/**
 * 用 cookie 判据判断某平台是否登录。
 *
 * @param {string} platformId - 平台 id（yuanbao / qwen / doubao / deepseek）
 * @param {string} profileDir - 该平台的 Edge profile 目录
 * @returns {{loggedIn:boolean, reason:string, cookie?:string}}
 */
export function isLoggedInByCookies(platformId, profileDir) {
  const rule = LOGIN_COOKIE_RULES[platformId];
  if (rule === undefined) return { loggedIn: false, reason: "no-rule" };
  const rows = readProfileCookies(profileDir);
  if (rows === null) return { loggedIn: false, reason: "profile-unreadable" };
  for (const r of rows) {
    if (r.elen < MIN_CIPHER_BYTES) continue;
    if (!r.host.includes(rule.hostSuffix)) continue;
    if (!rule.names.includes(r.name)) continue;
    return { loggedIn: true, reason: "cookie", cookie: r.name };
  }
  return { loggedIn: false, reason: "no-login-cookie" };
}
