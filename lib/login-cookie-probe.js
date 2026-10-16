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
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { createRequire } from "node:module";
import { createHash } from "node:crypto";
import { homedir } from "node:os";

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
  /**
   * ## ⚠️⚠️ cookie 库的位置**不是固定的**（2026-10-17 Android 真机踩到）
   *
   * 老代码写死 `<profile>/Default/Network/Cookies`。而手机上那台
   * **Chrome 155 把 cookie 写在 `<profile>/Default/Cookies`**（旧布局）——
   * 于是探针每次都 `existsSync` 失败 ⇒ 一路返回 null ⇒
   * `isPlatformLoggedIn()` 判「未登录」⇒ **登录态永远认不出来**：
   *   · 模型选择器里不列 LDW 模型
   *   · 用户明明刚用凭据登进去（注入时页面探针已确认 loggedIn），这里还是 false
   * 表现就是「登录了却说没登录」，而且**快得可疑**（0ms 直接放弃）。
   *
   * 所以按**候选表**依次找，找到哪个用哪个（三种布局都覆盖）。
   */
  const candidates = [
    ["Default", "Network", "Cookies"],
    ["Default", "Cookies"],
    ["Cookies"]
  ];
  let file = "";
  for (const parts of candidates) {
    const p = join(profileDir, ...parts);
    if (existsSync(p)) {
      file = p;
      break;
    }
  }
  if (file === "") return null;
  /**
   * ① 首选：直接只读打开（不碰用户数据）。
   *
   * ② 回退：**复制到缓存目录再读**。
   *
   * 为什么需要回退（2026-10-16 真机踩到）：Chromium 的 cookie 库是 **WAL 模式**，
   * 「只读打开一个带 WAL 的库」要求 `-shm` 存在且可写。Edge 正开着时这个前提
   * **时好时坏** —— 实测同一个千问 profile：手工试能读（27 条），插件跑的时候
   * 报 `unable to open database file`。判据因此偶发失效，表现是「登录态忽好忽坏」，
   * 比稳定失败更难查。
   *
   * 复制一份再读就绕开所有锁：副本是自己的，随便写（SQLite 可自由重建 `-shm`），
   * 也绝不碰用户的真实登录数据。
   */
  /**
   * ## ⚠️⚠️ 只走「复制后读副本」（copyFirstOnly，2026-10-16 根治阻塞）
   *
   * 曾经是「先直读原库，失败再复制」。**顺序是错的**：
   *
   *   · 直读原库：库被 Chromium 独占锁着时，SQLite 会**阻塞重试 ~1.4 秒**
   *     实测 deepseek 那次探测固定 1426 ms —— 而且是**同步**的，
   *     把 host 的整个事件循环卡住（/status、/providers、listModels 都调它）
   *     ⇒ 用户报的「LDW 运行的时候 DSH 页面会瘫痪」
   *   · 复制：被锁时**几毫秒就抛 EBUSY**，快到可以忽略
   *
   * 所以顺序反过来：**先复制**。复制成功 ⇒ 读副本（副本可自由读写，兼容性最好）；
   * 复制失败 ⇒ 直接返回「读不了」，让调用方回退到快照判据。
   * **绝不去碰那个可能被锁着的原库** —— 热路径上就不再有慢操作了。
   */
  return readViaCopy(profileDir, file);
}

/**
 * 打开并读一张 cookie 表。失败返回 null（**不抛错**）。
 *
 * @param {string} file - Cookies 库路径
 * @param {boolean} readOnly - true 用于原始库（绝不写用户数据）；
 *                             false 用于临时副本（副本随便写，换最高兼容性）
 */
function tryReadDb(file, readOnly) {
  let db = null;
  try {
    const { DatabaseSync } = require("node:sqlite");
    /**
     * ⚠️⚠️ **必须给一个极短的 busy timeout**（2026-10-16 实测踩到）。
     *
     * SQLite 默认会在「库被别的进程锁着」时**阻塞重试**（默认 ~1 秒级）。
     * 而 Chromium 恰恰会一直独占锁着 cookie 库 ⇒ 每次打开都白等一秒多。
     *
     * 实测：deepseek 那次探测花了 **1426 ms** —— 而且这是**同步**的，
     * 会把 host 的事件循环整个卡住。`isPlatformLoggedIn()` 又被
     * `/status`、`/providers`、`listModels` 高频调用 ⇒
     * 四个平台一轮下来就是好几秒的冻结。
     * 用户报的「LDW 运行的时候 DSH 页面会瘫痪」很可能就是这个。
     *
     * 给 100ms 上限：拿不到就当作「读不了」，立刻返回 null
     * （调用方会回退到快照判据，功能不受影响）。
     */
    db = new DatabaseSync(file, { readOnly, timeout: 100 });
    const rows = db
      .prepare("SELECT host_key AS host, name, length(encrypted_value) AS elen FROM cookies")
      .all();
    return rows.map((r) => ({ host: String(r.host ?? ""), name: String(r.name ?? ""), elen: Number(r.elen ?? 0) }));
  } catch {
    return null;
  } finally {
    /**
     * ⚠️ **必须关**：忘了关有两个后果 ——
     *   1. Windows 上文件被占住，删临时目录报 `EPERM`（实测踩过）
     *   2. 句柄泄漏，反复调用会累积
     */
    try { db?.close(); } catch { /* 关不掉也不影响本次结果 */ }
  }
}

