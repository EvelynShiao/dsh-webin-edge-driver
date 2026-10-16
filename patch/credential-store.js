/**
 * 统一凭据存储（Token / Cookie）
 * ==============================
 *
 * ## 为什么要有这个
 *
 * 用户要的是：**一个文件，手机和电脑都能用**，管理各平台的 Token/Cookie，
 * 而且**能看出它是不是快过期/已经过期**（原来散在各处没法判断）。
 *
 * 参考实现是桌面那个 `chat.deepseek.com令牌.py`，它做得对的地方照抄：
 *   - 只存 **sha 指纹** 判「变没变」，不明文留历史（`sha()` 那几行）
 *   - 记录 `changed_count` / `last_change_at` —— 这正好回答「这站轮换快不快」
 *
 * ## 文件位置（可覆盖，方便手机/电脑共用一个文件）
 *
 *   默认：`~/.dsh/webin/credentials.json`
 *   可用环境变量 `DSH_WEBIN_CREDENTIALS` 指到任意路径
 *   —— 想「手机电脑统一用一个文件」就把这个变量指到同步目录/网盘里。
 *
 * ## 为什么是**明文**存 token/cookie（这点必须说清）
 *
 * 因为它本质上就是**登录凭证**，要和浏览器里的等价值互换（注入用）。
 * 哈希后没法注入，加密就得管密钥（又多个要同步的东西，反而更脆）。
 * 所以选择：**明文存 + 文件权限收紧 + 绝不进日志 + 绝不进版本库**。
 * 用户本来也是把它当 `.txt` 到处放的，这里至少比裸 txt 多了一层结构。
 *
 * ## 过期判断：**不能解 token**
 *
 * 实测 DeepSeek 的 `userToken` 是 56 字符的**不透明随机串**
 * （`{"value":"Y8r91x0N...","__version":"0"}`），**不是 JWT**，没有 `exp`
 * 可解。所以「还能用吗」只有两条真判据：
 *
 *   1. **让浏览器说**：注入后打开页面跑登录探针（`authProbe`）—— 最准
 *   2. **看轮换频率**：本模块记的 `changedCount` —— 回答「容易不容易过期」
 *
 * 本模块负责第 2 条 + 存取的搬运；第 1 条由插件侧注入流程完成。
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

const STORE_VERSION = 1;

/** 凭据文件路径。`DSH_WEBIN_CREDENTIALS` 可覆盖（手机/电脑共用一个文件的钩子）。 */
export function storePath() {
  const override = process.env.DSH_WEBIN_CREDENTIALS;
  if (typeof override === "string" && override.trim() !== "") return override.trim();
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "webin", "credentials.json");
}

/** 指纹：只存前 16 位，够判「变没变」又不泄露内容。 */
export function fingerprint(s) {
  const v = typeof s === "string" ? s : "";
  if (v === "") return "";
  return createHash("sha256").update(v, "utf8").digest("hex").slice(0, 16);
}

/**
 * 读凭据文件。**任何异常都退化成空结构**，绝不抛错 ——
 * 凭据文件坏了不能让插件加载失败（那是「配置坏了」升级成「插件坏了」）。
 */
export function loadCredentials() {
  const p = storePath();
  const empty = { version: STORE_VERSION, accounts: {} };
  if (!existsSync(p)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (parsed === null || typeof parsed !== "object") return empty;
    if (parsed.accounts === null || typeof parsed.accounts !== "object") parsed.accounts = {};
    parsed.version ??= STORE_VERSION;
    return parsed;
  } catch {
    return empty;
  }
}

/**
 * 原子写：先写 `.tmp` 再 `rename`。
 *
 * 为什么不用 writeFileSync 直接盖：手机端可能正在同步这个文件
 * （网盘/同步盘），中途半截文件被读到就全废了。rename 是原子的。
 */
export function saveCredentials(store) {
  const p = storePath();
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, "utf8");
  renameSync(tmp, p);
  /**
   * 收紧权限：这是登录凭证，不该给同机其他用户读。
   * Windows 上 chmod 基本无效（NTFS 走 ACL），失败**静默忽略**——
   * 不能因为改不了权限就存不下。
   */
  try {
    chmodSync(p, 0o600);
  } catch { /* Windows/受限环境正常现象 */ }
  return p;
}

/** 取一个账号的凭据（不存在返回 null）。 */
export function getCredential(platform, slot = "default", store = loadCredentials()) {
  const entry = store.accounts?.[platform]?.[slot];
  return entry === undefined ? null : entry;
}

/**
 * 写入/更新一个账号的凭据。
 *
 * 只在**内容真的变了**时才计入 `changedCount`（照抄 py 的意图：那个计数
 * 是用来回答「这个站的 cookie 轮换快不快」，重复写同样的值不该算变更）。
 */
