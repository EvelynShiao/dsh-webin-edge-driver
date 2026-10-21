/**
 * dsh-webin 的「真 Edge」驱动器（edge-driver）
 * ============================================
 *
 * ## 这是什么
 *
 * webin 原版把「真浏览器」这一手交给 DSH **桌面版（Electron）** 的 webview guest ——
 * 而这个环境是 **web 档案（纯 Node）**，没有 `globalThis.dshDesktop`，
 * 于是 client 半在 `desktopBrowser()` 直接 return，面板永远不挂载 ⇒ LDW 登不上。
 *
 * 本文件在 **host 半** 里补一只「手」：用 CDP 驱动**本机真 Edge** 去干
 * webin 原本让 webview 干的活 —— 领活、填字、点发送、读回复、交结果。
 *
 * ## 为什么这不破坏 webin 的优势（用户明确要求）
 *
 * | webin 的优势 | 本驱动 |
 * |---|---|
 * | 真浏览器、真打字、真点发送 | ✅ 真 Edge，**脚本逐字复用 client.js 的原生脚本** |
 * | 不伪造 header、不自己拼请求 | ✅ 一样。请求是页面自己发的 |
 * | 从 hook 读流式回复 | ✅ 注入的还是 webin 原生 `buildDeepSeekHook` |
 * | 差分发送 / 工具调用 / 会话绑定 | ✅ 全在 host 半，本文件一行不碰 |
 * | 2~4 秒随机间隔、串行 | ✅ 照抄 `sendDelayMinMs`/`MaxMs` 配置 |
 *
 * **换掉的只有「脚本在哪个 Chromium 里跑」**，脚本本身来自
 * `edge-driver-scripts.js`（逐字提取自 dsh-webin v0.2.23 lib/client.js，未改写）。
 *
 * ## 按需启动 / 用完即退（用户对常驻进程敏感）
 *
 * - 平时**不跑**：没有 Edge、没有后台服务
 * - 有任务要跑时：`ensureEdge()` 起一个**独立 profile** 的 Edge（`.dsh/edge-ldw`）
 * - `idleShutdownMs` 内没有任务：自动关掉那只 Edge（释放内存）
 * - 登录态写在独立 profile 目录里 ⇒ 跨重启存活
 *
 * ## 安全边界
 *
 * - 只用**独立 profile 目录**（`--user-data-dir=<DSH_HOME>/edge-ldw`），
 *   **绝不碰用户日常 Edge 的 profile**
 * - 只在 `--remote-debugging-port` 的本地端口上通信（默认 127.0.0.1:9411）
 * - 关闭时优先走 CDP `Browser.close`（让 Edge 正常写盘，登录态不丢）
 */

import { spawn } from "node:child_process";
import { readFile as _fspReadFile, writeFile as _fspWriteFile } from "node:fs/promises";
const fsp = { readFile: _fspReadFile, writeFile: _fspWriteFile };
import { chunkFileBytes, partFileName, DEFAULT_TXT_CHUNK_BYTES } from "./txt-chunk.js";
import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import {
  DRIVER_SOURCE,
  buildProbeScript,
  buildSnapshotScript,
  buildDrainScript,
  buildScrollScript,
  buildScrapeScript,
  buildFillScript,
  buildTriggerScript,
  buildClearInputScript,
  buildThinkingScript,
  buildStopScript,
  buildContinueScript,
  buildChromeUserAgent,
  buildDeepSeekHook,
} from "./edge-driver-scripts.js";
import {
  describePolicy,
  ledgerKey,
  loadPending,
  pendingCount,
  pendingPath,
  pickByLdwTitle,
  pickDue,
  recordNew,
  removeEntries,
  resolveDelayMs,
  resolveMax,
  resolveMode,
  savePending,
} from "./session-gc.js";
import { safePathSegment } from "./slot-names.js";

// ─────────────────────────────────────────────────────────────
// 默认配置
// ─────────────────────────────────────────────────────────────

export const EDGE_DRIVER_DEFAULTS = {
  /** 开不开。false = 完全不动（回到 webin 原版行为）。 */
  enabled: true,
  /** 调试端口（只监听本机）。 */
  port: 9411,
  /** Edge 可执行文件；留空 = 自动探测。 */
  executable: "",
  /** 独立 profile 目录；留空 = <DSH_HOME>/edge-ldw。 */
  userDataDir: "",
  /** .txt 分段上传阈值（2026-10-19）：>400KB 切片逐段传；0 = 不分段。 */
  txtChunkBytes: 409600,
  /**
   * 把工作窗口藏到屏幕外。
   *
   * ## 为什么用「屏幕外」而不是 `--headless`
   *
   * `--headless` 是**最典型的机器人特征**（`navigator.webdriver`、UA 里的
   * `HeadlessChrome`、缺失的 GPU 信息），一开就等于自毁 webin 的反封优势。
   *
   * 而「把窗口移到屏幕外」：
   *   - 页面仍处于 **visible** 状态（`document.visibilityState === 'visible'`）
   *     —— 和真实用户把窗口拖到第二屏、或放在另一个虚拟桌面上一样
   *   - GPU / WebGL / UA / 字体全部不变 ⇒ **指纹零变化**
   *   - 你看不到它，但它是个货真价实的可见窗口
   *
   * ⚠️ 必须同时关掉后台节流（见启动参数），否则屏幕外的窗口会被 Chromium
   * 降频，定时器变慢、渲染停滞，页面会「假死」。
   */
  hideWindow: true,
  /**
   * ## 自动清理网页版里的废对话 ⭐（用户点名要的）
   *
   * 每开一个新 DSH 会话，网页版就多一条对话。用久了账号里全是垃圾：
   * 「测试正常」「链路通畅」这种一句话对话能堆几十条。
   *
   * 打开后：**任务跑完就删掉本轮新建的那条网页对话**。
   *
   * ## 安全边界（重要）
   *
   *   - 只删**本轮新建**的（对比任务开始前后的会话列表，取差集）
   *   - **绝不**碰任务开始前就存在的对话（你的历史一条不动）
   *   - **绝不**碰置顶（pinned）的对话
   *   - 删除接口来自实测：`POST /api/v0/chat_session/delete`
   *     body `{chat_session_id}`，返回 `{code:0,biz_code:0}`
   *
   * ## 什么时候不该开
   *
   * 如果你**想留着**网页版里的对话记录回头翻（比如喜欢在网页版看历史），
   * 就把它关掉。默认**开**，因为默认观点是「DSH 里的对话记录才是正本」。
   */
  /** 默认关闭自动删会话；仅在 provider 明确声明安全的删除器后才可开启。 */
  autoDeleteSessions: false,
  /**
   * ## 会话回收策略（2026-10-16，用户点名要的）
   *
   * 用户原话：「会话用完了马上删不好，容易被看出来是机器人，建议做个自定义的
   * 多少分钟后删除 / 多少机器人产生会话后删除。」
   *
   * 这个直觉是对的：来一条消息就**精准地**多一条对话、旋即消失，是很好认的
   * 机器特征。真实用户会留着一堆对话不删。
   *
   * | 值 | 行为 |
   * |---|---|
   * | `never` | 不删（最保守） |
   * | `immediate` | 老行为，本轮结束立刻删（最像机器人） |
   * | `delay` | 记进账本，`sessionDeleteDelayMinutes` 分钟后才删 |
   * | `count` | 记进账本，攒到 `sessionDeleteMaxSessions` 个后删最老的 |
   *
   * 留空 ⇒ **回落到旧的布尔 `autoDeleteSessions`**，保证已有 config.json
   * 行为完全不变（不搞突然袭击）。
   *
   * ⚠️ 所有模式都**只碰机器人自己建的会话**（账本里记着的那些），
   * 绝不碰用户的历史与置顶 —— 见 `session-gc.js` 的设计说明。
   */
  sessionDeleteMode: "",
  /** `delay` 模式的存活期（分钟）。下限 1 分钟。 */
  sessionDeleteDelayMinutes: 30,
  /** `count` 模式的上限（账本里最多留几个）。 */
  sessionDeleteMaxSessions: 20,
  /**
   * 刚建的对话可能还没被服务端收录（列表要过一会才出现），
   * 所以删除前先等一小会儿再查。
   */
  sessionDeleteSettleMs: 4000,
  /** 空闲多久自动关掉 Edge（毫秒）。0 = 不自动关。 */
  idleShutdownMs: 300000,
  /** 起 Edge 后等 CDP 端口可用的上限（毫秒）。 */
  launchTimeoutMs: 30000,
  /** 领活轮询间隔（毫秒）。 */
  pollIntervalMs: 1500,
  /** 首次领活宽限（毫秒）—— 与 webin 的 claimGraceMs 语义一致。 */
  claimGraceMs: 20000,
  /** 每个任务等回复的上限（毫秒）。 */
  replyTimeoutMs: 600000,
  /** 发送前随机延迟区间（毫秒）—— 照抄 webin 的真人节奏策略。 */
  sendDelayMinMs: 2000,
  sendDelayMaxMs: 4000,
  /** 详细日志。 */
  verboseLog: false,
};

/**
 * ## 浏览器候选路径（**跨平台**，2026-10-16 扩展）
 *
 * 原版只找 Windows 的 msedge.exe —— 手机上必然落空，表现为「起不来浏览器」。
 * 用户实测：**手机上用 npm 装过 Chrome 内核**（puppeteer 那类），所以手机上
 * 是有可能跑起来的 —— 前提是能找到那个二进制。
 *
 * ⚠️ 代码里除了「去哪儿找它」，其它全是平台无关的：
 *    只要这个二进制能带 \`--remote-debugging-port\` 起来，CDP 驱动就照常干活。
 */
const EDGE_CANDIDATES = [
  /** Windows：Edge（首选，指纹最自然） */
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  /** Windows：Chrome */
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  /** macOS */
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  /** Linux */
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/usr/local/bin/chrome",
  "/snap/bin/chromium",
  /** Android / Termux（手机上最常见的就是这个布局） */
  "/data/data/com.termux/files/usr/bin/chromium",
  "/data/data/com.termux/files/usr/bin/chromium-browser",
  "/system/bin/chrome",
];
/**
 * 环境变量里显式给的浏览器路径 —— **手机上最省事的做法**：
 * 在 DSH 终端里 export 一下，或写进插件的 executable 配置。
 */
const BROWSER_ENV_KEYS = [
  "DSH_WEBIN_BROWSER",
  "PUPPETEER_EXECUTABLE_PATH",
  "CHROME_PATH",
  "CHROMIUM_PATH",
  "EDGE_PATH",
];

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

/**
 * 在 puppeteer 的缓存目录里递归找浏览器二进制。
 *
 * 用户就是在手机上**用 npm 装**的 Chrome —— puppeteer 会把解压好的二进制放在
 * 缓存目录下（形如 \`~/.cache/puppeteer/chrome/linux-<版本>/chrome-linux64/chrome\`）。
 * 名字不固定（chrome / chrome-headless-shell / chromium），所以按**文件名+可执行位**找，
 * 而不是硬编码某一条完整路径。
 *
 * 限深 5 层、限制访问次数，避免在手机上扫太久。
 */
function findInPuppeteerCache() {
  const home = homedir();
  const roots = [
    join(home, ".cache", "puppeteer"),
    join(home, "Library", "Caches", "puppeteer"),
    join(process.env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "puppeteer"),
    join(home, ".cache", "ms-playwright"),
  ];
  const names = ["chrome", "chrome-headless-shell", "chromium", "msedge", "Microsoft Edge"];
  let budget = 400;
  const walk = (dir, depth) => {
    if (depth > 5 || budget <= 0) return "";
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return ""; }
    /** 先看文件（命中即返回），再看子目录 —— 命中的通常在同一层附近。 */
    for (const e of entries) {
      budget--;
      if (budget <= 0) return "";
      if (e.isFile() && names.includes(e.name)) {
        const full = join(dir, e.name);
        if (existsSync(full)) return full;
      }
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const hit = walk(join(dir, e.name), depth + 1);
      if (hit !== "") return hit;
    }
    return "";
  };
  for (const r of roots) {
    if (!existsSync(r)) continue;
    const hit = walk(r, 0);
    if (hit !== "") return hit;
  }
  return "";
}

function resolveEdgePath(configured) {
  /** ① 配置里显式填的（手机上可直接填 npm 装的那个路径）。 */
  if (typeof configured === "string" && configured.trim() !== "" && existsSync(configured)) return configured;
  /** ② 环境变量。 */
  for (const k of BROWSER_ENV_KEYS) {
    const v = process.env[k];
    if (typeof v === "string" && v.trim() !== "" && existsSync(v.trim())) return v.trim();
  }
  /** ③ 各平台常见路径。 */
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  /** ④ npm 装的（puppeteer 缓存）—— 手机上靠这条。 */
  const cached = findInPuppeteerCache();
  if (cached !== "") return cached;
  return "";
}

function resolveUserDataDir(configured) {
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  return join(dshHome(), "edge-ldw");
}

// ─────────────────────────────────────────────────────────────
// Android / proot 适配：Chrome 会「静默自杀」，得包一层启动器
// ─────────────────────────────────────────────────────────────

/**
 * DSH 的 Android 版把整个 Linux 环境跑在**自带的 proot** 里
 * （`PROOT_LOADER` → `libprootloader.so`）。这个 proot 有一个致命偏差：
 *
 *     它把 open("/proc/self/fd/N", O_RDONLY) **变成 dup()**
 *
 * 返回的 fd 与原 fd 共享同一个文件描述符 —— 权限、偏移都跟着原 fd 走。
 * 而 Chromium 建共享内存**正是靠这一手拿「只读句柄」**：
 *
 *     memfd_create("shared-memory-region")  = 75
 *     fcntl(75, F_ADD_SEALS, …)             = 0
 *     open("/proc/self/fd/75", O_RDONLY)    = 76   ← proot 偷偷 dup
 *     close(75); dup(76) = 75
 *     fcntl(75, F_GETFL) = O_RDWR           ← 本该是 O_RDONLY！
 *     --- SIGTRAP ---                       ← FD ownership 校验判违规 → 主动 brk 自杀
 *
 * 症状极难猜：**CDP 端口起来了（打印 DevTools listening）随即 SIGTRAP**，
 * 而且一句日志都不打（它其实 fprintf 了 "Crashing due to FD ownership
 * violation:"，但紧接着就 brk，stderr 缓冲没刷出去）。
 *
 * 解法见 `scripts/chrome-proot-launcher.py`：用 seccomp 让 `memfd_create`
 * 返回 ENOSYS，逼 Chromium 退回「/tmp 里的真实文件」那条路 —— proot 对
 * **真实路径**的处理是正确的。启动器还会顺手自拉 Xvfb，因为本驱动是
 * **故意用有头模式**的（--headless 是最典型的机器人特征），而手机上
 * DSH 的服务进程没有 DISPLAY。
 */
function isProotLinux() {
  if (process.platform !== "linux") return false;
  if (process.env.PROOT_LOADER || process.env.PROOT_TMP_DIR) return true;
  if (process.env.DSHA_ANDROID_RUNTIME === "1") return true;
  try {
    return /android/i.test(readFileSync("/proc/sys/kernel/osrelease", "utf8"));
  } catch {
    return false;
  }
}

/** 返回该用的启动器路径；不需要用（或用户关掉了）就返回 ""。 */
function resolveProotLauncher() {
  if (process.env.DSH_WEBIN_NO_PROOT_LAUNCHER === "1") return "";
  if (!isProotLinux()) return "";
  try {
    const p = fileURLToPath(new URL("../scripts/chrome-proot-launcher.py", import.meta.url));
    return existsSync(p) ? p : "";
  } catch {
    return "";
  }
}

/**
 * 找 python3 —— 启动器是 python 写的，**不依赖可执行位**
 * （插件从仓库装下来时 exec 位可能丢，所以用 `python3 <脚本>` 而不是直接执行它）。
 */
function resolvePython() {
  for (const c of [process.env.DSH_PYTHON, "/usr/bin/python3", "/usr/local/bin/python3"]) {
    if (typeof c === "string" && c.trim() !== "" && existsSync(c.trim())) return c.trim();
  }
  return "python3";
}

/**
 * 决定真正要 spawn 什么。
 *
 * - 平常（Windows 上的 Edge / 桌面 Linux 的 Chrome）：就是 exe 本身，**零改动**。
 * - Android/proot：`python3 <启动器>`，浏览器路径经 `DSH_CHROME_BIN` 传进去。
 */
function resolveLaunchCommand(exe) {
  const launcher = resolveProotLauncher();
  if (launcher === "") return { cmd: exe, prefixArgs: [], env: undefined, viaProotLauncher: false };
  return {
    cmd: resolvePython(),
    prefixArgs: [launcher],
    env: { ...process.env, DSH_CHROME_BIN: exe },
    viaProotLauncher: true,
  };
}

// ─────────────────────────────────────────────────────────────
// CDP 客户端（只用 node 原生 WebSocket，无依赖）
// ─────────────────────────────────────────────────────────────

class CdpConnection {
  constructor(ws) {
    this.ws = ws;
    this.seq = 0;
    this.pending = new Map();
    this.handlers = new Map();
    this.closed = false;
    ws.onmessage = (ev) => {
      let m;
      try { m = JSON.parse(ev.data); } catch { return; }
      if (m.id !== undefined && this.pending.has(m.id)) {
        const p = this.pending.get(m.id);
        this.pending.delete(m.id);
        if (m.error) p.reject(new Error(`CDP ${m.error.message ?? JSON.stringify(m.error)}`));
        else p.resolve(m.result);
        return;
      }
      if (m.method && this.handlers.has(m.method)) {
        for (const fn of this.handlers.get(m.method)) {
          try { fn(m.params); } catch { /* 订阅者异常不能影响连接 */ }
        }
      }
    };
    ws.onclose = () => { this.closed = true; };
    ws.onerror = () => { this.closed = true; };
  }

