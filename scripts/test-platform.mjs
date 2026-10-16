/**
 * 单平台**端到端**诊断：真发一条消息、真等回复。
 *
 *   node scripts/test-platform.mjs yuanbao
 *   node scripts/test-platform.mjs all          # 四个平台依次跑
 *
 * ## 为什么需要它
 *
 * 「只有 DeepSeek 能用、其他都不行」这种报障，靠读代码猜不出来 ——
 * 四个平台的差别在选择器、发送方式（Enter vs 按钮）、回复容器上，
 * 必须**真跑一遍**才知道卡在哪一步。
 *
 * ## 关键：复用**真实**平台配置
 *
 * 直接从 `lib/index.js` 导入 `BUILTIN_PROVIDERS`，不手抄。
 * 手抄的选择器一旦和真配置漂移，就会出现「测试通过但线上不行」。
 *
 * ## ⚠️ 它会用真 profile、真浏览器
 *
 * - 用真实的 `edge-ldw/<平台>` profile（也就是你已登录的那个身份）
 * - 端口沿用配置里的 9411；若已有 Edge 在跑会**复用/切换**（与插件行为一致）
 * - 只发一句「你好」，**不删任何会话**（`autoDeleteSessions` 关掉）
 *
 * 所以它是只读诊断 + 一条无害的测试消息，不会动你的数据。
 */
import { EDGE_DRIVER_DEFAULTS, EdgeDriver } from "../lib/edge-driver.js";
import { BUILTIN_PROVIDERS } from "../lib/index.js";

const which = (process.argv[2] ?? "all").trim();
const targets = which === "all"
  ? ["deepseek", "yuanbao", "qwen", "doubao"]
  : [which];

const providerOf = (id) => BUILTIN_PROVIDERS.find((p) => p.id === id);

const logs = [];
const driver = new EdgeDriver({
  config: {
    ...EDGE_DRIVER_DEFAULTS,
    enabled: true,
    /** 与真配置一致（config.json 里是 9411），否则会另起一个 Edge 抢 profile。 */
    port: 9411,
    hideWindow: true,
    /** ⚠️ 诊断脚本绝不删会话。 */
    autoDeleteSessions: false,
    sessionDeleteMode: "never",
    verboseLog: true,
    replyTimeoutMs: 180000,
    idleShutdownMs: 60000,
  },
  log: {
    info: (m) => logs.push(`INFO ${m}`),
    warn: (m) => logs.push(`WARN ${m}`),
    debug: (m) => logs.push(`DBG  ${m}`),
    error: (m) => logs.push(`ERR  ${m}`),
  },
  getProvider: (id) => providerOf(id),
});

const results = [];

for (const id of targets) {
  const provider = providerOf(id);
  if (provider === undefined) {
    console.log(`\n❌ 没有这个平台：${id}（可选：${BUILTIN_PROVIDERS.map((p) => p.id).join(", ")}）`);
    continue;
  }
  console.log(`\n${"=".repeat(70)}\n▶ ${id}　${provider.name}\n${"=".repeat(70)}`);
  const t0 = Date.now();
  try {
    /**
     * ⚠️⚠️ **必须先 ensureEdge**（2026-10-16 脚本踩到的坑）。
     *
     * `runJob()` **不负责起浏览器** —— 那是 host 领活循环的活
     * （`index.js` 的 tick 里 `ensureEdge()` 之后才 `claimNext()` + `runJob()`）。
     * 直接调 runJob 会让 `this.platformId` 仍是 undefined ⇒ 用
     * `edge-ldw/unknown` 这个**空 profile** 起 Edge ⇒ 所有平台都「未登录」。
     *
     * 我第一版脚本就漏了这一步，于是得到「四个平台全挂」的假结论。
     */
    await driver.ensureEdge(id, "default");
    const job = {
      id: `diag-${id}-${Date.now()}`,
      platform: id,
      account: "default",
      prompt: "请只回复两个字：收到",
      freshChat: true,
    };
    const r = await driver.runJob(job, provider);
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const okText = typeof r?.text === "string" && r.text.trim() !== "";
    console.log(`  ${okText ? "✅" : "⚠️"} 完成（${secs}s）via=${r?.via} status=${r?.status}`);
    console.log(`  回复：${JSON.stringify(String(r?.text ?? "").slice(0, 120))}`);
    if (r?.think) console.log(`  思考：${JSON.stringify(String(r.think).slice(0, 80))}`);
    results.push({ id, ok: okText, secs, via: r?.via, text: String(r?.text ?? "").slice(0, 60) });
  } catch (e) {
    const secs = ((Date.now() - t0) / 1000).toFixed(1);
    const msg = String(e?.message ?? e);
    console.log(`  ❌ 失败（${secs}s）：${msg.slice(0, 400)}`);
    if (e?.code) console.log(`     code=${e.code}`);
    results.push({ id, ok: false, secs, error: msg.slice(0, 200) });
  }
}

// ── 汇总 ────────────────────────────────────────────────────
console.log(`\n${"=".repeat(70)}\n汇总\n${"=".repeat(70)}`);
for (const r of results) {
  console.log(`  ${r.ok ? "✅" : "❌"} ${String(r.id).padEnd(10)} ${String(r.secs).padStart(6)}s  ${r.ok ? `via=${r.via}　${JSON.stringify(r.text)}` : r.error}`);
}

console.log(`\n${"=".repeat(70)}\n相关日志（尾部 40 条，已滤掉高频噪音）\n${"=".repeat(70)}`);
const noisy = /等回复 \d+s chars=/;
for (const l of logs.filter((x) => !noisy.test(x)).slice(-40)) console.log(`  ${l.slice(0, 190)}`);

/** 收尾：关掉 Edge（诊断脚本不该占着资源）。 */
try { await driver.shutdownEdge("诊断结束"); } catch { /* 忽略 */ }
console.log("\n（已关闭诊断用的 Edge）\n");