export function setCredential(platform, slot, { token, cookie } = {}, store = loadCredentials()) {
  const now = Date.now();
  store.accounts ??= {};
  store.accounts[platform] ??= {};
  const prev = store.accounts[platform][slot];

  const nextToken = typeof token === "string" ? token : (prev?.token ?? "");
  const nextCookie = typeof cookie === "string" ? cookie : (prev?.cookie ?? "");
  const tokenSha = fingerprint(nextToken);
  const cookieSha = fingerprint(nextCookie);

  const changed =
    prev === undefined ? true : prev.tokenSha !== tokenSha || prev.cookieSha !== cookieSha;

  store.accounts[platform][slot] = {
    token: nextToken,
    cookie: nextCookie,
    tokenSha,
    cookieSha,
    tokenLen: nextToken.length,
    cookieLen: nextCookie.length,
    updatedAt: now,
    /** 轮换历史：回答「这个站容易不容易过期」。 */
    changedCount: (prev?.changedCount ?? 0) + (changed ? 1 : 0),
    lastChangeAt: changed ? now : (prev?.lastChangeAt ?? now),
    /** 上次「注入后用页面探针验证」的结果（由插件侧注入流程回填）。 */
    lastVerify: prev?.lastVerify ?? null,
  };
  return store.accounts[platform][slot];
}

/** 删除一个账号的凭据（返回是否真删了）。 */
export function deleteCredential(platform, slot = "default", store = loadCredentials()) {
  const p = store.accounts?.[platform];
  if (p === undefined || p[slot] === undefined) return false;
  delete p[slot];
  if (Object.keys(p).length === 0) delete store.accounts[platform];
  return true;
}

/**
 * 列出所有凭据，**脱敏**（给 API/设置页看，不含明文秘密）。
 *
 * 也顺手给出「轮换频率」的人话描述 —— 这正是用户想知道的
 * 「这个 Token 是不是很容易过期」。
 */
export function listCredentials(store = loadCredentials()) {
  const out = [];
  for (const [platform, slots] of Object.entries(store.accounts ?? {})) {
    for (const [slot, entry] of Object.entries(slots ?? {})) {
      out.push({
        platform,
        slot,
        hasToken: (entry.tokenLen ?? 0) > 0,
        hasCookie: (entry.cookieLen ?? 0) > 0,
        tokenLen: entry.tokenLen ?? 0,
        cookieLen: entry.cookieLen ?? 0,
        updatedAt: entry.updatedAt ?? null,
        changedCount: entry.changedCount ?? 0,
        lastChangeAt: entry.lastChangeAt ?? null,
        lastVerify: entry.lastVerify ?? null,
        rotation: describeRotation(entry),
      });
    }
  }
  return out;
}

/**
 * 用人话描述「这个凭据多久轮换一次」。
 *
 * 这是对「token 是不是很容易过期」的**唯一诚实回答**：
 * 我们解不出 token 里的过期时间（它不是 JWT），但能看到它**实际多久变一次**。
 * 变得越勤 = 这个站的会话越短 = 越容易失效。
 */
export function describeRotation(entry) {
  const count = entry?.changedCount ?? 0;
  const first = entry?.updatedAt ?? null;
  const last = entry?.lastChangeAt ?? null;
  if (count <= 1 || first === null || last === null) {
    return { level: "unknown", text: "样本不足（至少记录到 2 次变更才能估频率）" };
  }
  const spanDays = Math.max((last - first) / 86400000, 1 / 24);
  const perDay = (count - 1) / spanDays;
  if (perDay >= 2) return { level: "fast", text: `轮换很勤（约每天 ${perDay.toFixed(1)} 次）—— 容易失效，建议常刷新` };
  if (perDay >= 0.2) return { level: "normal", text: `轮换正常（约每 ${(1 / perDay).toFixed(1)} 天一次）` };
  return { level: "stable", text: `很稳定（约每 ${(1 / perDay).toFixed(0)} 天一次）—— 不用担心过期` };
}

/**
 * 把 Cookie 头字符串解析成 CDP `Network.setCookie` 要的数组。
 *
 * 输入形如：`a=1; b=2; .thumbcache_xxx=zzz`
 *
 * ⚠️ 只做「名字=值」的朴素切分：`; ` 是分隔符，值里可能有 `=`（所以只按
 * **第一个** `=` 切）。JS 里那些 `%3D%3D` 已经是 URL 编码，不用再动。
 */
export function parseCookieHeader(header, defaultDomain) {
  const out = [];
  for (const part of String(header ?? "").split(";")) {
    const seg = part.trim();
    if (seg === "") continue;
    const i = seg.indexOf("=");
    if (i <= 0) continue;
    const name = seg.slice(0, i).trim();
    const value = seg.slice(i + 1).trim();
    if (name === "") continue;
    out.push({ name, value, domain: defaultDomain });
  }
  return out;
}