/** 缓存目录：放 cookie 库的临时副本（固定在 DSH 数据目录下，体积极小、可重复覆盖）。 */
function cookieCacheDir(profileDir) {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  const tag = createHash("sha1").update(profileDir).digest("hex").slice(0, 12);
  return join(home, "webin", "cache", "cookies", tag);
}

/**
 * 复制 cookie 库（含 `-wal` / `-shm`）到缓存目录后读取。
 *
 * ⚠️ `-wal` 里可能有**尚未落盘的最新数据**（cookie 轮换往往就发生在那里），
 * 所以三个文件必须一起复制 —— 只复制主库会读到过期快照。
 *
 * ## ⚠️ 遇到 `EBUSY` 时**不许等**（2026-10-16 自我纠正）
 *
 * 上一版这里写了「间隔 100ms 重试 3 次」，实现里用了
 * `Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)`。
 * 两个问题，第二个是**严重**的：
 *
 *   1. **没用**：Edge/Chromium 对 cookie 库是**独占锁**，在它整个生命周期里
 *      都不释放（不是「写完就放」）—— 重试再多次也拿不到。
 *   2. **危险**：`Atomics.wait` 是**同步阻塞**，会把 host 的整个事件循环卡住。
 *      而 `isPlatformLoggedIn()` 会被 `/status`、`/providers`、
 *      `listModels`（模型选择器每次渲染都调）**高频调用** ——
 *      一次几百毫秒的阻塞乘以四个平台，DSH 页面就整个卡死了。
 *      用户报的「LDW 运行的时候 DSH 页面会瘫痪，任何实质性动作都做不出来」，
 *      很可能就是这个（Edge 一开 ⇒ EBUSY ⇒ 每个探针调用都阻塞）。
 *
 * 所以现在：**只尝试一次**，拿不到就立刻返回 null（按「读不了」处理），
 * 让调用方回退到快照判据 —— 既有快照、又不阻塞。
 * 绝不因为读不到 cookie 就假装「未登录」。
 */
function readViaCopy(profileDir, file) {
  const dir = cookieCacheDir(profileDir);
  try {
    mkdirSync(dir, { recursive: true });
    for (const ext of ["", "-wal", "-shm"]) {
      const src = file + ext;
      if (existsSync(src)) copyFileSync(src, join(dir, "Cookies" + ext));
    }
    /** 副本用**读写**打开：能自由重建 -shm，兼容性最好（副本写坏无所谓）。 */
    return tryReadDb(join(dir, "Cookies"), false);
  } catch {
    /** EBUSY / EPERM：Edge 占着库。**不重试、不等待** —— 见上方注释。 */
    return null;
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
  return computeIsLoggedIn(platformId, profileDir);
}

/**
 * ## 结果缓存：把「高频调用」与「每次都要读磁盘」解耦
 *
 * 为什么必须有（2026-10-16 实测）：`isPlatformLoggedIn()` 会被
 * `/status`、`/providers`、**以及 `listModels`（模型选择器每次渲染都调）**
 * 高频调用，而每次算它都要：
 *   ① 试着直接打开 cookie 库 → 被 Edge 锁着时这一下就要 **~1.4 秒**
 *   ② 失败后再复制三个文件重试
 *
 * 整个探测是**同步**的 ⇒ 每一轮把 host 的事件循环卡住一秒多。
 * 四个平台 × 多次调用 = 好几秒的冻结，DSH 页面自然「什么实质性动作都做不出来」。
 *
 * 缓存之后：同一「平台 + profile 目录」**5 秒内只真探一次**，
 * 其余调用是 Map 命中（微秒级）。登录态本身也不可能在 5 秒内反复变化，
 * 所以这个 TTL 对正确性没有影响 —— 只是把代价从「每次」摊成「每 5 秒一次」。
 *
 * ⚠️ 缓存键必须带 **profileDir**：多账号下一个平台有多个 profile，
 * 只按 platformId 缓存会让不同账号互相串。
 * ⚠️ 键会随槽位增多而变多，所以设了上限 + 整体清空（比 LRU 简单且够用）。
 */
const PROBE_CACHE_TTL_MS = 5000;
const PROBE_CACHE_MAX = 64;
const probeCache = new Map();

function computeIsLoggedIn(platformId, profileDir) {
  const key = `${platformId}|${profileDir}`;
  const now = Date.now();
  const hit = probeCache.get(key);
  if (hit !== undefined && now - hit.at < PROBE_CACHE_TTL_MS) return hit.result;
  const result = probeUncached(platformId, profileDir);
  if (probeCache.size >= PROBE_CACHE_MAX) probeCache.clear();
  probeCache.set(key, { at: now, result });
  return result;
}

/** 真正的探测（无缓存）。 */
function probeUncached(platformId, profileDir) {
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
