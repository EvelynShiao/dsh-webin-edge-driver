/** 用驱动器的 listSessions 查 DeepSeek 最新会话标题——验 update_title 自动改名「LDW …」。
 *  走 ensureEdge + provider.sessionApi（抓包来的 fetch_page）。
 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = await fetch("http://127.0.0.1:3080/dsh-webin/api/edge/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ platform: "deepseek", slot: "cai-deepseek" }),
}).then(r => r.json()).catch(() => ({ ok: false }));
console.log("edge/start:", start.ok === true ? "✅" : "❌");
if (start.ok !== true) process.exit(1);
await sleep(18000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.value; };

/** 先导航到 DeepSeek 域（ensureOnTargetDomain 等价）。 */
let cur = String(await evalIn("location.href"));
if (!/chat\.deepseek\.com/.test(cur)) { await evalIn(`location.href='https://chat.deepseek.com/'`); await sleep(10000); }

/** 会话列表：GET /api/v0/chat_session/fetch_page（provider.sessionApi.listPath 同款）。 */
const raw = await evalIn(`(async () => {
  const out = [];
  for (let p = 0; p < 3; p++) {
    const r = await fetch('/api/v0/chat_session/fetch_page?count=50&page=' + p, { credentials: 'include' });
    if (!r.ok) break;
    const j = await r.json();
    const rows = j?.data?.biz_data?.chat_sessions ?? [];
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const s of rows) out.push({ id: s.id, title: String(s.title ?? ''), pinned: s.pinned === true });
    if (j?.data?.biz_data?.has_more !== true) break;
  }
  return JSON.stringify(out.slice(0, 8));
})()`);
try {
  const sessions = JSON.parse(String(raw));
  console.log("\n最新 8 条会话：");
  for (const s of sessions) console.log(`  ${s.pinned ? "📌" : "  "} ${s.title.slice(0, 50)}`);
  const ldw = sessions.filter(s => /^LDW/.test(s.title));
  console.log(`\nLDW 前缀对话: ${ldw.length} 个 ${ldw.length > 0 ? "✅（update_title 生效）" : "❌（改名没跑或标题是网页自生成）"}`);
} catch { console.log("解析失败:", String(raw).slice(0, 200)); }
try { ws.close(); } catch {}