  static async connect(url, timeoutMs = 10000) {
    const ws = new WebSocket(url);
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error("CDP WebSocket 连接超时")), timeoutMs);
      ws.onopen = () => { clearTimeout(t); resolve(); };
      ws.onerror = () => { clearTimeout(t); reject(new Error("CDP WebSocket 连接失败")); };
    });
    return new CdpConnection(ws);
  }

  send(method, params = {}, timeoutMs = 30000) {
    if (this.closed) return Promise.reject(new Error("CDP 连接已关闭"));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`CDP ${method} 超时`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(t); resolve(v); },
        reject: (e) => { clearTimeout(t); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  on(method, fn) {
    if (!this.handlers.has(method)) this.handlers.set(method, new Set());
    this.handlers.get(method).add(fn);
  }

  off(method, fn) {
    this.handlers.get(method)?.delete(fn);
  }

  close() { try { this.ws.close(); } catch { /* ignore */ } }
}

// ─────────────────────────────────────────────────────────────
// 驱动器
// ─────────────────────────────────────────────────────────────

/**
 * 账号槽位解析（纯函数，真机事故后抽出来）
 *
 * 顺序：调用方明确给的 → 配置里该平台的 active → 上次用过的 → "default"。
 *
 * ⚠️ 为什么必须有前两级：用户把槽位改名成 evelyn-xxx 后，字面量 "default"
 * 指向的是**空档案**（改名后那个目录只剩子目录），浏览器起来停在 about:blank，
 * 消息发不出去。2026-10-17 真机就是这样翻车的。
 */
export function resolveAccountId({ explicit, configured, previous } = {}) {
  for (const value of [explicit, configured, previous]) {
    if (typeof value === "string" && value !== "") return value;
  }
  return "default";
}

export class EdgeDriver {
  /**
   * @param {object} opts
   * @param {object} opts.config    - 已归一化的配置（含 claimGraceMs / replyTimeoutMs / sendDelay*）
   * @param {object} opts.log       - { info?, warn?, debug?, error? }
   * @param {(platformId:string)=>object|undefined} opts.getProvider - 取平台定义（拿 homeUrl / completionPath / stopPath）
   */
  constructor(opts = {}) {
    this.config = { ...EDGE_DRIVER_DEFAULTS, ...(opts.config ?? {}) };
    this.log = opts.log ?? {};
    this.getProvider = opts.getProvider ?? (() => undefined);
    /**
     * 取「该平台当前生效的账号槽位」。
     *
     * ⚠️ 没有这个回调时，任何不带账号的 `ensureEdge()` 都会退回字面量 "default"。
     * 用户把槽位改名成 evelyn-xxx 之后，"default" 指向的是**空档案**
     * （改名后那里只剩子目录）⇒ 浏览器起来停在 about:blank、消息发不出去。
     * 2026-10-17 真机就是这么翻车的。
     */
    this.getActiveAccount = opts.getActiveAccount ?? (() => undefined);

    this.proc = null;
    this.conn = null;
    this.targetId = null;
    this.loopTimer = null;
    this.idleTimer = null;
    this.busy = false;
    this.stopping = false;
    this.startedAt = 0;
    this.lastJobAt = 0;
    this.stats = { claimed: 0, done: 0, failed: 0, launched: 0 };
    this.pending = null; // { jobId, baselineCount, startedAt }
    this.hookInjectedAt = 0;
  }

  // ── 对外：状态（给 /status 用）──────────────────────────────

  status() {
    return {
      enabled: this.config.enabled === true,
      source: DRIVER_SOURCE,
      edgePath: resolveEdgePath(this.config.executable) || null,
      prootLauncher: resolveProotLauncher() || null,
      userDataDir: resolveUserDataDir(this.config.userDataDir),
      port: this._port ?? this.config.port,
      platformId: this.platformId,
      hideWindow: this.config.hideWindow === true,
      windowHidden: this._windowHidden === true,
      running: this.proc !== null || (this.conn !== null && this.conn.closed === false),
      pid: this.proc?.pid ?? null,
      cdpConnected: this.conn !== null && this.conn.closed === false,
      targetUrl: this.targetUrl ?? null,
      busy: this.busy,
      pendingJobId: this.pending?.jobId ?? null,
      stats: { ...this.stats },
      uptimeMs: this.startedAt === 0 ? 0 : Date.now() - this.startedAt,
      idleShutdownMs: this.config.idleShutdownMs,
    };
  }

  get targetUrl() { return this._targetUrl ?? null; }

  // ── 窗口可见性 ─────────────────────────────────────────────

  /**
   * 把工作窗口藏到屏幕外（或叫回来）。
   *
   * ## 为什么不用 `--headless` / `Browser.setWindowBounds` 到极小尺寸
   *
   * - `--headless`：最典型的机器人特征，等于自毁反封优势。**绝不用。**
   * - 尺寸缩到 1×1：某些站点会检查窗口尺寸，且布局塌陷会让选择器失效。
   * - **移到屏幕外**：页面完全正常渲染、`visibilityState` 仍是 `visible`、
   *   指纹零变化 —— 只是你看不见它。
   *
   * 坐标用 `-24000` 这种远超任何真实显示器范围的值，确保不会误落在
   * 第二屏或虚拟桌面上。同时保留正常窗口尺寸，布局不受影响。
   *
   * @param {boolean} hide - true = 藏起来，false = 叫回屏幕内
   */
  async setWindowVisible(hide) {
    if (this.conn === null || this.conn.closed !== false) return false;
    try {
      const win = await this.conn.send("Browser.getWindowForTarget", { targetId: this.targetId }, 5000);
      if (win?.windowId === undefined) return false;
      const bounds = hide
        ? { left: -24000, top: -24000, width: 1100, height: 820, windowState: "normal" }
        : { left: 80, top: 60, width: 1100, height: 820, windowState: "normal" };
      await this.conn.send("Browser.setWindowBounds", { windowId: win.windowId, bounds }, 5000);
      this._windowHidden = hide === true;
      return true;
    } catch (e) {
      this.log.debug?.(`[edge-driver] 设置窗口可见性失败（不影响干活）: ${String(e?.message ?? e)}`);
      return false;
    }
  }

  /** 把窗口叫到最前面（需要用户登录时用）。 */
  async bringToFront() {
    if (this.conn === null || this.conn.closed !== false) return false;
    try {
      await this.setWindowVisible(false);
      await this.conn.send("Page.bringToFront", {}, 5000).catch(() => undefined);
      this._windowHidden = false;
      return true;
    } catch {
      return false;
    }
  }

  /** 需要用户登录时：把窗口叫出来并置顶，让用户能看见、能操作。 */
  async surfaceForLogin(provider) {
    this.log.info?.("[edge-driver] 需要登录 —— 把 Edge 窗口叫到前台");
    await this.bringToFront();
    try {
      const home = provider?.homeUrl ?? "https://chat.deepseek.com/";
      await this.goto(home);
    } catch { /* 导航失败也不影响用户手动操作 */ }
    return true;
  }

  // ── 启动 ───────────────────────────────────────────────────

