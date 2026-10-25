/**
 * auto-keepalive.mjs 的插件钩子版（2026-10-21）：
 * 用户点名「自动维护登录凭证的怎么弄」——把它接进 DSH 插件（session-kit 侧常驻）。
 *
 * 逻辑：
 *   - 每隔 autoKeepaliveMinutes（默认 360=6 小时）跑一次：
 *     提取（借用 profiles/ 持久登录态，无需人工）→ 读 tokens → PUT /credentials → POST /credentials/inject
 *   - 只对已登录过的槽位做（未登录的不硬注入）
 *   - 插件卸载时清理定时器
 */
export const autoKeepaliveCron = {
  timer: null,
  running: false,
};

/** 主流程（复用 auto-keepalive.mjs 的核心三步）。 */
export async function runKeepalive(deps = {}) {
  const { execFileSync } = await import("node:child_process");
  const { readFileSync, existsSync } = await import("node:fs");
  const TOK_DIR = deps.tokDir ?? "C:/Users/Evelyn/Desktop/肖浩成/信息技术/Toekn管理";
  const API = deps.apiBase ?? "http://127.0.0.1:3080/dsh-webin/api";
  const files = ["deepseek#cai-deepseek", "yuanbao#cai-yuanbao", "yuanbao#cai-yuanbao-tel", "doubao#cai-doubao", "doubao#evelyn-doubao", "yuanbao#evelyn-yuanbao", "yuanbao#evelyn-yuanbao-tel"];
  const results = [];

  // ① 脚本提取（借用 profiles/ 持久登录态——无需人工）。
  try {
    execFileSync("python", [`${TOK_DIR}/多平台令牌.py`, "提取"], {
      encoding: "utf8",
      cwd: TOK_DIR,
      timeout: 300_000,
      stdio: "pipe",
    });
  } catch (e) {
    // 交互式脚本可能吞 stdin——静默重试由下轮做，本轮继续走旧 tokens。
    deps.logger?.warn?.(`auto-keepalive: 提取脚本退出（${String(e?.message ?? e).slice(0, 80)}）——沿用已有导出文件`);
  }

  // ② 逐平台注入。
  for (const f of files) {
    const p = `${TOK_DIR}/tokens/${f}.txt`;
    if (!existsSync(p)) continue;
    const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(l => l.trim() !== "");
    if (lines.length === 0) continue;
    const first = lines[0];
    const firstIsCookie = /[;=]/.test(first) && !first.startsWith("{");
    const token = firstIsCookie ? "" : first;
    const cookie = firstIsCookie ? lines.join("; ") : lines.slice(1).join("; ");
    const [platform, slot] = f.split("#");
    try {
      await fetch(`${API}/credentials`, {
        method: "PUT",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, slot, token, cookie }),
      });
      const inj = await fetch(`${API}/credentials/inject`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ platform, slot }),
      }).then(r => r.json());
      results.push({ f, loggedIn: inj.loggedIn === true });
    } catch (e) {
      results.push({ f, loggedIn: false, error: String(e?.message ?? e).slice(0, 80) });
    }
  }
  return results;
}

/** 装载定时循环（cordis effect 内调用，返回清理函数）。 */
export function startKeepaliveLoop({ intervalMinutes = 360, logger } = {}) {
  const ms = Math.max(30, Number(intervalMinutes) || 360) * 60_000;
  const tick = async () => {
    if (autoKeepaliveCron.running) return;
    autoKeepaliveCron.running = true;
    try {
      const results = await runKeepalive({ logger });
      const ok = results.filter(r => r.loggedIn === true).length;
      logger?.info?.(`auto-keepalive: 注入完成 ${ok}/${results.length} 已登录`);
    } catch (e) {
      logger?.warn?.(`auto-keepalive: 轮失败（${String(e?.message ?? e).slice(0, 100)}）`);
    } finally {
      autoKeepaliveCron.running = false;
    }
  };
  autoKeepaliveCron.timer = setInterval(() => void tick(), ms);
  autoKeepaliveCron.timer.unref?.();
  return () => {
    if (autoKeepaliveCron.timer !== null) clearInterval(autoKeepaliveCron.timer);
    autoKeepaliveCron.timer = null;
  };
}
