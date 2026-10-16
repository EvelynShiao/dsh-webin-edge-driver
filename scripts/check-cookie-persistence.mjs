/**
 * 直接查浏览器内存里的 cookie 属性：注入的到底是**持久 cookie** 还是**会话 cookie**？
 *
 * 为什么要这么查：磁盘上的 cookie 库在 Edge 运行期间读不到（独占锁），
 * 强杀进程又不会刷盘 —— 所以「读磁盘」这个测法本身不可靠。
 * 唯一干净的判据是问浏览器自己：`Network.getCookies` 返回的每个 cookie
 * 都带 `session` 与 `expires` 字段。
 *
 *   session === true   → 会话 cookie（关掉浏览器就丢）✗
 *   session === false  → 持久 cookie，expires 是到期时间戳 ✓
 */
const API = "http://127.0.0.1:3080/dsh-webin/api";
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SLOT = process.argv[2] ?? "验证号";
const PLATFORM = "deepseek";

// ── 1. 触发一次注入（顺便确保 Edge 在这个 profile 上跑起来）──
console.log(`① 注入 ${PLATFORM}#${SLOT} …`);
const inj = await (await fetch(`${API}/credentials/inject`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ platform: PLATFORM, slot: SLOT }),
})).json();
console.log(`   loggedIn=${inj.loggedIn}  cookieSet=${inj.cookieSet}  ${inj.detail ?? ""}`);
if (inj.loggedIn !== true) { console.log("   ⚠️ 注入没成功，下面看到的可能是登录页状态"); }

// ── 2. 连 CDP，问浏览器要 cookie ─────────────────────────────
console.log("\n② 连 CDP 读**内存里**的 cookie 属性 …");
let ws = null;
let page = null;
for (let i = 0; i < 40; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
    page = list.find((t) => t.type === "page" && /deepseek/.test(t.url)) ?? list.find((t) => t.type === "page");
    if (page) break;
  } catch { /* 端口还没起来 */ }
  await sleep(400);
}
if (!page) { console.log("   ❌ 连不上 CDP（Edge 没在跑？）"); process.exit(1); }

ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});

await send("Network.enable");
const r = await send("Network.getCookies", { urls: ["https://chat.deepseek.com/"] });
const cookies = r?.result?.cookies ?? [];
console.log(`   浏览器报告 ${cookies.length} 条 cookie：\n`);

const nowSec = Math.floor(Date.now() / 1000);
let persistent = 0, session = 0;
for (const c of cookies) {
  const isSession = c.session === true || c.expires === -1 || c.expires === undefined;
  if (isSession) session++; else persistent++;
  const when = isSession
    ? "【会话 cookie ✗ 关掉即丢】"
    : `持久 ✓ ${new Date(c.expires * 1000).toISOString().slice(0, 10)} 到期（${Math.round((c.expires - nowSec) / 86400)} 天后）`;
  console.log(`   ${String(c.name).padEnd(42)} ${when}`);
}

// ── 3. 结论 ──────────────────────────────────────────────────
console.log("\n" + "=".repeat(66));
if (persistent > 0 && session === 0) {
  console.log("✅ 全部是持久 cookie —— expires 修复**生效**。");
  console.log("   刚才磁盘上读不到，是因为我 Stop-Process -Force 强杀了进程、Chromium 没来得及刷盘。");
  console.log("   正确测法：等它自己优雅退出（空闲关停 120s）或调 Browser.close，再读磁盘。");
} else if (session > 0) {
  console.log(`⚠️ 有 ${session} 条仍是会话 cookie —— expires 没传进去，需要继续排查。`);
} else {
  console.log("⚠️ 没读到 cookie，无法判断。");
}
console.log("=".repeat(66) + "\n");

const targetId = page.id;
/** 优雅关掉，让 Chromium 把 cookie 刷到磁盘（顺便验证落盘）。 */
await send("Browser.close").catch(() => undefined);
console.log(`（已发 Browser.close 优雅关闭，等 3 秒让它刷盘）`);
await sleep(3000);
try { ws.close(); } catch {}
console.log(`profile 目录：<edge-ldw>\\${PLATFORM}\\${SLOT}\\Default\\Network\\Cookies\n`);
