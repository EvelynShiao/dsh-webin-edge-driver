/**
 * 网页版会话**惰性回收**（session GC）
 * ==================================
 *
 * ## 用户的问题（2026-10-16）
 *
 * 「你那个会话用完了马上删不好，容易被看出来是机器人，建议做个自定义的
 * 多少分钟后删除 / 多少机器人产生会话后删除。」
 *
 * 这个直觉是对的：一个账号每来一条消息就**精准地**多出一条对话、旋即消失，
 * 是很好认的机器特征。真实用户会留着一堆对话不删。
 *
 * ## 设计要点
 *
 * ① **只碰机器人自己建的会话**（最重要）。
 *    绝不做「删最近的 N 条」那种策略 —— 那会误删用户自己的对话。
 *    做法：用一份**账本**记下「哪些会话是我们这轮新建的」，
 *    之后所有删除都只在这个账本范围内进行。
 *
 * ② **惰性 GC，不新开定时器**。
 *    用户对常驻后台进程敏感。而**删除必须借浏览器**（会话列表/删除都是
 *    页面里的 fetch），所以最早也要等页面开着时才能删。
 *    那就干脆**搭车**：复用每次任务结束时页面已经打开、且已经登录的时刻
 *    顺手清算到期的 —— 既不新开浏览器，也不新开定时器。
 *
 * ③ **账本持久化**，跨重启存活：`~/.dsh/webin/pending-session-deletes.json`。
 *    否则「N 分钟后删」在重启后就成了永远不删（内存里的定时器没了）。
 *
 * ## 四种模式
 *
 *   - `never`     ：不清（完全不动网页版）
 *   - `immediate` ：老行为，本轮结束就删（最容易被看出是机器人）
 *   - `delay`     ：记进账本，**N 分钟后**到期才删（默认 30 分钟）
 *   - `count`     ：记进账本，账本里**攒够 M 个**就把最老的删掉（默认 20）
 *
 * 未显式配置时，沿用旧的布尔开关 `autoDeleteSessions`（true ⇒ immediate，
 * false ⇒ never），保证老配置行为不变。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

/** 账本路径。 */
export function pendingPath() {
  const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
  return join(home, "webin", "pending-session-deletes.json");
}

/** 合法的模式。 */
export const SESSION_DELETE_MODES = ["never", "immediate", "delay", "count"];

/**
 * 解析出**实际生效**的模式。
 *
 * 优先 `sessionDeleteMode`；没配就回落到旧的布尔 `autoDeleteSessions`
 * （这是为了让用户已有的 config.json 行为**完全不变**，不搞突然袭击）。
 *
 * @returns {"never"|"immediate"|"delay"|"count"}
 */
export function resolveMode(config) {
  const m = config?.sessionDeleteMode;
  if (typeof m === "string" && SESSION_DELETE_MODES.includes(m)) return m;
  return config?.autoDeleteSessions === true ? "immediate" : "never";
}

/** 延迟模式的间隔（毫秒），下限 1 分钟（再短就没意义了，等于 immediate）。 */
export function resolveDelayMs(config) {
  const min = Number(config?.sessionDeleteDelayMinutes);
  const safe = Number.isFinite(min) && min > 0 ? min : 30;
  return Math.max(60_000, safe * 60_000);
}

/** 计数模式的上限，下限 1。 */
export function resolveMax(config) {
  const n = Number(config?.sessionDeleteMaxSessions);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 20;
}

/** 读账本（坏文件退化成空，绝不抛错）。 */
export function loadPending() {
  const p = pendingPath();
  const empty = { version: 1, entries: {} };
  if (!existsSync(p)) return empty;
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8"));
    if (parsed === null || typeof parsed !== "object") return empty;
    if (parsed.entries === null || typeof parsed.entries !== "object") parsed.entries = {};
    return parsed;
  } catch {
    return empty;
  }
}

