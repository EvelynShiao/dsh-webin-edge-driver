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
import { existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
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
  pickDue,
  recordNew,
  removeEntries,
  resolveDelayMs,
  resolveMax,
  resolveMode,
  savePending,
} from "./session-gc.js";

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

const EDGE_CANDIDATES = [
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

// ─────────────────────────────────────────────────────────────
// 小工具
// ─────────────────────────────────────────────────────────────

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function dshHome() {
  return process.env.DSH_HOME ?? join(homedir(), ".dsh");
}

function resolveEdgePath(configured) {
  if (typeof configured === "string" && configured.trim() !== "" && existsSync(configured)) return configured;
  for (const p of EDGE_CANDIDATES) if (existsSync(p)) return p;
  return "";
}

function resolveUserDataDir(configured) {
  if (typeof configured === "string" && configured.trim() !== "") return configured;
  return join(dshHome(), "edge-ldw");
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
    this.accountId = typeof accountId === "string" && accountId !== "" ? accountId : (this.accountId ?? "default");
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
      this.log.info?.(`[edge-driver] 端口 ${port} 已有 Edge 实例，直接复用（不重复启动）`);
      this._port = port;
      await this.attach();
      if (this.config.hideWindow === true) await this.setWindowVisible(true);
      this.touchIdle();
      return this;
    }

    const exe = resolveEdgePath(this.config.executable);
    if (exe === "") throw new Error("找不到 msedge.exe —— 请在配置里填 executable");

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
      "--disable-features=Translate,msEdgeIdentityFeature,msEdgeSidebarFeature,EdgeCollections",
      "--disk-cache-size=52428800",
      "--window-size=1100,820",
      ...(this.config.hideWindow === true ? ["--window-position=-24000,-24000"] : []),
      "about:blank",
    ];
    this.log.info?.(`[edge-driver] 启动真 Edge: platform=${this.platformId} port=${port} profile=${dir} hide=${this.config.hideWindow === true}`);
    // ⚠️ 沙箱下必须 stdio:'ignore'（走管道会 EPERM）；detached + unref 让 Edge 独立存活。
    const proc = spawn(exe, args, { detached: true, stdio: "ignore", windowsHide: false });
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
      const r = await fetch(`http://127.0.0.1:${p}/json/version`);
      return r.ok === true;
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
    const safePlatform = String(platformId).replace(/[^A-Za-z0-9_-]/g, "_");
    const safeAccount = String(accountId || "default").replace(/[^A-Za-z0-9_-]/g, "_").slice(0, 48);
    /** default（含空值）= 旧布局，**不**拼账号层 —— 见上方长注释。 */
    if (safeAccount === "" || safeAccount === "default") return join(base, safePlatform);
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
    const findExpr = `(() => {
      const inputs = [...document.querySelectorAll('input[type=file]')];
      const visible = (e) => !!(e && (e.offsetWidth || e.offsetHeight || e.getClientRects().length));
      const el = inputs.find(visible) ?? inputs[0];
      if (!el) return JSON.stringify({ ok: false, stage: 'no-file-input', message: '页面上没有 input[type=file] —— 可能还没登录或页面结构变了' });
      return JSON.stringify({ ok: true });
    })()`;
    const probe = JSON.parse(String(await this.evalInPage(findExpr, 10000)));
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
    if (canManageSessions) {
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
      const up = await this.uploadFileToPage(job.file, 20000);
      if (up.ok !== true) {
        const err = new Error(`.txt 上传失败（${up.stage ?? "unknown"}）：${up.message ?? "未知"}`);
        err.code = "WEBIN_COMPACTION_FILE_FAILED";
        throw err;
      }
      // 等页面解析完成：附件文件名出现且「上传中/解析中/%」字样消失（上限 120s）。
      const fileName = String(job.file).split(/[\\/]/).pop();
      const waitExpr = `(() => {
        var name = ${JSON.stringify(fileName)};
        var deadline = Date.now() + 120000;
        return new Promise(function (resolve) {
          (function attempt() {
            var text = "";
            try { text = document.body.innerText || ""; } catch (e) {}
            var hasName = text.indexOf(name) !== -1;
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
    const fillHints = { inputSelectors: provider?.input?.selectors ?? [] };

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

    const fill = JSON.parse(String(await this.evalInPage(buildFillScript(prompt, fillHints), 20000)));
    if (fill.ok !== true) {
      throw new Error(`填入输入框失败：${fill.message ?? fill.stage ?? "未知"}`);
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

    return result;
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
      for (let page = 0; page < ${Number(maxPages) || 10}; page++) {
        const u = cfg.listPath.replace('{page}', String(page + (cfg.pageBase || 0)));
        const r = await fetch(u, { credentials: 'include' });
        if (!r.ok) break;
        const j = await r.json();
        const rows = cfg.rowsPath.split('.').reduce((v,k)=>v?.[k], j);
        if (!Array.isArray(rows) || rows.length === 0) break;
        for (const s of rows) out.push({ id: s[cfg.idField || 'id'], title: s[cfg.titleField || 'title'], pinned: s[cfg.pinnedField || 'pinned'] === true });
        const more = cfg.morePath ? cfg.morePath.split('.').reduce((v,k)=>v?.[k], j) : false;
        if (!more) break;
      }
      return JSON.stringify(out);
    })()`;
    const raw = await this.evalInPage(expr, 60000);
    try { return JSON.parse(String(raw)); } catch { return []; }
  }

  /** 删一条网页对话。只允许 provider 明确声明并配置经过验证的删除接口。 */
  async deleteSession(sessionId, provider = this.getProvider(this.platformId)) {
    if (typeof sessionId !== "string" || sessionId === "") return false;
    if (provider?.sessionApi?.delete !== true || typeof provider.sessionApi.deletePath !== "string") return false;
    await this.ensureOnTargetDomain();
    const expr = `(async () => {
      const cfg = ${JSON.stringify(provider.sessionApi)};
      const payload = { [cfg.idField || 'chat_session_id']: ${JSON.stringify(sessionId)} };
      const r = await fetch(cfg.deletePath, { method: cfg.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });
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
  async flushSessionDeletions(provider = this.getProvider(this.platformId)) {
    const mode = resolveMode(this.config);
    if (mode !== "delay" && mode !== "count") return 0;

    const state = loadPending();
    const key = ledgerKey(provider?.id ?? this.platformId, this.accountId ?? "default");
    if (pendingCount(state, key) === 0) return 0;

    const due = pickDue(state, key, { mode, now: Date.now(), max: resolveMax(this.config) });
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
      if (this.stopping) {
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
        const expr = `(() => { const c=${cfg}; const vis=e=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)); const nodes=[]; for(const q of c.replySelectors||[]){try{for(const e of document.querySelectorAll(q))if(vis(e))nodes.push(e)}catch{}} const unique=[...new Set(nodes)]; const e=unique.at(-1); const text=e?String(e.innerText||e.textContent||'').trim():''; const stop=(c.stopSelectors||[]).some(q=>{try{return [...document.querySelectorAll(q)].some(vis)}catch{return false}}); return JSON.stringify({text,finished:text!==''&&!stop,via:'dom',url:location.href}) })()`;
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

  /** 正常关掉 Edge（走 CDP Browser.close，让 Edge 写盘 → 登录态不丢）。 */
  async shutdownEdge(reason = "") {
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