  /** 起 Edge（如果还没起）+ 连 CDP + 定位到聊天页。幂等。 */
  async ensureEdge(platformId, accountId) {
    if (this.config.enabled !== true) throw new Error("edge-driver 未启用");

    /**
     * ## 多平台：一个平台一只 Edge（独立 profile + 独立端口）
     *
     * 为什么必须分开：webin 的设计就是**一个平台一个独立浏览器环境**
     * （原版用 `browser.acquire(provider.id)` 按 workspace 名缓存 partition），
     * 这样多平台登录互不干扰。驱动器照抄这个语义：
     *
     *   - deepseek → profile `<DSH_HOME>/edge-ldw/deepseek`，端口 9411
     *   - qwen     → profile `<DSH_HOME>/edge-ldw/qwen`，     端口 9412
     *   - 第 N 个   → 端口 9411 + N
     *
     * ⚠️ 换平台时必须先关掉上一个平台的 Edge，否则多个 Edge 抢同一个
     * profile 目录会互相顶掉（Edge 是单例，后启动的会把自己转交给先启动的）。
     */
    const wanted = typeof platformId === "string" && platformId !== "" ? platformId : this.platformId;
    /**
     * 账号解析顺序：调用方 → 配置里该平台的 active 槽位 → 上次用过的 → 最后才是 default。
     * 这样任何「没带账号」的调用路径都不会误开空档案。
     */
    const configuredAccount = typeof this.getActiveAccount === "function" ? this.getActiveAccount(wanted) : undefined;
    this.accountId = resolveAccountId({ explicit: accountId, configured: configuredAccount, previous: this.accountId });
    const accountKey = this.accountId;
    if (wanted !== this.platformId || (this._activeAccountId && accountKey !== this._activeAccountId)) {
      this.log.info?.(`[edge-driver] 切换 profile ${this.platformId}#${this._activeAccountId ?? "default"} → ${wanted}#${accountKey}`);
      await this.shutdownEdge("切换网站/账号");
      this.platformId = wanted;
    }
    this._activeAccountId = accountKey;
    const port = this.portFor(this.platformId, accountKey);
    const dir = this.userDataDirFor(this.platformId, accountKey);

    // ① 已经连上就直接复用。
    if (this.conn !== null && this.conn.closed === false && this.proc !== null && this._port === port) return this;

    // ② **先看端口**：可能是上一次留下的 Edge 还在跑（或用户自己起的）。
    //    这时**绝不能再 spawn** —— Edge 是单例的，第二个进程发现同 profile
    //    已有实例会立刻把请求转交过去然后**自己退出**，而退出回调会把
    //    刚建立的 CDP 连接清掉（踩过这个坑：报 `Cannot read properties of null`）。
    if (await this.portAlive(port)) {
      /**
       * ## ⚠️⚠️ 复用前**必须核对归属**（2026-10-16 真机踩到，用户报「只有 DeepSeek 能用」）
       *
       * 端口上有 Edge ≠ 那个 Edge 是我们要的那个 profile。
       *
       * 事故链：
       *   1. DSH 被强杀（或没走正常退出）⇒ 空闲关停的定时器随进程死了
       *      ⇒ Edge 成了**孤儿**，一直活到下次手动关
       *   2. DSH 重启 ⇒ 新建的 driver 里 `conn === null && proc === null`
       *   3. 于是 `shutdownEdge()` 第一行直接 return false —— **关不掉那个孤儿**
       *   4. 代码走到这里，看到端口活着就「直接复用」
       *   5. 可那个 Edge 用的是**上一个平台的 profile**（比如 deepseek）
       *      ⇒ 拿它去跑元宝，页面当然没有元宝的登录态
       *      ⇒ 探针判「未登录」⇒ 报 `WEBIN_NOT_LOGGED_IN`
       *
       * 用户看到的就是「只有 DeepSeek 能用，其他都不行」——
       * 而真相是**第一个平台把浏览器占住了，后面的都在用它**。
       *
       * ## 判据：启动时写的归属标记
       *
       * spawn 时会在 `<DSH_HOME>/webin/edge-owner/<端口>.json` 记下
       * 「这个端口属于哪个平台#槽位、哪个 profile 目录」。
       * 复用前读它核对；对不上（或压根没有标记 = 不是我们起的）
       * 就把那个 Edge 关掉，重开一个正确的。
       */
      const owner = this.readEdgeOwner(port);
      const mine = owner !== null && owner.platformId === this.platformId && owner.accountId === accountKey && owner.dir === dir;
      if (mine) {
        this.log.info?.(`[edge-driver] 端口 ${port} 已有**本槽位**的 Edge（${this.platformId}#${accountKey}），直接复用`);
        this._port = port;
        await this.attach();
        if (this.config.hideWindow === true) await this.setWindowVisible(true);
        this.touchIdle();
        return this;
      }
      this.log.warn?.(
        `[edge-driver] 端口 ${port} 上的 Edge 不属于 ${this.platformId}#${accountKey}` +
        `（${owner === null ? "无归属标记" : `属于 ${owner.platformId}#${owner.accountId}`}）—— 关掉重开，否则会拿错 profile`,
      );
      await this.closeEdgeOnPort(port);
      /** 等端口真正释放（Edge 优雅退出要一点时间），最多 ~6 秒。 */
      for (let i = 0; i < 20 && (await this.portAlive(port)); i++) await sleep(300);
      if (await this.portAlive(port)) {
        throw new Error(`端口 ${port} 上的 Edge 关不掉（可能不是本插件起的）—— 请手动关掉占用该端口的 Edge 后重试`);
      }
      this.log.info?.(`[edge-driver] 端口 ${port} 已释放，准备启动正确的 profile`);
    }

    const exe = resolveEdgePath(this.config.executable);
    if (exe === "") {
      throw new Error(
        "找不到可用的浏览器。请任选一种方式指定：\n" +
        "  · 插件配置里填 edgeDriver.executable = <浏览器可执行文件路径>\n" +
        "  · 或设环境变量 DSH_WEBIN_BROWSER / PUPPETEER_EXECUTABLE_PATH\n" +
        "  · Windows 上装 Edge 即可自动找到；手机上若用 npm 装了 Chrome，" +
        "把那个 chrome 二进制的完整路径填进来就能用",
      );
    }

    mkdirSync(dir, { recursive: true });
    this._port = port;

    /**
     * ## 启动参数：省内存优先，但**绝不碰指纹**
     *
     * 用户机器只剩 ~1.6 GB 可用，而一只 Edge 实测占 ~670 MB。这里关掉的全是
     * **与页面渲染和指纹无关**的东西：
     *
     *   - `--disable-background-mode`     关掉后台预加载（Edge 关了窗口还赖着）
     *   - `--disable-features=...`        关翻译 / 身份 / 预渲染等后台特性
     *   - `--disable-backgrounding-occluded-windows` 页面被挡住时**不要**降频
     *     （反直觉：这个开着反而更省，因为不降频就不会反复重绘恢复）
     *   - `--no-service-autorun`          不自动跑后台服务
     *   - `--disable-sync`                不跑同步（登录态是本地的，不需要）
     *   - `--disk-cache-size` 限制磁盘缓存，别让它长到几百 MB
     *
     * ⚠️ **刻意不加**的（会改指纹，等于自毁 webin 的反封优势）：
     *   - `--disable-gpu` / `--use-gl=swiftshader`（WebGL 指纹会变）
     *   - `--user-agent=...`（UA 必须由真 Edge 自己给，保持与内核自洽）
     *   - `--headless`（无头模式是最典型的机器人特征）
     *   - `--disable-blink-features=AutomationControlled`（这个反而显眼）
     */
    const args = [
      `--remote-debugging-port=${port}`,
      `--user-data-dir=${dir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-background-mode",
      "--no-service-autorun",
      "--disable-sync",
      /**
       * ## ⚠️⚠️ 这几个是「屏幕外窗口」能正常干活的前提
       *
       * Chromium 会把**看不见的窗口**降频：定时器变慢（1s → 1min）、
       * 渲染停滞、`requestAnimationFrame` 几乎不触发。而我们的页面被移到
       * 屏幕外之后正好命中这个逻辑 —— 不关掉这些节流，页面会「假死」：
       * 发送点了没反应、回复等不到。
       *
       *   - `--disable-background-timer-throttling`  定时器不降频
       *   - `--disable-backgrounding-occluded-windows` 被遮挡也不降频
       *   - `--disable-renderer-backgrounding`      渲染进程不降优先级
       *
       * 这三个**不改任何指纹**（它们是进程调度策略，页面 JS 探测不到），
       * 也不影响 UA / WebGL / 字体 —— 纯粹让屏幕外的窗口保持全速运行。
       */
      "--disable-background-timer-throttling",
      "--disable-backgrounding-occluded-windows",
      "--disable-renderer-backgrounding",
      "--disable-features=Translate,msEdgeIdentityFeature,msEdgeSidebarFeature,EdgeCollections,msEdgeFirstRunExperience,msShortcutsIntegration",
      "--disk-cache-size=52428800",
      "--window-size=1100,820",
      /**
       * 浏览器自己的弹层（真实事故：这些窗口会挡住脚本点击，页面内关不掉）：
       *   - 崩溃恢复气泡「恢复页面？」（上次被杀过就会弹）
       *   - 错误对话框
       */
      "--hide-crash-restore-bubble",
      "--noerrdialogs",
      ...(this.config.hideWindow === true ? ["--window-position=-24000,-24000"] : []),
      "about:blank",
    ];
    this.log.info?.(`[edge-driver] 启动真 Edge: platform=${this.platformId} port=${port} profile=${dir} hide=${this.config.hideWindow === true}`);
    // ⚠️ 沙箱下必须 stdio:'ignore'（走管道会 EPERM）；detached + unref 让 Edge 独立存活。
    const launch = resolveLaunchCommand(exe);
    if (launch.viaProotLauncher) {
      this.log.info?.(
        `[edge-driver] Android/proot：经启动器 ${launch.cmd} ${launch.prefixArgs[0]}（memfd→ENOSYS + 自拉 Xvfb）`,
      );
    }
    const proc = spawn(launch.cmd, [...launch.prefixArgs, ...args], {
      detached: true,
      stdio: "ignore",
      windowsHide: false,
      env: launch.env,
    });
    proc.unref?.();
    this.proc = proc;
    this.startedAt = Date.now();
    this.stats.launched++;
    /**
     * ⚠️ 退出回调**不能**顺手把 `conn` 清空。
     *
     * Edge 单例：如果同 profile 已有实例，这个进程会立刻退出（把请求转交过去），
     * 而 CDP 其实连的是**那个还活着的**实例 —— 清空 conn 会把好好的连接掐掉。
     * 这里只标记进程没了；连接的有效性由 `conn.closed` 自己说话。
     */
    proc.on?.("exit", () => {
      if (this.proc === proc) this.proc = null;
    });

    /**
     * ⚠️ 立刻写下**归属标记**：告诉后来的自己「这个端口上的 Edge 属于谁」。
     *
     * 必须写在 `waitForPort()` **之前**：端口一旦通了，别的代码路径
     * （或另一个 driver 实例）就可能来复用，那时标记必须已经在了。
     */
    this.writeEdgeOwner(port, {
      platformId: this.platformId,
      accountId: accountKey,
      dir,
      pid: proc.pid ?? null,
    });

    await this.waitForPort();
    await this.attach();
    /**
     * 藏窗口：**必须在 attach 之后**（要拿 windowId 才能设位置）。
     *
     * 启动参数里已经给了 `--window-position=-24000,-24000`，但那只对
     * **首次创建**生效；复用已有 Edge 时得靠这里再设一次。
     */
    if (this.config.hideWindow === true) await this.setWindowVisible(true);
    this.touchIdle();
    return this;
  }

  /** 探一下 CDP 端口通不通（不抛错）。 */
  async portAlive(port) {
    const p = port ?? this._port ?? this.config.port;
    try {
      /**
      * ⏰ 带超时（2026-10-19 事故）：裸 fetch 对着「进程在、CDP 半死」的端口
      * 可能挂几分钟，把领活循环的 ticking 锁一起拖死。2.5 秒还没答 = 不在线。
      */
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 2500);
      try {
        const r = await fetch(`http://127.0.0.1:${p}/json/version`, { signal: ctrl.signal });
        return r.ok === true;
      } finally {
        clearTimeout(t);
      }
    } catch {
      return false;
    }
  }

  /** Driver 串行切换 profile，故所有网站复用一个端口即可；身份隔离由 userDataDir 保证。 */
  portFor(_platformId, _accountId = "default") {
    return this.config.port;
  }

  /**
   * 登录资料目录按「网站/账号槽位」隔离。槽位只允许安全字符，不包含手机号或凭证。
   *
   * ## ⚠️⚠️ default 槽位**必须**沿用旧路径（2026-10-16 真机实测修）
   *
   * 曾经的写法是**无条件**拼一层账号：
   *
   * ```
   * return join(base, safePlatform, safeAccount);   // ❌ 会毁掉所有既有登录态
   * ```
   *
   * 为什么这是致命的（用户报「元宝明明登录了却发不出去」的**真正根因**）：
   *
   *   - Edge 的 profile 布局是 `<user-data-dir>/Default/`（大小写不敏感）
   *   - 旧版 user-data-dir = `<base>/yuanbao`
   *     ⇒ 真 profile 落在 `<base>/yuanbao/Default/` ← **登录态在这里**
   *   - 加了多账号后 user-data-dir = `<base>/yuanbao/default`
   *     ⇒ 在 Windows 上 `yuanbao/default` 与 `yuanbao/Default` **是同一个目录**！
   *     ⇒ 于是 Edge 把**它自己那个 profile 目录**当成了 user-data-dir，
   *       再往里建一层 `Default/`，得到 `<base>/yuanbao/Default/Default/`
   *     ⇒ 那是一个**全新空白身份**：0 条 cookie、未登录
   *
   * 实测证据（A/B，同一台机同一个元宝账号）：
   *
   *   | user-data-dir | 探测结果 |
   *   |---|---|
   *   | `<base>/yuanbao`          | `loggedIn: true` ✅（hy_token 663B 密文在位）|
   *   | `<base>/yuanbao/default`  | `loggedIn: false` ❌（新目录 0 条 tencent cookie）|
   *
   * 后果是一条**死锁**：页面未登录 ⇒ host 门禁 `isPlatformLoggedIn` 判 false
   * ⇒ 任务根本不入队 ⇒ 快照永远写不出来（快照只在任务跑通后写）⇒ 门禁继续 false。
   * 用户看到的就是「登录态明明在，却一直说我没登录」。
   *
   * 所以：**default 槽位 = 平台一层（旧布局，兼容所有既有登录态）**；
   * 只有**真正的多账号**（`work` 之类）才多拼一层。
   * 这样旧登录态原地复活，且新槽位仍然互相隔离。
   */
  userDataDirFor(platformId, accountId = "default") {
    const base = resolveUserDataDir(this.config.userDataDir);
    /**
     * ⚠️ 必须与 `index.js` 的 `edgeProfileDirFor()` **算出一模一样的路径**。
     *
     * 一个决定「浏览器实际用哪个 profile」，一个决定「登录判据去哪读 cookie」。
     * 两边不一致 = 判据看 A 目录、浏览器用 B 目录 ⇒ 出现「明明登录着却报
     * 未登录」这类幽灵 bug（2026-10-16 已经因为目录层级不一致踩过一次）。
     *
     * 规则收拢在 `slot-names.js` 的 `safePathSegment`：只挡危险字符，
     * **中文原样保留**（旧的 `replace(/[^A-Za-z0-9_-]/g,"_")` 会把中文全变 `_`，
     * 导致「奶奶」和「爷爷」共用同一个 profile）。
     */
    const safePlatform = safePathSegment(platformId, "unknown");
    const safeAccount = safePathSegment(accountId || "default", "default");
    /** default（含空值）= 旧布局，**不**拼账号层 —— 见上方长注释。 */
    if (safeAccount === "default") return join(base, safePlatform);
    return join(base, safePlatform, safeAccount);
  }

  /** 等 CDP 端口可用。 */
  async waitForPort() {
    const port = this._port ?? this.config.port;
    const deadline = Date.now() + this.config.launchTimeoutMs;
    let lastErr = "";
    while (Date.now() < deadline) {
      try {
        const r = await fetch(`http://127.0.0.1:${port}/json/version`);
        if (r.ok) { await r.json(); return; }
        lastErr = `HTTP ${r.status}`;
      } catch (e) { lastErr = String(e?.message ?? e); }
      await sleep(300);
    }
    throw new Error(`Edge 的 CDP 端口没起来（${port}）：${lastErr}`);
  }

  /** 找到/新建一个 page target，连上它。 */
  async attach() {
    const port = this._port ?? this.config.port;
    const list = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
    /**
     * 优先挑**目标平台域名**的页面。
     *
     * 多平台时同一个 Edge 里可能开着别的站的标签 —— 必须挑对，
     * 否则会把脚本打进错误的页面（发错网站）。
     */
    const provider = this.getProvider(this.platformId);
    let wantRe = /chat\.deepseek\.com/;
    try { if (provider?.urlPattern) wantRe = new RegExp(provider.urlPattern); } catch { /* 用默认 */ }
    let page = list.find((t) => t.type === "page" && wantRe.test(String(t.url)) && t.webSocketDebuggerUrl);
    if (page === undefined) page = list.find((t) => t.type === "page" && t.webSocketDebuggerUrl);
    if (page === undefined) throw new Error("Edge 里没有可用的 page target");

    this.conn = await CdpConnection.connect(page.webSocketDebuggerUrl);
    this.targetId = page.id;
    this._targetUrl = page.url;
    await this.conn.send("Page.enable");
    await this.conn.send("Runtime.enable");
    this.conn.on("Page.frameNavigated", (p) => {
      if (p?.frame?.parentId === undefined) this._targetUrl = p.frame.url;
    });
    return this;
  }

  // ── 页面求值（等价于 webin 的 execJs）────────────────────────

  async evalInPage(code, timeoutMs = 30000) {
    const r = await this.conn.send("Runtime.evaluate", {
      expression: code,
      returnByValue: true,
      awaitPromise: true,
      userGesture: true,
    }, timeoutMs);
    if (r.exceptionDetails) {
      const d = r.exceptionDetails.exception?.description ?? r.exceptionDetails.text ?? "unknown";
      throw new Error(`页面脚本异常: ${String(d).slice(0, 300)}`);
    }
    return r.result?.value;
  }

  // ── 文件上传（压缩 .txt 通道用）────────────────────────────
  /**
   * 把本地文件塞进页面文件上传控件。
   * 流程：页面上确认存在 input[type=file] → DOM.querySelectorAll 拿 nodeId
   * → DOM.setFileInputFiles 写入本地文件（CDP 官方上传通道）→ 派发 change。
   */
  async uploadFileToPage(filePath, timeoutMs = 20000) {
    if (this.conn === null) throw new Error("CDP 未连接（先 attach）");
    try { await this.conn.send("DOM.enable"); } catch { /* 已启用则忽略 */ }
    /**
    * ## 元宝的文件控件是「两段式」（2026-10-19 实测破案）
    *
    * 页面初始**没有 input[type=file]**（0 个）——点输入区的「添加」按钮
    * （aria-label=添加）弹菜单：「联网搜索 / 上传图片 / **本地文件** / 腾讯文档」，
    * 再点「本地文件」才创建文件控件。老代码第一行 probe 就死在 no-file-input。
    *
    * 顺序：先 probe（有控件=老站直接走）→ 没有则「添加 → 本地文件」两步弹菜单。
    * DeepSeek 等其它站有原生控件，不受影响。
    */
    const findExpr = `(() => {
      const inputs = [...document.querySelectorAll('input[type=file]')];
      const visible = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
      const el = inputs.find(visible) ?? inputs[0];
      if (!el) return JSON.stringify({ ok: false, stage: 'no-file-input', message: '页面上没有 input[type=file] —— 可能还没登录或页面结构变了' });
      return JSON.stringify({ ok: true });
    })()`;
    let probe = JSON.parse(String(await this.evalInPage(findExpr, 10000)));
    /** probe 失败 ⇒ 元宝两段式：点「添加」→ 弹层里点「本地文件」。 */
    if (probe.ok !== true) {
      await this.evalInPage(`(() => {
        const visible = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
        const btn = [...document.querySelectorAll('button,[role="button"],[aria-label]')].find(e => visible(e) && /添加|附件|上传|attach|upload/i.test(String(e.getAttribute('aria-label')||'') + String(e.getAttribute('title')||'')));
        if (btn) btn.click();
        return btn ? 'clicked-add' : 'no-add-btn';
      })()`, 10000).catch(() => "");
      await sleep(1000);
      await this.evalInPage(`(() => {
        const visible = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
        const item = [...document.querySelectorAll('div,li,button,span,[role="menuitem"]')].find(e => visible(e) && /^本地文件$/.test(String(e.innerText||'').trim().split('\\n')[0]));
        if (item) item.click();
        return item ? 'clicked-local-file' : 'no-local-file-item';
      })()`, 10000).catch(() => "");
      await sleep(800);
      probe = JSON.parse(String(await this.evalInPage(findExpr, 10000)));
    }
    if (probe.ok !== true) return probe;
    const doc = await this.conn.send("DOM.getDocument", { depth: -1 }, timeoutMs);
    const q = await this.conn.send("DOM.querySelectorAll", {
      nodeId: doc.root.nodeId,
      selector: 'input[type=file]',
    }, timeoutMs);
    if (!q.nodeIds || q.nodeIds.length === 0) {
      return { ok: false, stage: 'no-node-id', message: 'DOM 查询没拿到上传控件节点' };
    }
    let lastErr = null;
    for (const nodeId of q.nodeIds) {
      try {
        await this.conn.send("DOM.setFileInputFiles", {
          files: [filePath],
          nodeId,
        }, timeoutMs);
        await this.evalInPage(`(() => {
          const inputs = [...document.querySelectorAll('input[type=file]')];
          const el = inputs[0];
          if (el) el.dispatchEvent(new Event('change', { bubbles: true }));
          return 'ok';
        })()`, 8000);
        return { ok: true };
      } catch (e) {
        lastErr = e;
      }
    }
    return { ok: false, stage: 'set-files-failed', message: `setFileInputFiles 全部失败: ${lastErr?.message ?? lastErr}` };
  }

  // ── 页面档位 / 页面模式（元宝两层菜单、豆包模式层）──────────────

  /** 可见性判定片段（注入脚本里复用）。 */
  _visExpr() {
    return "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";
  }

  /**
   * 打开「模型 / 模式选择」面板。
   *
   * 平台差异（2026-10-19 DOM 实测）：
   *   - 元宝：`button[aria-label="Switch model"]`（切换模型）——关键词能扫到；
   *   - 豆包：模式入口是**输入框旁的胶囊**（`data-testid` 含
   *     `chat_input_action_mode` / `chat_input_action_model`）——它不含
   *     「模式」二字文本，靠 data-testid 命中。
   */
  async _openPanel() {
    const vis = this._visExpr();
    const expr = `(() => {
      const vis=${vis};
      /** ① 豆包优先：data-testid 直命中（比文本关键词准）。 */
      const pills=[...document.querySelectorAll('[data-testid]')].filter(vis);
      const pill=pills.find(e=>/chat_input_action_(mode|model)/i.test(e.getAttribute('data-testid')||''));
      if(pill){ pill.click(); return 'opened'; }
      /** ② 元宝/通用：aria-label + 文本关键词（中英双语都认）。 */
      const kw=/switch model|切换模型|模型|^mode$|模式|hy\\d|deepseek|混元|hunyuan|聊天|工作/i;
      const cands=[...document.querySelectorAll('button,[role="button"],[data-testid]')].filter(vis);
      const hit=cands.find(e=>kw.test(String(e.getAttribute('aria-label')||'')+String(e.getAttribute('data-testid')||'')+String(e.innerText||'')));
      if(!hit) return 'no-button';
      if (hit.getAttribute('aria-expanded') === 'true') return 'already';
      hit.click();
      return 'opened';
    })()`;
    const r = String(await this.evalInPage(expr, 10000).catch(() => "err"));
    if (r === "opened") await sleep(1200);
    return r;
  }

  /**
   * 读当前展开面板里的条目文本（去重、截断）。
   *
   * ## 2026-10-19 实测修正（T5 抓到的污染）
   *
   * 元宝打开「模型选择」后，弹层与**对话历史侧栏**同时在 DOM 里，
   * 宽选择器（`[class*="menu"] li` 等）把「Recent / 会话标题」全扫了进来。
   * 修法：
   *   1. **优先收 role**：`[role="menuitem*"]`/`[role="option"]`（真菜单项才有），
   *      只在 role 一条都扫不到时才退宽选择器；
   *   2. **Recent 截断**：碰到「Recent/最近」这种历史区标题就丢掉它和之后的全部
   *      ——那是侧栏，不是菜单。
   */
  async _readPanelItems() {
    const vis = this._visExpr();
    const expr = `(() => {
      const vis=${vis};
      const seen=new Set();
      const read=(sels)=>{
        const out=[];
        for(const s of sels){
          for(const e of document.querySelectorAll(s)){
            if(!vis(e)) continue;
            const t=String(e.innerText||'').trim().replace(/\\n+/g,' | ');
            if(t.length<2||t.length>200) continue;
            const k=t.slice(0,40);
            if(seen.has(k)) continue; seen.add(k);
            out.push(t.slice(0,80));
            if(out.length>=24) break;
          }
          if(out.length>=24) break;
        }
        return out;
      };
      let out=read(['[role="menuitemradio"]','[role="menuitem"]','[role="option"]','[role="menu"] [role="menuitem"]']);
      if(out.length===0) out=read(['[class*="model-item"]','[class*="modelItem"]','[class*="mode-item"]','[class*="dropdown"] li','[class*="popup"] li','[class*="menu"] li']);
      /**
      * 豆包兜底（2026-10-19 DOM 实测）：它的菜单项**无 role 也无 menu 类**——
      * 「对话/工作」是 tailwind BUTTON/DIV。最后一级：全 DOM 找
      * 可见、自身文本就是模式词的最内层元素。
      */
      if(out.length===0){
        const MODE=/^(对话|工作|聊天|学习|Instant|Thinking|Expert|快速回答|深度思考|专家模式)$/;
        for(const e of document.querySelectorAll('button,div,li,span')){
          if(!vis(e)) continue;
          const own=Array.from(e.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent||'').join('').trim();
          if(!own||!MODE.test(own)) continue;
          if([...e.children].some(c=>MODE.test(String(c.innerText||'').trim()))) continue;
          const key=own.slice(0,40);
          if(seen.has(key)) continue; seen.add(key);
          out.push(own.slice(0,80));
          if(out.length>=12) break;
        }
      }
      const cut=out.findIndex(t=>/^recent|最近|^历史/i.test(String(t).split(' | ')[0]));
      if(cut>=0) out=out.slice(0,cut);
      return JSON.stringify(out);
    })()`;
    const raw = String(await this.evalInPage(expr, 15000).catch(() => "[]"));
    try { return JSON.parse(raw); } catch { return []; }
  }

  /**
   * 在已展开的面板里点一个条目（文本前缀优先、包含兜底）。只认 role 菜单项，防误点侧栏。
   * 2026-10-19：want 支持「名字A|名字B」多语言串（页面语言中英会切换），
   * 逐个名字尝试前缀/包含匹配。
   */
  async _pickPanelItem(want) {
    const vis = this._visExpr();
    const expr = `(() => {
      const vis=${vis};
      const wantList=${JSON.stringify(String(want ?? "").split("|").map((s) => s.trim()).filter((s) => s !== ""))};
      const sels=['[role="menuitemradio"]','[role="menuitem"]','[role="option"]','[class*="model-item"]','[class*="modelItem"]','[class*="mode-item"]','[class*="dropdown"] li','[class*="popup"] li'];
      const items=[];
      for(const s of sels){
        for(const e of document.querySelectorAll(s)){
          if(!vis(e)) continue;
          const t=String(e.innerText||'').trim();
          if(t.length<2||t.length>200) continue;
          items.push(e);
        }
      }
      if(items.length===0) return 'no-items';
      const head=(e)=>String(e.innerText||'').trim().split('\\n')[0].toLowerCase();
      for(const w of wantList){
        const wl=String(w).toLowerCase();
        const hit=items.find(e=>head(e).startsWith(wl)) || items.find(e=>String(e.innerText||'').trim().toLowerCase().includes(wl));
        if(hit){ hit.click(); return 'picked:'+w; }
      }
      return 'no-match:'+items.map(e=>String(e.innerText||'').trim().split('\\n')[0]).slice(0,12).join('|');
    })()`;
    const r = String(await this.evalInPage(expr, 12000).catch(() => "err"));
    await sleep(900);
    return r;
  }

  /** 关掉面板（Escape + 点回输入框）—— 它盖在输入区上方，不关会挡填字/发送。 */
  async _closePanel() {
    await this.evalInPage("(() => { try { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); } catch(e){} try { const ed=document.querySelector('div.ql-editor,textarea,div[contenteditable=\"true\"]'); if(ed) ed.click(); } catch(e){} return 'closed'; })()", 8000).catch(() => undefined);
    await sleep(350);
  }

  /**
   * 面板里是否有「Models/模型」容器项（元宝的模型子层入口）。
   *
   * ⚠️ 2026-10-19 实测教训：页面语言会变（同账号今天英文明天中文），
   * 且旧正则 `\b` 对中文不成立（JS 的 \w 不含汉字）——
   * 「模型 | Hy3」永远匹配不上 `/^(models?|模型)\b/i`，子层从未展开过。
   * 现在按「首段 == models/model/模型」精确比配，中英双语都认。
   */
  _modelsEntryOf(items) {
    for (const t of items) {
      const head = String(t).split(" | ")[0].trim().toLowerCase();
      if (head === "models" || head === "model" || head === "模型") return t;
    }
    return undefined;
  }

  /**
   * ## 探测两层菜单（2026-10-18 第三批，用户截图定案）
   *
   * 元宝结构：
   *   - 模式层：Instant / Thinking / Expert（+ Models 容器项）
   *   - 模型子层（点 Models 展开）：Hy4 preview / Hy3 / DeepSeek
   *
   * 豆包结构：
   *   - 模式层：聊天 / 工作
   *
   * @returns {Promise<{ok:boolean,modes:Array<{text:string}>,models:Array<{text:string}>,raw:object,reason?:string}>}
   */
  async detectPageModels(provider) {
    const opened = await this._openPanel();
    if (opened !== "opened" && opened !== "already") return { ok: false, reason: opened, modes: [], models: [], raw: {} };
    await sleep(900);
    let top = await this._readPanelItems();
    /**
    * ## 豆包二级展开（2026-10-19 DOM 实测定案）
    *
    * 豆包的胶囊点开后只有**当前模式**一项（「对话」）——真正的选项
    * （对话/工作）藏在**点它之后的二级下拉**里。
    * 判据：top 只有 1 项且像模式名（对话/工作/聊天）⇒ 再点一次展开。
    */
    if (top.length === 1 && /^(对话|工作|聊天|学习)$/.test(String(top[0]).split(" | ")[0].trim())) {
      await this._hoverAndClickPanelItem(String(top[0]).split(" | ")[0].trim());
      await sleep(1200);
      const expanded = await this._readPanelItems();
      if (expanded.length > 1) top = expanded;
    }
    /** 有 Models 容器 ⇒ 悬停/点击展开读子层。 */
    const entry = this._modelsEntryOf(top);
    let sub = [];
    if (entry !== undefined) {
      const want = String(entry).split(" | ")[0].trim();
      const picked = await this._hoverAndClickPanelItem(want);
      if (String(picked).startsWith("hovered") || String(picked).startsWith("picked")) {
        /**
        * ## 子层读取（2026-10-19 DOM 实测定案）
        *
        * 元宝的 Models 子层是 **hover 展开**，且子层条目**没有 role**
        * （「Hy3」是 tailwind SPAN）——role 选择器扫不到。
        * 改用**关键词锚点**：找「hy3/hy4/deepseek/混元」文本节点，
        * 向上爬到条目容器取全名（条目名 | 描述）。
        */
        await sleep(1200);
        sub = await this._readSublayerByKeyword();
        if (sub.length === 0) { await sleep(1500); sub = await this._readSublayerByKeyword(); }
      }
    }
    await this._closePanel();
    const modes = top.filter((t) => t !== entry).map((t) => ({ text: String(t).split(" | ")[0] }));
    const models = (sub.length > 0 ? sub : []).map((t) => ({ text: String(t).split(" | ")[0] }));
    return {
      ok: modes.length > 0 || models.length > 0,
      modes,
      models,
      raw: { top, sub },
      reason: modes.length > 0 || models.length > 0 ? "" : "no-items",
    };
  }

  /**
   * hover + click 双保险点开一个面板条目（Models 容器是 hover 展开型，
   * 纯 click 在部分渲染时序里不触发展开——2026-10-19 实测）。
   */
  async _hoverAndClickPanelItem(want) {
    const vis = this._visExpr();
    const expr = `(() => {
      const vis=${vis};
      const wantList=${JSON.stringify(String(want ?? "").split("|").map((s) => s.trim()).filter((s) => s !== ""))};
      const cands=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],li,div')].filter(vis);
      let target=null;
      for(const w of wantList){ const wl=String(w).toLowerCase();
        target=cands.find(e=>{ const t=String(e.innerText||'').trim().split('\\n')[0]; return t.toLowerCase()===wl || t.toLowerCase().startsWith(wl) }) || cands.find(e=>String(e.innerText||'').trim().toLowerCase().includes(wl));
        if(target) break; }
      if(!target) return 'no-match';
      for(const ty of ['pointerover','mouseenter','mouseover']){ try{ target.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})) }catch(e){} }
      try{ target.click() }catch(e){}
      return 'hovered:'+String(target.innerText||'').trim().split('\\n')[0].slice(0,20);
    })()`;
    const r = String(await this.evalInPage(expr, 12000).catch(() => "err"));
    await sleep(900);
    return r;
  }

  /**
   * 按关键词锚点读 Models 子层（条目无 role，role 选择器扫不到——DOM 实测）。
   * 找「hy3/hy4/deepseek/混元」文本节点 → 向上爬到条目容器取「条目名 | 描述」。
   */
  async _readSublayerByKeyword() {
    /**
    * 两层判定（T5e 实测修正）：
    *   A. 叶子文本本身就是模型名（Hy3 / Hy4 preview / DeepSeek）⇒ 直接收；
    *   B. 叶子是描述（「Hy4 preview模型，AI搜索信源更全」）⇒ 向上找
    *      **最近条目容器**（文本 ≤3 行、首行像模型名），收「首行 | 描述」。
    * 爬过头护栏：文本 >3 行或含「安装/下载/一站式」⇒ 弃。
    */
    const expr = `(() => {
      const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
      const KW=/hy\\s?[34]|deepseek|混元|hunyuan/i;
      const isName=(t)=>{ const s=String(t||'').trim(); return s.length>0 && s.length<=16 && KW.test(s.split(/\\s|\\n/)[0]) };
      const seen=new Set(); const out=[];
      for(const e of document.querySelectorAll('*')){
        const own=Array.from(e.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent||'').join('').trim();
        if(!own || !KW.test(own)) continue;
        if(!vis(e)) continue;
        if(isName(own)){
          const key=own.slice(0,40);
          if(!seen.has(key)){ seen.add(key); out.push(own.slice(0,80)); }
          continue;
        }
        let cur=e; let full='';
        for(let i=0;i<5;i++){
          const p=cur.parentElement; if(!p) break;
          const t=String(p.innerText||'').trim();
          if(t.length===0 || t.length>160 || t.split('\\n').length>3) break;
          if(/安装|下载|一站式/i.test(t)) break;
          full=t.replace(/\\n+/g,' | ');
          if(isName(t.split('\\n')[0])) break;
          cur=p;
        }
        if(full==='') full=own;
        /** 名字清洗（T5f 实测）：「Hy4 preview模型，AI搜索信源更全」→「Hy4 preview」
         *  ——在第一个「模型」/中文逗号处截断，保留代号与 preview 标记。 */
        const cleaned=full.replace(/(模型|，|,).*/,'').trim();
        const finalText=cleaned.length>0?cleaned:full;
        const key=finalText.slice(0,40);
        if(!seen.has(key)){ seen.add(key); out.push(finalText.slice(0,80)); }
        if(out.length>=10) break;
      }
      return JSON.stringify(out);
    })()`;
    const raw = String(await this.evalInPage(expr, 15000).catch(() => "[]"));
    try { return JSON.parse(raw); } catch { return []; }
  }

  /**
   * 拨「页面模式」。
   *
   *   - 元宝：Instant / Thinking / Expert
   *   - 豆包：聊天 / 工作
   *
   * 失败**不阻断**（拨不到就用页面当前模式继续发）。
   */
  async applyPageMode(provider, pageMode) {
    const want = String(pageMode ?? "").trim();
    if (want === "") return { ok: false, reason: "empty" };
    const opened = await this._openPanel();
    if (opened === "no-button" || opened === "err") return { ok: false, reason: opened };
    await sleep(900);
    const picked = await this._pickPanelItem(want);
    await this._closePanel();
    if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 模式 ${want} → ${picked}`);
    return { ok: String(picked).startsWith("picked"), reason: picked };
  }

  /**
   * 拨「页面模型」（2026-10-18 起支持两层：先在模式面板里展开 Models 子层）。
   *
   * 两条原则不变：
   *   1. **找不到就不拨、不报错** —— 档位是加分项，不是发消息的前提；
   *   2. **拨完必须关掉弹层** —— 它盖在输入区上方，不关会挡住填字/发送。
   */
  async applyPageModel(provider, pageModel) {
    const want = String(pageModel ?? "").trim();
    if (want === "") return { ok: false, reason: "empty" };
    /** 不再限平台：自动识别出的档位任何平台都可能用。 */
    const opened = await this._openPanel();
    if (opened === "no-button" || opened === "err") return { ok: false, reason: opened };
    await sleep(900);
    /** 先看顶层有没有 Models 容器（元宝）——有就展开子层再选。 */
    const top = await this._readPanelItems();
    const entry = this._modelsEntryOf(top);
    if (entry !== undefined) {
      const picked = await this._pickPanelItem(String(entry).split(" | ")[0]);
      if (String(picked).startsWith("picked")) await sleep(1100);
    }
    const result = await this._pickPanelItem(want);
    await this._closePanel();
    if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 模型 ${want} → ${result}`);
    return { ok: String(result).startsWith("picked"), reason: result };
  }

  // ── 富文本编辑器的「真输入」兜底 ──────────────────────────

  /**
   * 用 CDP 的**原生文本输入**重填 contenteditable。
   *
   * ## 为什么必须有这个（2026-10-16，千问实测）
   *
   * 页面侧的填字脚本对 contenteditable 的最后兜底是 `el.textContent = value`，
   * 然后靠「innerText 非空」判定成功。可对 **Slate / ProseMirror / TipTap**
   * 这类**自带文档模型**的编辑器，直接写 DOM 等于没填 ——
   * 它们的 model 还是空的，于是：
   *   - 发送键仍是 disabled（或点了没反应）⇒ **消息根本没发出去**
   *   - 而脚本却报「填字成功」，所以报错落在后面（「点了发送但输入框没被清空」
   *     或干脆等到超时）
   *
   * 实测千问（`div[data-slate-editor="true"]`）就是这样：填字显示成功，
   * 但点发送后 DOM 里连用户消息都没有。
   *
   * ## 为什么 `Input.insertText` 能解决
   *
   * 它走的是浏览器**自己的**文本输入通道（与真人打字/输入法同一条路），
   * 会派发真正的 `beforeinput`/`input`（`inputType: "insertText"`）——
   * 富文本编辑器正是靠这些事件把文本落进自己的 model。
   * 比 `execCommand` 更底层、更接近真实输入。
   */
  async fillViaCdp(provider, text) {
    const sels = Array.isArray(provider?.input?.selectors) ? provider.input.selectors : [];
    const sel = sels[0];
    if (typeof sel !== "string" || sel === "") return false;
    const conn = this.conn;
    if (conn === null || conn.closed !== false) throw new Error("CDP 未连接，无法重填");

    /** ① 聚焦 + 清空（清空失败也无妨，insertText 会插在光标处；先删干净更稳）。 */
    const cleared = await this.evalInPage(`(() => {
      const el = document.querySelector(${JSON.stringify(sel)});
      if (!el) return 'no-el';
      el.focus();
      try { document.execCommand('selectAll', false, undefined); document.execCommand('delete', false, undefined); } catch (e) {}
      if ((el.innerText || '').trim() !== '') { try { el.textContent = ''; } catch (e) {} }
      return 'ok';
    })()`, 10000).catch(() => "err");
    if (cleared === "no-el") {
      throw new Error(`CDP 重填失败：找不到输入框（选择器 ${sel}）`);
    }

    /** ② 浏览器原生输入。 */
    await conn.send("Input.insertText", { text: String(text ?? "") }, 20000);
    await sleep(500);

    /** ③ 确认真的进去了 —— 不然宁可报错，也别让后面等 180 秒超时。 */
    const now = String(await this.evalInPage(
      `(() => { const el = document.querySelector(${JSON.stringify(sel)}); return el ? String(el.innerText || el.textContent || '') : ''; })()`,
      8000,
    ).catch(() => ""));
    if (now.trim() === "") {
      throw new Error("CDP 重填后输入框仍是空的（该编辑器可能不接受程序化输入）");
    }
    if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 已用 CDP Input.insertText 重填（${now.trim().length} 字符）`);
    return true;
  }

  /**
   * 发送键现在是**禁用**的吗？返回 true/false，判不了返回 null。
   *
   * ## 为什么需要它（2026-10-16 千问）
   *
   * 填字脚本报「成功」**不代表编辑器认了** —— Slate / ProseMirror 这类自带
   * 文档模型的编辑器，DOM 里有文字 ≠ model 里有文字。
   * 而**发送键的 disabled 状态正是网站自己依据 model 判定的** ⇒
   * 拿它当「填字到底成没成」的判据，比任何猜测都准。
   *
   * 千问实测：paste 之后 DOM 有字、发送键仍 disabled（点了没反应），
   * 驱动却以为填好了 ⇒ 报出「点了发送但输入框没被清空」这种误导性错误。
   */
  async isSendDisabled(provider) {
    const sels = Array.isArray(provider?.send?.selectors) ? provider.send.selectors : [];
    if (sels.length === 0) return null;
    try {
      const r = await this.evalInPage(
        '(() => { const sels = ' + JSON.stringify(sels) + '; for (const s of sels) {' +
        ' const els = [...document.querySelectorAll(s)];' +
        ' const el = els.find((e) => e.offsetWidth || e.offsetHeight || e.getClientRects().length);' +
        ' if (!el) continue;' +
        ' return String(el.disabled === true || el.getAttribute(\'aria-disabled\') === \'true\'); }' +
        ' return \'none\'; })()',
        8000,
      );
      const s = String(r);
      if (s === 'true') return true;
      if (s === 'false') return false;
      return null;
    } catch {
      return null;
    }
  }

  // ── 登录态 / 快照 ──────────────────────────────────────────

  /**
   * ## 用 Token / Cookie **注入登录**（2026-10-16 真机实验验证可行）
   *
   * 用户要的是「粘贴 Token/Cookie 就能登录」，不必开浏览器扫码 ——
   * 这样手机和电脑才能靠同一份凭据文件互相登录。
   *
   * ## 为什么必须走 CDP 注入，而不是去写 cookie 库
   *
   * Edge 的 cookie 在磁盘上是**加密的**（DPAPI + AES-GCM，密钥绑当前用户），
   * 自己拼加密值极其脆弱；而 `Network.setCookie` 是**浏览器自己**写进去的，
   * 加密/索引/域校验全由它处理，天然正确。localStorage 同理走页面 JS。
   *
   * ## 实测证据（干净临时 profile，只灌 token+cookie）
   *
   * | 阶段 | 页面 |
   * |---|---|
   * | 注入前 | URL 停在 `/sign_in`，「+86 发送验证码 / 微信扫码」 |
   * | 注入后 | URL 变成 `chat.deepseek.com`，正文出现昵称与「开启新对话」 |
   *
   * 也就是说：**全新 profile + 一份 token/cookie = 直接登进去**，无需扫码。
   *
   * ## 参数从哪来（全部可在 provider JSON 里覆盖）
   *
   *   - `credentialInjection.localStorageKeys`：要写哪些 localStorage 键
   *     （DeepSeek 是 `userToken`；值要用**原始信封串** `{"value":"..."}`，
   *     因为页面读的就是这个格式）
   *   - `credentialInjection.cookieUrl`：cookie 挂到哪个 URL 上
   *     （默认取 `homeUrl` 的 origin；**必须先导航到该域**，否则没有 origin 可挂）
   *
   * @returns {Promise<{ok:boolean,loggedIn:boolean,url:string,cookieSet:number,cookieFailed:string[],localStorageSet:string[],detail:string}>}
   */
  async injectCredentials(provider, { token = "", cookie = "", accountId = "default" } = {}) {
    const platformId = provider?.id ?? this.platformId;
    const inj = provider?.credentialInjection ?? {};
    const home = provider?.homeUrl ?? "https://chat.deepseek.com/";
    let origin = home;
    try { origin = new URL(home).origin; } catch { /* 配错就用原样 */ }

    /** ⚠️ 传 accountId：多账号是**一槽位一 profile**，注入必须落到目标槽位。 */
    await this.ensureEdge(platformId, accountId);
    const conn = this.conn;
    if (conn === null || conn.closed !== false) throw new Error("CDP 未连接，无法注入");

    /**
     * ⚠️ 必须先导航到目标域：`Network.setCookie` 与 `localStorage` 都**依附于
     * origin**。停在 about:blank 时既没有域可挂 cookie，localStorage 也是
     * 另一个 origin 的（写了等于没写）。实测踩过。
     */
    await this.goto(home);
    await sleep(2500);

    await conn.send("Network.enable", {}, 8000).catch(() => undefined);

    /**
     * ## ⚠️⚠️ 必须给 cookie 一个**过期时间**（2026-10-16 真机踩到）
     *
     * 不给 `expires` 的 cookie 在 Chromium 里是**会话 cookie** ——
     * 它只活在内存里，**不写进磁盘的 cookie 库**，浏览器一关就没了。
     *
     * 后果（实测）：注入后**当次**页面登录成功（探针在页面里读到登录态），
     * 但磁盘上的 `<profile>/Default/Network/Cookies` 里**根本没有那些 cookie**：
     *   - 重启 DSH / 空闲关掉 Edge 之后，登录态**凭空消失**
     *   - 「登录门禁」读磁盘时判未登录（实测 `/accounts` 报 `测试B 未登录`，
     *     而同一时刻页面里明明是登录着的）—— 判据和现实打架，最难查
     *
     * 所以统一给一个远期过期时间，把它变成**持久 cookie**。
     * 180 天足够长（真实站点自己的 cookie 也常是一年级别），
     * 而且凭据本来就有自己的失效逻辑（页面探针会如实报告）。
     */
    const COOKIE_TTL_DAYS = 180;
    const expires = Math.floor(Date.now() / 1000) + COOKIE_TTL_DAYS * 86400;

    // ── ① cookie ──────────────────────────────────────────────
    const cookieUrl = typeof inj.cookieUrl === "string" && inj.cookieUrl !== "" ? inj.cookieUrl : origin;
    const pairs = [];
    for (const part of String(cookie ?? "").split(";")) {
      const seg = part.trim();
      if (seg === "") continue;
      const i = seg.indexOf("=");
      if (i <= 0) continue;
      pairs.push({ name: seg.slice(0, i).trim(), value: seg.slice(i + 1).trim() });
    }
    let cookieSet = 0;
    const cookieFailed = [];
    for (const p of pairs) {
      try {
        const r = await conn.send("Network.setCookie", {
          name: p.name,
          value: p.value,
          url: cookieUrl,
          path: "/",
          secure: true,
          /**
           * ⚠️ `httpOnly: false` 是**刻意**的：我们注入的是用户从
           * `document.cookie` 抄来的那份（js 可见的那些）。真正的 httpOnly
           * 凭据抄不出来，只能靠 token 那一半补 —— 实测两者一起就够登录。
           */
          httpOnly: false,
          sameSite: "Lax",
          /** ⚠️ 必须有 —— 见上方 COOKIE_TTL_DAYS 的长注释（不给就成了会话 cookie，关掉浏览器即丢）。 */
          expires,
        }, 8000);
        if (r?.success === true) cookieSet++;
        else cookieFailed.push(p.name);
      } catch {
        cookieFailed.push(p.name);
      }
    }

    // ── ② localStorage ────────────────────────────────────────
    const keys = Array.isArray(inj.localStorageKeys) ? inj.localStorageKeys : [];
    const localStorageSet = [];
    if (token !== "" && keys.length > 0) {
      const spec = JSON.stringify(keys);
      const val = JSON.stringify(token);
      const r = await this.evalInPage(`(() => {
        const keys=${spec}; const v=${val};
        const done=[];
        for (const k of keys) { try { localStorage.setItem(k, v); done.push(k); } catch(e) {} }
        return JSON.stringify(done);
      })()`, 12000).catch(() => null);
      try { localStorageSet.push(...JSON.parse(String(r))); } catch { /* 拿不到就算了 */ }
    }

    // ── ③ reload 让页面带上新凭据重新初始化 ────────────────────
    await conn.send("Page.reload", { ignoreCache: true }, 10000).catch(() => undefined);
    await sleep(6000);

    // ── ④ 用**现成的登录探针**验证（这就是「token 还能不能用」的答案）──
    let probe = { loggedIn: false };
    for (let i = 0; i < 3; i++) {
      probe = await this.probe(provider);
      if (probe.loggedIn === true) break;
      await sleep(3500);
    }
    const url = String(await this.evalInPage("location.href", 8000).catch(() => ""));

    return {
      ok: probe.loggedIn === true,
      loggedIn: probe.loggedIn === true,
      url,
      cookieSet,
      cookieFailed,
      localStorageSet,
      detail: probe.loggedIn === true
        ? "注入成功，页面登录探针已确认"
        : `注入后仍未通过登录探针（cookie 成功 ${cookieSet}/${pairs.length}${cookieFailed.length ? `，失败 ${cookieFailed.join("/")}` : ""}；localStorage 写入 ${localStorageSet.length} 项）—— 凭据可能已过期`,
    };
  }

  async probe(provider = this.getProvider(this.platformId)) {
    // DeepSeek 原生登录探针只适用于 DeepSeek；其它站点必须声明经实测的 authProbe。
    if (provider?.id === "deepseek") {
      try { return JSON.parse(String(await this.evalInPage(buildProbeScript(), 15000))); }
      catch { return { loggedIn: false }; }
    }
    const auth = provider?.authProbe;
    if (auth?.type !== "dom" || !Array.isArray(auth.loggedOutSelectors) || !Array.isArray(auth.loggedInSelectors)) {
      /**
       * ## 没有 authProbe 的 provider：退化为「输入框在不在」（2026-10-16 修）
       *
       * 原来这里一律返回 `{loggedIn:false, unsupported:true}`，而 `runJob`
       * 看到 `loggedIn !== true` 就抛 `WEBIN_NOT_LOGGED_IN` 并把窗口叫到前台 ——
       * 后果是**用户自己写的自定义 provider 永远发不出消息**（它有输入框、
       * 也确实登录着，只是没声明 authProbe 而已）。真实 bug。
       *
       * 退化判据（`provider.input.selectors` 里**任一可见**即算登录）：
       *   - 输入框存在 = 页面已经进到聊天界面 = 基本可以认为登录着
       *   - 未登录时页面通常只剩登录页，输入框压根不存在 ⇒ 判 false
       *
       * 这不如专用探针精确，但对「我们不了解的站点」是唯一合理的推断，
       * 而且**失败方向安全**：真没登录的话，后面发送/抓回复那几步会报出
       * 更具体的原因，不会静默出错。
       */
      const fallbackSel = Array.isArray(provider?.input?.selectors) ? provider.input.selectors : [];
      if (fallbackSel.length === 0) {
        return { loggedIn: false, unsupported: true, reason: "该站点尚无经过验证的登录探针" };
      }
      try {
        const spec = JSON.stringify(fallbackSel);
        const expr = `(() => { const sels=${spec}; const visible=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)); const hit=sels.find(q=>{try{return [...document.querySelectorAll(q)].some(visible)}catch{return false}}); return JSON.stringify({loggedIn:hit!==undefined,inputVisible:hit??null,url:location.href,fallback:true}) })()`;
        const r = JSON.parse(String(await this.evalInPage(expr, 15000)));
        if (this.config.verboseLog) {
          this.log.debug?.(`[edge-driver] ${provider?.id} 无 authProbe，用输入框退化判据：loggedIn=${r.loggedIn}${r.inputVisible ? ` (${r.inputVisible})` : ""}`);
        }
        return r;
      } catch { return { loggedIn: false }; }
    }
    try {
      const spec = JSON.stringify({ loggedOutSelectors: auth.loggedOutSelectors, loggedInSelectors: auth.loggedInSelectors });
      const expr = `(() => { const s=${spec}; const visible=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)); const out=s.loggedOutSelectors.some(q=>{try{return [...document.querySelectorAll(q)].some(visible)}catch{return false}}); const yes=s.loggedInSelectors.some(q=>{try{return [...document.querySelectorAll(q)].some(visible)}catch{return false}}); return JSON.stringify({loggedIn:yes&&!out,url:location.href,loginUi:out}) })()`;
      return JSON.parse(String(await this.evalInPage(expr, 15000)));
    } catch { return { loggedIn: false }; }
  }

  /**
   * 关掉挡路的弹窗（广告/下载 App/通知授权引导/更新提示）。
   *
   * 只在**弹窗容器内部**点按钮，文字必须是明确的「稍后再说」类；点不掉补 Escape。
   * 返回 `{ clicked, labels }`，失败永远不抛（页面上没弹窗时就是空操作）。
   */
  async dismissOverlays() {
    const expr = `(() => {
      const VIS = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
      /** 「稍后再说」类按钮文字 —— 宁可少认几个，也不要点到「删除/退出」。 */
      const OK = /^(下次提醒我|以后再说|稍后再说|暂不|暂不更新|跳过|我知道了|知道了|不用了|关闭|继续使用网页版|继续浏览|下次再说|not now|later|maybe later|close|dismiss|skip)$/i;
      /** 弹窗/遮罩容器：dialog、含 modal/dialog/overlay/mask/popup 的类名，或 fixed 全屏层。 */
      const isOverlay = (el) => {
        const c = String(el.className || '');
        if (/modal|dialog|overlay|mask|popup|guide|banner/i.test(c)) return true;
        const s = getComputedStyle(el);
        return s.position === 'fixed' && el.offsetWidth > innerWidth * 0.5 && el.offsetHeight > innerHeight * 0.3;
      };
      const overlays = [...document.querySelectorAll('div,section,aside')].filter((el) => VIS(el) && isOverlay(el));
      const labels = [];
      let clicked = 0;
      for (const box of overlays) {
        const btns = [...box.querySelectorAll('button,[role="button"],a,span')].filter(VIS);
        for (const b of btns) {
          const t = (b.innerText || b.getAttribute('aria-label') || '').trim();
          if (!t || t.length > 14 || !OK.test(t)) continue;
          try { b.click(); clicked++; labels.push(t); } catch (e) { /* 点不动就算了 */ }
          break; /** 每个弹窗只点一个按钮，避免连点两次 */ 
        }
      }
      /** 兜底：Escape 能关掉大多数 Radix/自研弹窗。 */
      try {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', keyCode: 27, which: 27, bubbles: true }));
      } catch (e) {}
      return JSON.stringify({ clicked, labels: labels.slice(0, 5) });
    })()`;
    try { return JSON.parse(String(await this.evalInPage(expr, 15000))); }
    catch { return { clicked: 0, labels: [] }; }
  }

  /** DeepSeek 保留原快照；其它站只保存无秘密的登录判定标记。 */
  async snapshot(provider = this.getProvider(this.platformId)) {
    if (provider?.id === "deepseek") return await this.evalInPage(buildSnapshotScript(), 15000);
    const p = await this.probe(provider);
    return JSON.stringify({ provider: provider?.id ?? "unknown", loggedIn: p.loggedIn === true, at: Date.now() });
  }

  // ── 导航 ───────────────────────────────────────────────────

  async goto(url) {
    if (this.conn === null || this.conn.closed !== false) await this.ensureEdge();
    const conn = this.conn;
    await conn.send("Page.navigate", { url });
    /**
     * ⚠️ 用**一次性**监听器等 load 事件。
     *
     * `CdpConnection.on()` 是累加的 —— 早期写法每次 goto 都挂一个永久监听器，
     * 一次会话跑几十轮就会堆几十个（内存泄漏，且每次导航触发全部）。
     */
    await new Promise((resolve) => {
      let done = false;
      const finish = () => { if (!done) { done = true; clearTimeout(t); conn.off("Page.loadEventFired", finish); resolve(); } };
      const t = setTimeout(finish, 20000);
      conn.on("Page.loadEventFired", finish);
    });
    this._targetUrl = url;
  }

  /** 注入 webin 原生 hook（幂等，自带 MARKER）。 */
  async ensureHook(provider) {
    // 此 hook 解析的是 DeepSeek 私有 SSE 协议，不能仅换 completionPath 就用于其它站。
    if (provider?.id !== "deepseek") return "unsupported-provider-hook";
    const hook = buildDeepSeekHook(provider.completionPath, provider.stopPath);
    const r = await this.evalInPage(hook, 20000);
    if (r !== "already-installed") this.hookInjectedAt = Date.now();
    return r;
  }

  // ── 一个任务的完整生命周期 ─────────────────────────────────

  /**
   * 跑一个任务：填字 → 点发送 → 等回复 → 返回文本。
   * @returns {Promise<{text:string, think:string, status:string, chatUrl:string, via:string}>}
   */
  async runJob(job, provider) {
    const prompt = String(job.prompt ?? "");
    if (prompt === "") throw new Error("任务没有 prompt");

    // 0) 会话回收策略（2026-10-16 改为可配置：never/immediate/delay/count）。
    // 只在 provider 明确声明具备已验证的会话列表+删除适配时才动网页版，
    // 未适配站点一律不调用它的接口，防止误删或错误请求。
    const deleteMode = resolveMode(this.config);
    const canManageSessions = deleteMode !== "never" && (provider?.sessionApi?.verified === true || provider?.sessionApi?.verified === "deepseek-v1") && provider?.sessionApi?.list === true && provider?.sessionApi?.delete === true;
    /**
    * 基线解耦（2026-10-21）：renameSession（LDW 前缀标记）不依赖清理模式——
    * 只要平台配了 rename 端点就该拿基线，否则 sessionDeleteMode=never 时
    * _sessionsBefore 恒空 → 第 11 步自动改名静默跳过（实测抓到）。
    */
    const canRenameSessions = provider?.sessionApi?.rename === true && typeof provider?.sessionApi?.renamePath === "string" && provider.sessionApi.renamePath !== "";
    if (canManageSessions || canRenameSessions) {
      /**
       * ⚠️ 基线（任务开始前的会话列表）在 `delay`/`count` 模式下**同样必需**：
       * 它是判断「哪些会话是本轮新建的」的唯一依据，而账本只记这些。
       * 拿不到基线就宁可不记（`collectNewSessions` 会直接放弃），
       * 免得把用户自己的历史对话记进待删账本。
       */
      this._sessionsBefore = await this.listSessions(provider).catch(() => null);
    } else {
      this._sessionsBefore = null;
    }

    // 1) 确认在正确的页面
    const wantUrl = job.expectUrl;
    if (typeof wantUrl === "string" && wantUrl !== "") {
      const cur = String(await this.evalInPage("location.href", 10000));
      if (cur !== wantUrl) await this.goto(wantUrl);
    } else if (job.freshChat === true) {
      await this.goto(provider?.homeUrl ?? "https://chat.deepseek.com/");
    } else {
      /**
       * ⚠️ 兜底：既没有 `expectUrl` 也不是 `freshChat` 时，页面可能还停在
       * `about:blank`（Edge 刚起来的样子）—— 这时 probe 一定读不到登录态，
       * 会**误报「未登录」**。所以先确保落在目标域里。
       */
      const cur = String(await this.evalInPage("location.href", 10000).catch(() => ""));
      let onTarget = false;
      try {
        onTarget = new RegExp(provider?.urlPattern ?? "chat\\.deepseek\\.com").test(cur);
      } catch {
        onTarget = /chat\.deepseek\.com/.test(cur);
      }
      if (!onTarget) await this.goto(provider?.homeUrl ?? "https://chat.deepseek.com/");
    }
    /** 导航后给页面一点时间落 DOM（首屏 + 登录态恢复）。 */
    await sleep(1500);

    // 2) 登录守卫 —— 未登录时把窗口叫出来让用户能登
    const p = await this.probe(provider);
    if (p.loggedIn !== true) {
      if (this.config.hideWindow === true) await this.surfaceForLogin(provider);
      const err = new Error("LDW 页面未登录（跳到了登录页）。已把浏览器窗口叫到前台，请登录后重发。");
      err.code = "WEBIN_NOT_LOGGED_IN";
      throw err;
    }

    // 3) 未适配回复捕获策略时禁止发送，避免消息发出后只能超时或误读页面文本。
    /**
     * ⚠️ 判据升级（2026-10-16）：光有 `replyCapture.type === "dom"` **不够** ——
     * 元宝/豆包声明了 dom 策略但 `replySelectors` 是空数组，那样发出去也抓不到
     * 回复，只能干等到超时（用户会看到「发成功了但没反应」）。
     *
     * 所以这里要求**真的有回复选择器**；没有就明确拒绝发送，并说清缺什么。
     * 这是「宁可不让发，也不留下抓不到回复的僵尸任务」。
     */
    if (provider?.id !== "deepseek") {
      const rc = provider?.replyCapture;
      const hasReplySelectors = rc?.type === "dom" && Array.isArray(rc.replySelectors) && rc.replySelectors.length > 0;
      if (!hasReplySelectors) {
        throw new Error(`平台「${provider?.name ?? provider?.id ?? "未知"}」还没配好回复抓取选择器（replyCapture.replySelectors 为空），发出去也读不到回复，因此暂不发送。请先在该平台的 provider 配置里补上助手消息的选择器。`);
      }
    }
    // 4) Hook 仅 DeepSeek 可用；其它站点按 provider 声明的 DOM 策略读取。
    await this.ensureHook(provider);

    // 4.5) 压缩 .txt 通道：job.file 存在 ⇒ 先上传附件、等解析完，prompt 已是短指令。
    if (typeof job.file === "string" && job.file !== "") {
      if (this.config.verboseLog) this.log.debug?.(`[edge-driver] .txt 通道：上传 ${job.file}`);
      /**
      * ## 分段上传（2026-10-19 用户点名：「把文件裁成几段发送，设置个多少字节截断」）
      *
      * 大文件（> txtChunkBytes，默认 400KB）切成多片逐片传：
      *   - 片名 partN-ofM（模型知道是连续文档）；
      *   - 每片上传后**点停**（分片不需要 AI 回答，省时间与风控暴露）；
      *   - 首片前发一句「分段说明」正文，让模型知道别急着答；
      *   - 末片替换 job.file 走下面正常「上传→等解析→发指令」流程。
      * 失败即中止——半份文档比没有更糟。
      */
      const txtBytes = await fsp.readFile(job.file);
      const chunkMax = Number(this.config.txtChunkBytes) > 0 ? Number(this.config.txtChunkBytes) : DEFAULT_TXT_CHUNK_BYTES;
      const parts = chunkFileBytes(txtBytes, chunkMax);
      if (parts.length > 1) {
        this.log.info?.(`[edge-driver] .txt 分段：${txtBytes.length} 字节 > ${chunkMax}，切 ${parts.length} 片`);
        const stem = String(job.file).split(/[\\/]/).pop();
        const dir = String(job.file).slice(0, String(job.file).lastIndexOf(stem));
        /** ① 分段说明（正文消息）。 */
        const noteText = `接下来我会分 ${parts.length} 个附件发来同一份文档的连续片段（文件名带 part 编号）。请依次读完所有片段，**先不要回答**——等最后一条指令到了再作答。现在发第 1 片。`;
        const noteFill = JSON.parse(String(await this.evalInPage(buildFillScript(noteText, fillHints), 20000)).catch(() => "{}"));
        if (noteFill.ok === true) {
          await sleep(2000 + Math.floor(Math.random() * 1500));
          await this.evalInPage(buildTriggerScript(triggerHints0(provider), noteText), 20000).catch(() => undefined);
          await sleep(1500);
          await this.evalInPage(buildStopScript({ sendSelectors: provider?.send?.selectors ?? [], vetoes: provider?.send?.vetoes ?? [] }), 12000).catch(() => undefined);
          await sleep(900);
          await this.evalInPage(buildClearInputScript({ inputSelectors: provider?.input?.selectors ?? [] }), 10000).catch(() => undefined);
        }
        /** ② 逐片（除末片）：写盘 → 上传 → 点停 → 清框。 */
        for (let pi = 0; pi < parts.length - 1; pi++) {
          const partName = partFileName(stem, pi, parts.length);
          const partPath = dir + partName;
          await fsp.writeFile(partPath, parts[pi]);
          const upP = await this.uploadFileToPage(partPath, 20000);
          if (upP.ok !== true) {
            const err = new Error(`分片 ${pi + 1}/${parts.length} 上传失败（${upP.stage ?? "?"}）：${upP.message ?? ""}`);
            err.code = "WEBIN_COMPACTION_FILE_FAILED";
            throw err;
          }
          await sleep(2500 + Math.floor(Math.random() * 1500));
          await this.evalInPage(buildStopScript({ sendSelectors: provider?.send?.selectors ?? [], vetoes: provider?.send?.vetoes ?? [] }), 12000).catch(() => undefined);
          await sleep(900);
          await this.evalInPage(buildClearInputScript({ inputSelectors: provider?.input?.selectors ?? [] }), 10000).catch(() => undefined);
          this.log.info?.(`[edge-driver] 分片 ${pi + 1}/${parts.length} 已传（${parts[pi].length} 字节）`);
        }
        /** ③ 末片替换 job.file——走正常流程。 */
        const lastName = partFileName(stem, parts.length - 1, parts.length);
        const lastPath = dir + lastName;
        await fsp.writeFile(lastPath, parts[parts.length - 1]);
        job.file = lastPath;
      }
      const up = await this.uploadFileToPage(job.file, 20000);
      if (up.ok !== true) {
        const err = new Error(`.txt 上传失败（${up.stage ?? "unknown"}）：${up.message ?? "未知"}`);
        err.code = "WEBIN_COMPACTION_FILE_FAILED";
        throw err;
      }
      // 等页面解析完成：附件文件名出现且「上传中/解析中/%」字样消失（上限 120s）。
      /**
      * ⚠️ 名字判据修正（2026-10-19 实测破案）：元宝 UI 显示文件条时
      * **可能不带扩展名**（「input-1792385505513」而非「….txt」）——
      * 老判据 indexOf(全名) 永远等不到 ⇒ 120 秒 parse-timeout
      * （真机 job-1：文件其实已塞入、页面上正在上传，driver 却判「从未出现」）。
      * 修法：**主名（去扩展名）命中**即算出现；上传完成判据照旧
      * （「上传中/解析中/%」全部消失）。
      */
      const fileNameFull = String(job.file).split(/[\\/]/).pop();
      const fileNameStem = fileNameFull.replace(/\.[^.]+$/, "");
      const waitExpr = `(() => {
        var name = ${JSON.stringify(fileNameStem)};
        var fullName = ${JSON.stringify(fileNameFull)};
        var deadline = Date.now() + 120000;
        return new Promise(function (resolve) {
          (function attempt() {
            var text = "";
            try { text = document.body.innerText || ""; } catch (e) {}
            var hasName = text.indexOf(name) !== -1 || text.indexOf(fullName) !== -1;
            var uploading = /(上传中|解析中|正在上传|uploading|\\d+\\s*%)/i.test(text);
            if (hasName && !uploading) { resolve(JSON.stringify({ ok: true })); return; }
            if (Date.now() > deadline) { resolve(JSON.stringify({ ok: false, stage: 'parse-timeout', message: '等文件解析超时（120s）—— 附件名' + (hasName ? '已出现但仍在处理' : '从未出现，可能上传控件没接住文件') })); return; }
            setTimeout(attempt, 800);
          })();
        });
      })()`;
      const waitRaw = await this.evalInPage(waitExpr, 130000);
      const wait = JSON.parse(String(waitRaw));
      if (wait.ok !== true) {
        const err = new Error(`.txt 上传后解析未完成（${wait.stage ?? "unknown"}）：${wait.message ?? ""}`);
        err.code = "WEBIN_COMPACTION_FILE_FAILED";
        throw err;
      }
      if (this.config.verboseLog) this.log.debug?.("[edge-driver] 附件就绪，发送压缩指令");
    }

    // 5) 基线：先读一次，记下现有回复条数（DeepSeek 专用 DOM 抓取）
    let baseline = 0;
    if (provider?.id === "deepseek") {
      try {
        const sc = JSON.parse(String(await this.evalInPage(buildScrapeScript(), 20000)));
        baseline = typeof sc.count === "number" ? sc.count : 0;
      } catch { /* 基线拿不到也不致命 */ }
    }

    // 5) 填字：使用 provider 自己声明的输入选择器。
    const fillHints = { inputSelectors: provider?.input?.selectors ?? [], skipClearBeforeFill: provider?.skipClearBeforeFill === true };
    /** 分段回放用的本地小工具（与主路径同源数据，避免引用后面才定义的变量）。 */
    const lo0 = (v) => Math.max(0, Number(v) || 0);
    const triggerHints0 = (p) => ({
      inputSelectors: p?.input?.selectors ?? [],
      sendSelectors: p?.send?.selectors ?? [],
      signatures: p?.send?.signatures ?? [],
      vetoes: p?.send?.vetoes ?? [],
      enterOnly: p?.send?.enterOnly === true,
    });

    /**
     * ## 思考开关（2026-10-16 接通）
     *
     * `buildThinkingScript` 一直躺在 scripts 里、也被 import 了，但 **runJob
     * 从来没调用它** —— 于是 `ldw-think`（深度思考）在 Edge 驱动器这条路上
     * 静默失效：模型清单里写着「开启思考」，实际页面上的开关根本没动。
     *
     * 现在按 job.thinking 拨一次：
     *   - **只在页面确实有这个开关时才动**（找不到就跳过，不报错）
     *   - **失败不阻断发送** —— 思考是加分项，不是发消息的前提
     *   - 有歧义（多个候选、状态不一致）时脚本自己会拒绝点，这里只记日志
     *
     * ⚠️ 必须在**填字之前**拨：DeepSeek 页面切换思考模式会重渲染输入区，
     * 先填字会被那次重渲染吞掉（触发阶段的 EXPECT 校验会因此报 input-lost）。
     */
    if (job.thinking === true || job.thinking === false) {
      try {
        const th = JSON.parse(String(await this.evalInPage(buildThinkingScript(job.thinking === true), 15000)));
        if (th.ok === true) {
          if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 思考开关已${job.thinking ? "打开" : "关闭"}（${th.text ?? th.aria ?? "?"}）`);
        } else if (this.config.verboseLog) {
          this.log.debug?.(`[edge-driver] 思考开关未拨动（${th.reason ?? "unknown"}）—— 不影响本轮发送`);
        }
      } catch (e) {
        this.log.debug?.(`[edge-driver] 思考开关异常（不影响本轮）: ${String(e?.message ?? e)}`);
      }
    }

    /**
     * ## 页面模式（2026-10-18 第三批）
     *
     * 元宝：Instant / Thinking / Expert 三个模式；豆包：聊天 / 工作。
     * **必须排在模型之前** —— 元宝切模式会重置模型子菜单的选择。
     * 失败不阻断（拿页面当前模式继续发）。
     */
    if (typeof job.pageMode === "string" && job.pageMode !== "") {
      try {
        const mode = await this.applyPageMode(provider, job.pageMode);
        if (this.config.verboseLog && mode.ok !== true) {
          this.log.debug?.("[edge-driver] 模式未拨到 " + job.pageMode + "（" + (mode.reason ?? "?") + "）—— 用当前模式继续");
        }
      } catch (e) {
        this.log.debug?.("[edge-driver] 模式切换异常（不影响发送）: " + String(e?.message ?? e));
      }
    }

    /**
     * ## 页面档位（元宝的「模型选择」）—— 必须在**填字之前**拨
     *
     * 理由与 thinking 开关相同：切换档位会重渲染输入区，先填字会被吞掉。
     * 失败**不阻断**（拿默认档位继续发）。
     */
    if (typeof job.pageModel === "string" && job.pageModel !== "") {
      try {
        const pm = await this.applyPageModel(provider, job.pageModel);
        if (this.config.verboseLog && pm.ok !== true) {
          this.log.debug?.("[edge-driver] 档位未拨到 " + job.pageModel + "（" + (pm.reason ?? "?") + "）—— 用默认档位继续");
        }
      } catch (e) {
        this.log.debug?.("[edge-driver] 档位切换异常（不影响发送）: " + String(e?.message ?? e));
      }
    }

    /**
     * ## 🧹 先关掉挡路的弹窗（2026-10-17 真机：豆包「下载电脑版」）
     *
     * 实测：豆包会在页面上弹一个 `fixed inset-0 backdrop-blur` 的
     * 「下载电脑版 / 下次提醒我」对话框，**盖住整个输入区**。
     * 填字可能进得去，但发送键/回车全被这层吃掉 —— 用户看到的就是
     * 「点了发送没反应」「消息发不出去」。
     *
     * 策略保守：
     *   - 只在**弹窗/遮罩内部**找按钮（不会误点页面上的普通「关闭」）
     *   - 按钮文字必须是我们认识的「稍后再说」这类词
     *   - 点不掉就补一次 Escape
     *   - 全程失败**不阻断**发送（页面上没有弹窗时这里是空操作）
     */
    const dismiss = await this.dismissOverlays();
    if (this.config.verboseLog && dismiss.clicked > 0) {
      this.log.info?.(`[edge-driver] 已关闭 ${dismiss.clicked} 个挡路弹窗：${dismiss.labels.join("、")}`);
    }

    /**
     * ## 5.5) 分段回放（2026-10-18 第三批，用户设计）
     *
     * 「一段发过去，暂停 AI 回复，再发另一段，也行」
     *
     * forceFresh（模式锁定/换模型）⇒ 全量历史要灌进**新对话**。一把全糊
     * 进输入框会超长截断，也像机器人。所以 host 把历史切成几段（replaySegments），
     * 这里逐段：填字 → 发送 → **立刻点停** → 等落定（历史照样进页面上下文），
     * 真正的问题（job.prompt）最后发、正常等完整回复。
     *
     * 每段之间保持与真人一致的随机延迟；任何一段失败都**抛错终止**——
     * 半截历史比没有更糟（模型会当它是全部）。
     */
    if (Array.isArray(job.replaySegments) && job.replaySegments.length > 0) {
      const stopHints = {
        sendSelectors: provider?.send?.selectors ?? [],
        vetoes: provider?.send?.vetoes ?? [],
      };
      for (let i = 0; i < job.replaySegments.length; i++) {
        const seg = String(job.replaySegments[i] ?? "");
        if (seg.trim() === "") continue;
        if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 回放段 ${i + 1}/${job.replaySegments.length}（${seg.length} 字符）`);
        const segFill = JSON.parse(String(await this.evalInPage(buildFillScript(seg, fillHints), 20000)));
        if (segFill.ok !== true) throw new Error(`回放段 ${i + 1} 填入失败：${segFill.message ?? segFill.stage ?? "未知"}`);
        if (segFill.how === "textContent-fallback") await this.fillViaCdp(provider, seg);
        const segDelay = lo0(this.config.sendDelayMinMs) + Math.floor(Math.random() * Math.max(1, lo0(this.config.sendDelayMaxMs) - lo0(this.config.sendDelayMinMs)));
        await sleep(segDelay);
        const segTrig = JSON.parse(String(await this.evalInPage(buildTriggerScript(triggerHints0(provider), seg), 20000)));
        if (segTrig.ok !== true) throw new Error(`回放段 ${i + 1} 发送失败：${segTrig.message ?? segTrig.stage ?? "未知"}`);
        /** 立刻点停——历史段不需要 AI 回复，掐掉节省时间与风控暴露。 */
        await sleep(400 + Math.floor(Math.random() * 600));
        await this.evalInPage(buildStopScript(stopHints), 12000).catch(() => undefined);
        /** 等页面落定（停止按钮回弹、输入框清空）。 */
        await sleep(900 + Math.floor(Math.random() * 700));
        await this.evalInPage(buildClearInputScript({ inputSelectors: provider?.input?.selectors ?? [] }), 10000).catch(() => undefined);
      }
      if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 回放完成（${job.replaySegments.length} 段），发真正的问题`);
    }

    const fill = JSON.parse(String(await this.evalInPage(buildFillScript(prompt, fillHints), 20000)));
    if (fill.ok !== true) {
      throw new Error(`填入输入框失败：${fill.message ?? fill.stage ?? "未知"}`);
    }
    /**
     * ## ⚠️ `textContent-fallback` 对富文本编辑器**等于没填**（2026-10-16 千问实测）
     *
     * 页面侧脚本最后会退到 `el.textContent = value`，并靠「innerText 非空」
     * 报成功。但 Slate / ProseMirror / TipTap 这类**自带文档模型**的编辑器
     * 不认这种直接写 DOM —— 它们的 model 还是空的 ⇒ 发送键点了没反应
     * ⇒ **消息根本没发出去**，而错误会以很误导人的形式出现
     * （「点了发送但输入框没被清空」，或干脆等到超时）。
     *
     * 所以看到这个 how 就**用 CDP 的原生输入重填一遍**（见 `fillViaCdp`）。
     */
    if (fill.how === "textContent-fallback") {
      if (this.config.verboseLog) this.log.debug?.("[edge-driver] 填字走了 textContent 兜底 —— 改用 CDP 原生输入重填（富文本编辑器不认直接写 DOM）");
      await this.fillViaCdp(provider, prompt);
    }
    /**
     * ⚠️⚠️ 填字「成功」**不等于**编辑器认了（2026-10-16 千问实测）。
     *
     * 判据用**发送键的 disabled 状态** —— 那是网站自己依据编辑器 model 定的，
     * 比任何猜测都准。仍禁用就说明 DOM 里有字、model 里没有（Slate/ProseMirror
     * 常见），这时改用 CDP 原生输入重填（`fillViaCdp`）。
     */
    if (fill.how !== "textContent-fallback") {
      const dis = await this.isSendDisabled(provider);
      if (dis === true) {
        if (this.config.verboseLog) this.log.debug?.("[edge-driver] 发送键仍禁用 ⇒ 编辑器没认这次填写，改用 CDP 原生输入重填");
        await this.fillViaCdp(provider, prompt);
      }
    }

    // 6) 真人节奏的随机延迟
    const lo = Math.min(this.config.sendDelayMinMs, this.config.sendDelayMaxMs);
    const hi = Math.max(this.config.sendDelayMinMs, this.config.sendDelayMaxMs);
    const delay = lo + Math.floor(Math.random() * Math.max(1, hi - lo));
    if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 发送前等待 ${delay}ms`);
    await sleep(delay);

    // 7) 点火
    const triggerHints = {
      inputSelectors: provider?.input?.selectors ?? [],
      sendSelectors: provider?.send?.selectors ?? [],
      signatures: provider?.send?.signatures ?? [],
      vetoes: provider?.send?.vetoes ?? [],
      /**
       * ⭐ 强制 Enter 发送（2026-10-16）。
       *
       * 元宝/豆包的发送键不在输入框附近的 DOM 里，附近全是陷阱按钮
       * （添加、切换模型、AI 生图、PPT 生成、录音转写…），几何打分必然误点。
       * 这两站声明 `send.enterOnly = true` ⇒ 直接按 Enter，不碰任何按钮。
       */
      enterOnly: provider?.send?.enterOnly === true,
    };
    /**
     * ## ⭐ 发送前记下「已经有几条助手消息」（2026-10-17 真机事故）
     *
     * 豆包的**用户气泡和 AI 气泡用同一个 `md-box-root` 类**，
     * 「取最后一个」经常取到用户自己刚发的那条 —— 用户实测：
     * 网页里回的是「收到，测试正常 ✔」，DSH 里显示的却是他发的「测试」。
     *
     * 所以发送前先数一下当前匹配数，之后只认**新增的**那条。
     */
    if (provider?.replyCapture?.type === "dom") {
      const cfg = JSON.stringify(provider.replyCapture);
      await this.evalInPage(`(() => { const c=${cfg}; const vis=e=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)); const nodes=[]; for(const q of c.replySelectors||[]){try{for(const e of document.querySelectorAll(q))if(vis(e))nodes.push(e)}catch{}} const unique=[...new Set(nodes)]; window.__ldwReplyBaseline=unique.length; return String(unique.length) })()`, 10000).catch(() => null);
    }
    const trig = JSON.parse(String(await this.evalInPage(buildTriggerScript(triggerHints, prompt), 20000)));
    if (trig.ok !== true) {
      throw new Error(`点击发送失败：${trig.message ?? trig.stage ?? "未知"}`);
    }

    // 8) 等回复（主路径：hook 事件；兜底：DOM 抓取）
    const result = await this.waitForReply(job, baseline, provider);

    // 9) 清空输入框，为下一轮留干净状态
    await this.evalInPage(buildClearInputScript({ inputSelectors: provider?.input?.selectors ?? [] }), 10000).catch(() => undefined);

    /**
     * 10) 会话回收（按 `deleteMode` 分派）。
     *
     * ⚠️ 放在最后、且**失败不影响结果** —— 回收是锦上添花，
     * 绝不能因为它出错就把已经拿到的好回复丢掉。
     *
     * 三种模式：
     *   - `immediate`：本轮结束立刻删（老行为）
     *   - `delay`/`count`：**只记账不删**，然后**搭车**清算一次到期的
     *     —— 页面此刻正开着、且刚验证过登录，是唯一不必额外起浏览器的时机
     */
    if (canManageSessions) {
      try {
        if (deleteMode === "immediate") {
          const removed = await this.purgeNewSessions(provider);
          if (removed > 0) this.log.info?.(`[edge-driver] 已清理 ${removed} 条网页版废对话（immediate）`);
        } else {
          const added = await this.collectNewSessions(provider);
          if (added > 0) this.log.info?.(`[edge-driver] 本轮新建 ${added} 条网页对话已记入待删账本（${deleteMode}）`);
        }
        const flushed = await this.flushSessionDeletions(provider);
        if (flushed > 0) this.log.info?.(`[edge-driver] 账本到期，已回收 ${flushed} 条网页对话（${deleteMode}）`);
      } catch (e) {
        this.log.debug?.(`[edge-driver] 会话回收失败（不影响本轮）: ${String(e?.message ?? e)}`);
      }
    }

    /**
     * 11) 给本轮新建的网页对话打 LDW 标记（2026-10-19 定案重构）。
     *
     * 用户定案：「识别带 LDW 的标签——这样跨设备（电脑记的 ID 手机也能按
     * 前缀删）。如果我已经先删了那么本地副本也不要留。」
     *
     * 双轨：
     *   A. **renameSession**（端点已配且可用）→ 网页标题直接变 `LDW xxx`
     *      ⇒ 手机端/任何设备按前缀都能认、都能删（跨设备主判据）。
     *   B. **账本回填 title**（改名不可用时）→ 把接口原生 `title` 字段记进
     *      账本（listSessions 拿的，不是 DOM 扒的），本机清理时按 id 删；
     *      前缀识别将来抓到 rename 端点后对历史条目补写。
     *
     * 失败静默（renamePath 未实测/接口 404 都只记日志）。
     */
    try {
      const beforeIds = new Set((this._sessionsBefore ?? []).map((s) => s?.id).filter(Boolean));
      const current = await this.listSessions(provider).catch(() => null);
      if (Array.isArray(current) && beforeIds.size > 0) {
        const fresh = current.filter((s) => s?.id && !beforeIds.has(s.id) && s.pinned !== true);
        for (const s of fresh.slice(0, 3)) {
          /** B 轨先记账（无论 A 成败，账本都有 title 便于诊断与补删）。 */
          this._annotateLedgerTitle(provider, s.id, String(s.title ?? ""), fresh.length === 1 && current.length > 0);
          if (!/^LDW\b/i.test(String(s.title ?? ""))) {
            const renamed = await this.renameSession(s.id, `LDW ${String(s.title ?? "").slice(0, 60)}`.trim(), provider);
            if (renamed) {
              if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 已把本轮对话改名为 LDW 前缀（${s.title ?? "?"} → LDW …）`);
              this._annotateLedgerTitle(provider, s.id, "LDW …", true);
            }
          }
        }
      }
    } catch (e) {
      this.log.debug?.(`[edge-driver] LDW 标记失败（不影响本轮）: ${String(e?.message ?? e)}`);
    }

    return result;
  }

  /**
   * 把「本轮新建对话」的 title 回填进待删账本（2026-10-19 双轨 B）。
   *
   * collectNewSessions 记账时只存了 id；这里补 title —— 列表接口原生字段、
   * 非 DOM 扒取。用户在手机端按前缀删、或本机按 id 删，都有据可查。
   * 条目已删（不在账本里）时静默跳过。
   */
  _annotateLedgerTitle(provider, sessionId, title, renamed) {
    try {
      const state = loadPending();
      const key = ledgerKey(provider?.id ?? this.platformId, this.accountId ?? "default");
      const list = state.entries?.[key];
      if (!Array.isArray(list)) return;
      const hit = list.find((e) => e?.id === sessionId);
      if (hit === undefined) return;
      hit.title = String(title ?? "").slice(0, 80);
      if (renamed === true) hit.renamed = true;
      savePending(state);
    } catch {
      /* 账本写不进不影响主流程 */
    }
  }

  // ── 网页版会话管理 ─────────────────────────────────────────

  /**
   * 确保当前页面**落在目标平台的域里**。
   *
   * ## 为什么每个跟页面打交道的方法都要先调它
   *
   * 两个坑：
   *   1. Edge 刚起来时页面是 `about:blank` —— 读 `localStorage` 会抛
   *      `SecurityError: Access is denied for this document`
   *   2. 多平台时页面可能停在**上一个平台**的站点 —— 那时读到的是
   *      别人的 storage、别人的 cookie，会去操作错误的账号
   *
   * 判据用 provider 的 `urlPattern`（webin 原生字段），命中就什么都不做。
   */
  async ensureOnTargetDomain() {
    const provider = this.getProvider(this.platformId);
    let cur = "";
    try { cur = String(await this.evalInPage("location.href", 10000)); } catch { cur = ""; }
    let onTarget = false;
    try {
      onTarget = new RegExp(provider?.urlPattern ?? "chat\\.deepseek\\.com").test(cur);
    } catch {
      onTarget = /chat\.deepseek\.com/.test(cur);
    }
    if (onTarget) return false;
    this.log.debug?.(`[edge-driver] 页面在 ${cur}，导航到目标域`);
    await this.goto(provider?.homeUrl ?? "https://chat.deepseek.com/");
    /** 给首屏 + 登录态恢复一点时间。 */
    await sleep(2500);
    return true;
  }

  /**
   * 列出网页版里的全部对话。
   *
   * 接口（实测）：`GET /api/v0/chat_session/fetch_page?count=50&page=N`
   * 返回 `{data:{biz_data:{chat_sessions:[{id,title,updated_at,pinned}],has_more}}}`
   *
   * ⚠️ 必须在**页面上下文里**发请求（用页面的 fetch + localStorage 里的
   * userToken）—— 这样才能带上完整的浏览器指纹与同源 cookie，
   * 与 webin「不自己伪造请求」的原则一致。
   */
  async listSessions(provider = this.getProvider(this.platformId), maxPages = 10) {
    if (provider?.sessionApi?.list !== true || typeof provider.sessionApi.listPath !== "string" || typeof provider.sessionApi.rowsPath !== "string") {
      throw new Error(`平台 ${provider?.id ?? "?"} 没有经过验证的会话列表接口`);
    }
    /**
     * ⚠️ 必须先确保在目标域里。
     *
     * `localStorage` 是**按源隔离**的：页面停在 `about:blank`（Edge 刚起来
     * 的样子）时读它会抛 `SecurityError: Access is denied for this document`。
     * 而且就算读到了，那也是**别的站**的 storage，不是我们要的。
     */
    await this.ensureOnTargetDomain();
    const expr = `(async () => {
      const cfg = ${JSON.stringify(provider.sessionApi)};
      const out = [];
      let firstStatus = 0;
      for (let page = 0; page < ${Number(maxPages) || 10}; page++) {
        const u = cfg.listPath.replace('{page}', String(page + (cfg.pageBase || 0)));
        const bearer = (() => { try { const t = localStorage.getItem('userToken'); return t ? 'Bearer ' + (JSON.parse(t).value ?? t) : ''; } catch (e) { return ''; } })();
        const r = await fetch(u, { credentials: 'include', headers: { 'Authorization': bearer } });
        if (!r.ok) { firstStatus = r.status; break; }
        const j = await r.json();
        const rows = cfg.rowsPath.split('.').reduce((v,k)=>v?.[k], j);
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const s of rows) out.push({ id: s[cfg.idField || 'id'], title: s[cfg.titleField || 'title'], pinned: s[cfg.pinnedField || 'pinned'] === true });
        const more = cfg.morePath ? cfg.morePath.split('.').reduce((v,k)=>v?.[k], j) : false;
        if (!more) break;
      }
      /**
      * 未登录判据（2026-10-19 用户点名「DeepSeek 没登录也希望清掉机器对话」）：
      * 首屏就 401/403 ⇒ 抛可读错误，而不是静默返回空数组 ——
      * 否则清理按钮会「成功删 0 条」地骗人，用户以为没得删。
      */
      if (out.length === 0 && (firstStatus === 401 || firstStatus === 403)) {
        return JSON.stringify({ __error: '未登录：网页版接口拒绝读取会话列表（HTTP ' + firstStatus + '）。请在 LDW 面板打开该平台的浏览器登录一次，再回来点清理——账本里的机器人对话一条不会少。' });
      }
      return JSON.stringify(out);
    })()`;
    const raw = await this.evalInPage(expr, 60000);
    try {
      const parsed = JSON.parse(String(raw));
      if (parsed !== null && typeof parsed === "object" && Array.isArray(parsed) === false && typeof parsed.__error === "string") {
        throw new Error(parsed.__error);
      }
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      if (e instanceof Error && e.message.includes("未登录")) throw e;
      return [];
    }
  }

  /** 删一条网页对话。只允许 provider 明确声明并配置经过验证的删除接口。 */
  async deleteSession(sessionId, provider = this.getProvider(this.platformId)) {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    if (provider?.sessionApi?.delete !== true || typeof provider.sessionApi.deletePath !== "string") return false;
    await this.ensureOnTargetDomain();
    /**
    * 实测形状（2026-10-20 抓包）：DeepSeek 的删除 body 是
    * {"chat_session_ids":["<uuid>"]} —— 复数**数组**。
    * deleteBodyShape: "ids-array" ⇒ 用 deleteIdsField 包一层数组；
    * 旧形状（单数字符串）仍按 idField 兜底（其它平台未验证前不动）。
    */
    const shape = provider.sessionApi.deleteBodyShape === "ids-array" ? "ids-array" : "single";
    const expr = `(async () => {
      const cfg = ${JSON.stringify(provider.sessionApi)};
      const shape = ${JSON.stringify(shape)};
      const id = ${JSON.stringify(sessionId)};
      const payload = shape === "ids-array"
        ? { [cfg.deleteIdsField || "chat_session_ids"]: [id] }
        : { [cfg.idField || "chat_session_id"]: id };
      const bearer = (() => { try { const t = localStorage.getItem('userToken'); return t ? 'Bearer ' + (JSON.parse(t).value ?? t) : ''; } catch (e) { return ''; } })();
      const r = await fetch(cfg.deletePath, { method: cfg.method || 'POST', headers: { 'content-type': 'application/json', 'Authorization': bearer }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      return String(r.ok && (j?.code === 0 || j?.data?.biz_code === 0 || j?.success === true));
    })()`;
    const ok = await this.evalInPage(expr, 30000).catch(() => false);
    return ok === true || ok === "true";
  }

  /**
   * 清掉**本轮新建**的网页对话（任务开始前后的差集）。
   *
   * ## 安全设计
   *
   *   - 差集 = 现在有、之前没有 ⇒ 只可能是本轮产生的
   *   - 任务开始前的列表没拿到（`_sessionsBefore === null`）时**直接放弃**，
   *     绝不「删最近的 N 条」这种危险策略
   *   - 置顶的一律跳过
   *
   * @returns 实际删掉的条数
   */
  async purgeNewSessions(provider = this.getProvider(this.platformId)) {
    const before = this._sessionsBefore;
    this._sessionsBefore = null;
    if (!Array.isArray(before)) return 0;   // 没有基线 ⇒ 宁可不删，也不误删

    /** 新建的对话可能要过一会儿才出现在列表里。 */
    await sleep(Math.max(0, this.config.sessionDeleteSettleMs));

    const after = await this.listSessions(provider);
    if (!Array.isArray(after) || after.length === 0) return 0;

    const known = new Set(before.map((s) => s?.id).filter(Boolean));
    const fresh = after.filter((s) => s?.id && !known.has(s.id) && s.pinned !== true);
    let removed = 0;
    for (const s of fresh) {
      const ok = await this.deleteSession(s.id, provider);
      if (ok) removed++;
      /** 一条一条来，别把接口打爆。 */
      await sleep(600);
    }
    return removed;
  }

  /**
   * 把**本轮新建**的网页对话记进待删账本（`delay`/`count` 模式用）。
   *
   * 与 `purgeNewSessions` 共用同一套**安全边界**：
   *   - 差集 = 现在有、之前没有 ⇒ 只可能是本轮产生的
   *   - 没有基线（`_sessionsBefore` 不是数组）⇒ **直接放弃**，绝不按「最近 N 条」猜
   *   - 置顶的一律跳过
   *
   * 区别只有一个：**不立刻删**，只登记。真正删除留给
   * `flushSessionDeletions()`，由 `delay` 到期或 `count` 超限触发。
   *
   * @returns 新登记的条数
   */
  async collectNewSessions(provider = this.getProvider(this.platformId)) {
    /**
     * ⚠️ 自己再挡一道模式检查（不只依赖调用方的 `canManageSessions`）。
     *
     * 单测抓到的真问题：`runJob` 里确实用 `canManageSessions` 把 `never`
     * 挡在外面了，但方法**自己被单独调用**时（比如以后新加的入口、
     * 或手动清理接口）就会照记不误 —— `never` 却往待删账本里写东西，
     * 是自相矛盾的状态。安全的东西要在**最靠近数据的地方**再确认一次。
     */
    const mode = resolveMode(this.config);
    if (mode !== "delay" && mode !== "count") return 0;

    const before = this._sessionsBefore;
    this._sessionsBefore = null;
    if (!Array.isArray(before)) return 0;   // 没有基线 ⇒ 宁可不记，也不误记

    /** 新建的对话可能要过一会儿才出现在列表里。 */
    await sleep(Math.max(0, this.config.sessionDeleteSettleMs));

    const after = await this.listSessions(provider);
    if (!Array.isArray(after) || after.length === 0) return 0;

    const known = new Set(before.map((s) => s?.id).filter(Boolean));
    const fresh = after.filter((s) => s?.id && !known.has(s.id) && s.pinned !== true);
    if (fresh.length === 0) return 0;

    const state = loadPending();
    const key = ledgerKey(provider?.id ?? this.platformId, this.accountId ?? "default");
    const added = recordNew(state, key, fresh, Date.now(), resolveDelayMs(this.config));
    if (added > 0) savePending(state);
    return added;
  }

  /**
   * 给一条网页对话改标题（2026-10-18 第三批：机器人对话统一打「LDW 」前缀）。
   *
   * ⚠️ DeepSeek 的改名端点**尚未实测**——renamePath 为空时本方法返回 false，
   * 前缀改名退化为纯账本模式（不影响删除）。端点抓包确认后填入 provider
   * 的 sessionApi.renamePath 即启用。
   */
  async renameSession(sessionId, title, provider = this.getProvider(this.platformId)) {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    const cfg = provider?.sessionApi;
    if (cfg?.rename !== true || typeof cfg.renamePath !== "string" || cfg.renamePath === "") return false;
    await this.ensureOnTargetDomain();
    const expr = `(async () => {
      const cfg = ${JSON.stringify(cfg)};
      const payload = {
        [cfg.idField || 'chat_session_id']: ${JSON.stringify(sessionId)},
        [cfg.renameTitleField || 'title']: ${JSON.stringify(String(title ?? "").slice(0, 80))}
      };
      const bearer = (() => { try { const t = localStorage.getItem('userToken'); return t ? 'Bearer ' + (JSON.parse(t).value ?? t) : ''; } catch (e) { return ''; } })();
      const r = await fetch(cfg.renamePath, { method: cfg.renameMethod || 'POST', headers: { 'content-type': 'application/json', 'Authorization': bearer }, body: JSON.stringify(payload) });
      const j = await r.json().catch(() => ({}));
      return String(r.ok && (j?.code === 0 || j?.data?.biz_code === 0 || j?.success === true));
    })()`;
    const ok = await this.evalInPage(expr, 30000).catch(() => false);
    return ok === true || ok === "true";
  }

  /**
   * ## 按前缀清理（2026-10-18 第三批，用户点名）
   *
   * 「删除旧对话就可以靠识别带 LDW 的标签实现了！这样更好。
   *   如果我已经先删了那么本地副本也不要留。」
   *
   * 与账本互补的第三条删除路径：**标题即标记**。
   *   - 网页列表里所有带 LDW 前缀的（不置顶）→ 删；
   *   - 账本里的条目若已不在网页列表（用户手删过）→ 孤儿，直接从
   *     账本抹掉，本地副本不留。
   *
   * 永远只认前缀——用户自己起名带 LDW 的对话除外（这就是前缀选「LDW 」
   * 这种机器味十足的字串的原因）。
   */
  async purgeByLdwTitle(provider = this.getProvider(this.platformId)) {
    const sessions = await this.listSessions(provider).catch(() => null);
    if (!Array.isArray(sessions) || sessions.length === 0) return { identified: 0, removed: 0, orphans: 0 };
    const liveIds = new Set(sessions.map((s) => s?.id).filter(Boolean));

    /** ① 前缀命中 → 删网页对话。 */
    const targets = pickByLdwTitle(sessions);
    let removed = 0;
    for (const s of targets) {
      const ok = await this.deleteSession(s.id, provider);
      if (ok) removed++;
      await sleep(600);
    }

    /** ② 账本孤儿 → 用户已在网页删掉 → 本地副本一并清。 */
    const state = loadPending();
    const key = ledgerKey(provider?.id ?? this.platformId, this.accountId ?? "default");
    const list = state.entries?.[key];
    let orphans = 0;
    if (Array.isArray(list) && list.length > 0) {
      const gone = list.filter((e) => !liveIds.has(e.id)).map((e) => e.id);
      if (gone.length > 0) {
        orphans = gone.length;
        removeEntries(state, key, gone);
        savePending(state);
      }
    }
    if (this.config.verboseLog) {
      this.log.debug?.(`[edge-driver] 前缀清理：网页删 ${removed} 条，账本孤儿清 ${orphans} 条`);
    }
    return { identified: targets.length, removed, orphans };
  }

  /**
   * 清算账本里到期的条目（`delay` 到期 / `count` 超限）。
   *
   * ## 为什么是「搭车」而不是定时器
   *
   * 删除**必须借浏览器**（会话列表与删除都是页面里的 fetch），
   * 而起浏览器很贵（用户对常驻进程敏感）。所以不新开定时器、也不为删几条
   * 对话专门起 Edge —— 只在**页面已经开着、且刚验证过登录**的时刻顺手清算。
   *
   * 代价：如果之后一直没有新任务，到期的条目会**一直躺着等**。
   * 这是刻意选的偏向 —— 少删几条对话，比多养一个常驻进程好得多；
   * 而且「不急着删」本身就更像真人。
   *
   * @returns 实际删掉的条数
   */
  async flushSessionDeletions(provider = this.getProvider(this.platformId), opts = {}) {
    const mode = resolveMode(this.config);
    /**
     * `opts.force` = 用户点了「立即清理」——**无视策略、把账本里的全删掉**。
     *
     * 不新写一套逻辑：把 mode 当 `count` 且上限传 0，
     * `pickDue` 就会返回账本里的**全部**条目（`list.slice(0, len - 0)`）。
     * 复用同一条删除路径，行为完全一致（含「删失败的留着重试」）。
     */
    if (opts.force !== true && mode !== "delay" && mode !== "count") return 0;

    const state = loadPending();
    const key = ledgerKey(provider?.id ?? this.platformId, this.accountId ?? "default");
    if (pendingCount(state, key) === 0) return 0;

    const due = opts.force === true
      ? pickDue(state, key, { mode: "count", now: Date.now(), max: 0 })
      : pickDue(state, key, { mode, now: Date.now(), max: resolveMax(this.config) });
    if (due.length === 0) return 0;

    const gone = [];
    for (const e of due) {
      const ok = await this.deleteSession(e.id, provider);
      if (ok) gone.push(e.id);
      /** 一条一条来，别把接口打爆（与 purgeNewSessions 同一节奏）。 */
      await sleep(600);
    }
    /**
     * ⚠️ 只从账本里移除**确实删成功**的：
     * 删除失败的留着，下次再试 —— 否则一次网络抖动就永久漏一条。
     */
    if (gone.length > 0) {
      removeEntries(state, key, gone);
      savePending(state);
    }
    if (this.config.verboseLog) {
      this.log.debug?.(`[edge-driver] 会话回收（${mode}）：到期 ${due.length}，成功 ${gone.length}，账本剩 ${pendingCount(state, key)}`);
    }
    return gone.length;
  }

  /** 账本现状（给 /status 看，不泄露标题以外的东西）。 */
  sessionLedgerStatus(platformId = this.platformId) {
    const state = loadPending();
    const key = ledgerKey(platformId, this.accountId ?? "default");
    return {
      policy: describePolicy(this.config),
      key,
      pending: pendingCount(state, key),
      path: pendingPath(),
    };
  }

  /** 轮询等回复：优先读 hook 事件队列，其次读 DOM。 */
  async waitForReply(job, baseline, provider = this.getProvider(this.platformId)) {
    const t0 = Date.now();
    const limit = this.config.replyTimeoutMs;
    let lastText = "";
    let stable = 0;
    let lastThink = "";

    const drainExpr = `(() => {
  const M = '__dshWebinHookInstalled__';
  const evs = window[M + '_events'] || [];
  let text = '', think = '', finished = false, status = '';
  for (const e of evs) {
    const d = e && e.detail ? e.detail : null;
    if (!d) continue;
    if (typeof d.text === 'string' && d.text !== '') text = d.text;
    if (typeof d.think === 'string' && d.think !== '') think = d.think;
    if (d.finished === true) finished = true;
    if (typeof d.status === 'string' && d.status !== '') status = d.status;
  }
  return JSON.stringify({ text, think, finished, status, count: evs.length });
})()`;

    while (Date.now() - t0 < limit) {
      /**
       * ## ⭐ 用户按「停止」也要真的停下来（2026-10-17 真机：中止按钮像没反应）
       *
       * 原来这里只看 `this.stopping` —— 那是**插件卸载 / 驱动停用**时才会置位的，
       * 用户点 DSH 的停止按钮根本改不到它。于是：
       *
       *   - DSH 那一轮被判定「用户停止」结束
       *   - 但浏览器里的网页**还在继续生成**，驱动也还在傻等
       *   - 用户看到的就是「点了停止没反应」
       *
       * 用户停止时 `queue.cancel()` 会把 `job.cancelled` 置 true，
       * 而 runJob 拿到的就是同一个 job 对象 —— 直接读它即可。
       */
      if (this.stopping || job?.cancelled === true) {
        // 停止按钮同样是站点私有能力；只执行明确声明的选择器。
        const stopSelector = provider?.send?.stopSelector;
        if (typeof stopSelector === "string" && stopSelector !== "") {
          const expr = `(() => { const e=document.querySelector(${JSON.stringify(stopSelector)}); if(!e||e.disabled||e.getAttribute('aria-disabled')==='true')return false; e.click(); return true })()`;
          await this.evalInPage(expr, 10000).catch(() => false);
        }
        throw new Error("任务已取消（用户停止）");
      }
      await sleep(1500);

      let drained = null;
      let text = "";
      let think = "";
      let finished = false;

      if (provider?.id === "deepseek") {
        try { drained = JSON.parse(String(await this.evalInPage(drainExpr, 15000))); } catch { /* 继续 */ }
        text = drained?.text ?? "";
        think = drained?.think ?? "";
        finished = drained?.finished === true;
        if (text === "") {
          try {
            const sc = JSON.parse(String(await this.evalInPage(buildScrapeScript(), 20000)));
            if (typeof sc.last === "string" && sc.last !== "") text = sc.last;
            if (typeof sc.think === "string" && sc.think !== "") think = sc.think;
          } catch { /* 忽略 */ }
        }
      } else if (provider?.replyCapture?.type === "dom") {
        const cfg = JSON.stringify(provider.replyCapture);
        const expr = `(() => {
  const c=${cfg};
  const vis=e=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const nodes=[];
  for(const q of c.replySelectors||[]){try{for(const e of document.querySelectorAll(q))if(vis(e))nodes.push(e)}catch{}}
  /** 排掉用户自己的气泡（声明了 replyExcludeSelectors 的平台）。 */
  const excluded = el => (c.replyExcludeSelectors||[]).some(q=>{try{return el.closest(q)!==null}catch{return false}});
  const unique=[...new Set(nodes)].filter(e=>!excluded(e));
  /**
   * 只认**发送之后新出现的**节点：发送前记了基线条数，
   * 否则会把「上一条 AI 回复」甚至「用户自己刚发的那条」当成回复。
   */
  const base = Number(window.__ldwReplyBaseline||0);
  const fresh = unique.length > base ? unique.slice(base) : (base === 0 ? unique : []);
  const e = fresh.at(-1);
  const text = e ? String(e.innerText||e.textContent||'').trim() : '';
  const stop=(c.stopSelectors||[]).some(q=>{try{return [...document.querySelectorAll(q)].some(vis)}catch{return false}});
  return JSON.stringify({text,finished:text!==''&&!stop,via:'dom',fresh:fresh.length,base,url:location.href})
})()`;
        try { drained = JSON.parse(String(await this.evalInPage(expr, 15000))); text = drained.text ?? ""; finished = drained.finished === true; } catch { /* 继续 */ }
      }

      const chatUrl = String(await this.evalInPage("location.href", 8000).catch(() => ""));

      // 登录页守卫：DeepSeek 旧判据按 URL；其它 provider 可声明登录页选择器。
      const authUiSelector = provider?.authProbe?.loggedOutSelectors?.join(",") ?? "";
      const isLoginUi = provider?.id === "deepseek"
        ? /sign[_-]?in|sign[_-]?up|\/login/i.test(chatUrl)
        : (authUiSelector !== "" && await this.evalInPage(`(() => { const q=${JSON.stringify(authUiSelector)}; try{return [...document.querySelectorAll(q)].some(e=>e.offsetWidth||e.offsetHeight)}catch{return false} })()`, 5000).catch(() => false)) === true;
      if (isLoginUi) {
        const err = new Error(`LDW 页面已掉线到登录页（${chatUrl}），本轮回复不可信。`);
        err.code = "WEBIN_NOT_LOGGED_IN";
        throw err;
      }

      const waited = Date.now() - t0;
      if (text !== "" && text === lastText && finished === true) {
        stable++;
        if (stable >= 2) {
          return { text, think: think || lastThink, status: "finished", chatUrl, via: drained?.text ? "hook" : "dom" };
        }
      } else {
        stable = 0;
      }
      if (provider?.id !== "deepseek" && drained?.via === "dom" && text !== "" && text === lastText && finished === true) {
        stable++;
        if (stable >= 3) return { text, think: think || lastThink, status: "finished", chatUrl, via: "dom" };
      }
      if (text !== "" && text === lastText && waited > 15000 && finished !== false) {
        stable++;
        if (stable >= 3) {
          return { text, think: think || lastThink, status: "finished", chatUrl, via: drained?.text ? "hook" : "dom" };
        }
      } else if (text !== lastText) {
        stable = 0;
      }
      lastText = text;
      if (think !== "") lastThink = think;

      if (this.config.verboseLog && text !== "") {
        this.log.debug?.(`[edge-driver] 等回复 ${Math.round(waited / 1000)}s chars=${text.length} finished=${finished}`);
      }
    }
    throw new Error(`等待网页回复超时（${Math.round(limit / 1000)} 秒）。`);
  }

  // ── 领活循环 ───────────────────────────────────────────────

  /**
   * 启动领活循环。
   * @param {object} api - { claimNext(platform, sessionId, running), settle(id, result), shouldCancel(jobId) }
   */
  startLoop(api) {
    if (this.loopTimer !== null) return;
    this.stopping = false;
    this.api = api;
    const tick = async () => {
      if (this.busy || this.stopping) return;
      try {
        await this.ensureEdge();
        const provider = this.getProvider(this.platformId ?? "deepseek") ?? this.getProvider("deepseek");
        const job = await api.claimNext(this.platformId ?? "deepseek", undefined, this.pending?.jobId);
        if (job === undefined || job === null) { this.touchIdle(); return; }

        this.busy = true;
        this.pending = { jobId: job.id, startedAt: Date.now() };
        this.stats.claimed++;
        this.log.info?.(`[edge-driver] 领到任务 ${job.id}（${String(job.prompt ?? "").length} 字符）`);

        try {
          const r = await this.runJob(job, provider);
          await api.settle(job.id, {
            text: r.text, think: r.think, status: r.status,
            ...(r.chatUrl === "" ? {} : { chatUrl: r.chatUrl }),
          });
          this.stats.done++;
          this.log.info?.(`[edge-driver] 任务 ${job.id} 完成（${r.text.length} 字符，via ${r.via}）`);
        } catch (e) {
          this.stats.failed++;
          const msg = String(e?.message ?? e);
          this.log.warn?.(`[edge-driver] 任务 ${job.id} 失败: ${msg}`);
          await api.settle(job.id, { error: msg });
        } finally {
          this.busy = false;
          this.pending = null;
          this.lastJobAt = Date.now();
          this.touchIdle();
        }
      } catch (e) {
        if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 循环异常: ${String(e?.message ?? e)}`);
      }
    };
    this.loopTimer = setInterval(() => void tick(), Math.max(500, this.config.pollIntervalMs));
    void tick();
  }

  stopLoop() {
    this.stopping = true;
    if (this.loopTimer !== null) { clearInterval(this.loopTimer); this.loopTimer = null; }
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  /** 重置空闲计时器：到点就关掉 Edge 省内存。 */
  touchIdle() {
    if (this.idleTimer !== null) { clearTimeout(this.idleTimer); this.idleTimer = null; }
    const ms = this.config.idleShutdownMs;
    if (!(ms > 0) || this.busy) return;
    this.idleTimer = setTimeout(() => {
      if (this.busy) return;
      void this.shutdownEdge("空闲超时");
    }, ms);
  }

  // ── 端口归属标记（防「复用错 profile」）──────────────────────
  //
  // 背景见 `ensureEdge()` 里那段长注释：DSH 被强杀后 Edge 会成为孤儿，
  // 而新 driver 关不掉它、只会「复用」，于是后续平台全在用错 profile。
  // 这里用一份小标记文件回答「这个端口上的 Edge 是谁的」。

  /** 归属标记文件路径：`<DSH_HOME>/webin/edge-owner/<端口>.json`。 */
  edgeOwnerPath(port) {
    return join(dshHome(), "webin", "edge-owner", `${port}.json`);
  }

  /** 读归属标记；不存在或坏了都返回 null（= 无法确认归属，按「不是我们的」处理）。 */
  readEdgeOwner(port) {
    try {
      const p = this.edgeOwnerPath(port);
      if (!existsSync(p)) return null;
      const j = JSON.parse(readFileSync(p, "utf8"));
      return j !== null && typeof j === "object" ? j : null;
    } catch {
      return null;
    }
  }

  /** spawn 成功后写下归属标记。 */
  writeEdgeOwner(port, info) {
    try {
      const p = this.edgeOwnerPath(port);
      mkdirSync(dirname(p), { recursive: true });
      writeFileSync(p, `${JSON.stringify({ ...info, at: Date.now() }, null, 2)}\n`, "utf8");
    } catch { /* 写不下不影响功能，只是下次会保守地关掉重开 */ }
  }

  clearEdgeOwner(port) {
    try { unlinkSync(this.edgeOwnerPath(port)); } catch { /* 本来就没有 */ }
  }

  /**
   * 关掉**占着某端口的** Edge —— 不依赖「我们自己有没有连接」。
   *
   * 这是修「孤儿 Edge 占坑」的关键能力：`shutdownEdge()` 在
   * `conn === null && proc === null`（新 driver、DSH 刚重启）时会直接放弃，
   * 而那时恰恰最需要把上一个进程留下的 Edge 关掉。
   *
   * 走 CDP 的 browser 级 `Browser.close`（优雅退出 → 会写盘，登录态不丢），
   * 全程只需要 `fetch` + WebSocket，不需要枚举进程
   * （沙箱下 `execSync` 走管道会 EPERM，所以不依赖它）。
   */
  async closeEdgeOnPort(port) {
    try {
      const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
      const url = v?.webSocketDebuggerUrl;
      if (typeof url !== "string" || url === "") return false;
      const conn = await CdpConnection.connect(url, 5000);
      await conn.send("Browser.close", {}, 5000).catch(() => undefined);
      conn.close();
      return true;
    } catch {
      return false;
    }
  }

  /** 正常关掉 Edge（走 CDP Browser.close，让 Edge 写盘 → 登录态不丢）。 */
  async shutdownEdge(reason = "") {
    /** 归属标记跟着一起清掉 —— 留着会误导下一次的复用判断。 */
    if (this._port !== null) this.clearEdgeOwner(this._port);
    if (this.conn === null && this.proc === null) return false;
    this.log.info?.(`[edge-driver] 关闭 Edge${reason === "" ? "" : `（${reason}）`}`);
    try {
      if (this.conn !== null && this.conn.closed === false) {
        // 用 browser 级 WebSocket 发 Browser.close
        const port = this._port ?? this.config.port;
        const v = await (await fetch(`http://127.0.0.1:${port}/json/version`)).json();
        if (v?.webSocketDebuggerUrl) {
          const bconn = await CdpConnection.connect(v.webSocketDebuggerUrl, 5000);
          await bconn.send("Browser.close", {}, 5000).catch(() => undefined);
          bconn.close();
        }
      }
    } catch { /* 端口已经没了也无所谓 */ }
    this.conn?.close();
    this.conn = null;
    this.proc = null;
    this._targetUrl = null;
    return true;
  }
}

export default EdgeDriver;