/** 原子写账本（先 .tmp 再 rename —— 手机端可能正在同步这个目录）。 */
export function savePending(state) {
  const p = pendingPath();
  try {
    mkdirSync(dirname(p), { recursive: true });
    const tmp = `${p}.tmp`;
    writeFileSync(tmp, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    renameSync(tmp, p);
    return p;
  } catch {
    /** 存不下不影响本轮（只是下次多删一轮），**不抛错**。 */
    return "";
  }
}

/** 账本里的键：按「平台#槽位」隔离，避免 A 账号的账本删到 B 账号的会话。 */
export function ledgerKey(platformId, accountId = "default") {
  return `${platformId}#${accountId}`;
}

/**
 * 把**本轮新建**的会话记进账本。
 *
 * @param {object} state - loadPending() 的结果（会被就地修改）
 * @param {string} key - ledgerKey()
 * @param {Array<{id:string,title?:string}>} sessions - 本轮新建的（已排除置顶）
 * @param {number} now - 当前时间戳
 * @param {number} delayMs - delay 模式下的存活期
 * @returns {number} 新增条数
 */
export function recordNew(state, key, sessions, now, delayMs) {
  if (!Array.isArray(sessions) || sessions.length === 0) return 0;
  state.entries ??= {};
  state.entries[key] ??= [];
  const list = state.entries[key];
  const known = new Set(list.map((e) => e.id));
  let added = 0;
  for (const s of sessions) {
    if (typeof s?.id !== "string" || s.id === "") continue;
    if (known.has(s.id)) continue;
    list.push({
      id: s.id,
      title: typeof s.title === "string" ? s.title.slice(0, 80) : "",
      createdAt: now,
      deleteAfter: now + delayMs,
    });
    added++;
  }
  return added;
}

/**
 * 挑出**该删**的那批（纯逻辑，便于单测）。
 *
 *   - `delay`：`deleteAfter <= now` 的（到期）
 *   - `count`：账本超过 M 个时，**最老的**那几个（删到只剩 M）
 *
 * @returns {Array<{id:string,title:string}>} 要删的条目
 */
export function pickDue(state, key, { mode, now, max }) {
  const list = state.entries?.[key];
  if (!Array.isArray(list) || list.length === 0) return [];
  if (mode === "delay") {
    return list.filter((e) => typeof e.deleteAfter === "number" && e.deleteAfter <= now);
  }
  if (mode === "count") {
    if (list.length <= max) return [];
    /** 账本按加入顺序追加，所以前 (len - max) 个就是最老的。 */
    return list.slice(0, list.length - max);
  }
  return [];
}

/** 从账本里移除已删条目。 */
export function removeEntries(state, key, ids) {
  const list = state.entries?.[key];
  if (!Array.isArray(list) || ids.length === 0) return 0;
  const gone = new Set(ids);
  const before = list.length;
  state.entries[key] = list.filter((e) => !gone.has(e.id));
  if (state.entries[key].length === 0) delete state.entries[key];
  return before - (state.entries[key]?.length ?? 0);
}

/** 账本里某个平台#槽位还有多少待处理。 */
export function pendingCount(state, key) {
  return Array.isArray(state.entries?.[key]) ? state.entries[key].length : 0;
}

/** 给人看的策略描述（放 /status 和日志里）。 */
export function describePolicy(config) {
  const mode = resolveMode(config);
  if (mode === "immediate") return { mode, text: "本轮结束立刻删（最像机器人，不推荐）" };
  if (mode === "never") return { mode, text: "不删（最保守）" };
  if (mode === "delay") {
    const min = Math.round(resolveDelayMs(config) / 60_000);
    return { mode, text: `机器人建的会话 ${min} 分钟后才删` };
  }
  return { mode, text: `机器人建的会话攒到 ${resolveMax(config)} 个后，删最老的` };
}

/**
 * ## LDW 前缀识别（2026-10-18 第三批，用户点名）
 *
 * 「删除旧对话就可以靠识别带 LDW 的标签实现了！这样更好。
 *   如果我已经先删了那么本地副本也不要留。」
 *
 * 网页对话在**发送后被重命名**成 `LDW xxx`（见驱动器 renameSession）。
 * 于是「哪些是机器人的」不再只靠差集账本——**标题就是标记**：
 *
 *   - 历史上攒下的一堆机器对话（账本没记过的）也能被清掉；
 *   - 用户在网页端手动删掉的，本地账本成了**孤儿**——按前缀清账时
 *     （listSessions 拉不到它）一并从账本里抹掉，本地副本不留。
 */
export const LDW_TITLE_RE = /^LDW\b|^\s*LDW[\s:：-]/i;

/** 标题像不像机器人对话（按 LDW 前缀判）。 */
export function looksLikeLdwTitle(title) {
  const t = String(title ?? "").trim();
  if (t === "") return false;
  return LDW_TITLE_RE.test(t);
}

/**
 * 从会话列表挑出「按前缀该删」的（不置顶）。
 * @param {Array<{id:string,title?:string,pinned?:boolean}>} sessions
 */
export function pickByLdwTitle(sessions) {
  if (!Array.isArray(sessions)) return [];
  return sessions.filter((s) => s?.pinned !== true && looksLikeLdwTitle(s?.title));
}
