/** T1-b 验证：发送后新对话被自动改名「LDW …」了吗（Bearer 版 update_title）+ 列表 API 全通。 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = await fetch("http://127.0.0.1:3080/dsh-webin/api/edge/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ platform: "deepseek", slot: "cai-deepseek" }),
}).then(r => r.json()).catch(() => ({ ok: false }));
if (start.ok !== true) { console.log("edge/start ❌"); process.exit(1); }
await sleep(18000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 250); return r?.result?.value; };

let cur = String(await evalIn("location.href"));
if (!/chat\.deepseek\.com/.test(cur)) { await evalIn("location.href='https://chat.deepseek.com/'"); await sleep(10000); }

/** 发送完成后 rename 可能要几秒——等 6 秒再查。 */
await sleep(6000);

const raw = await evalIn(`(async () => {
  const t = localStorage.getItem('userToken');
  let token = t; try { token = JSON.parse(t).value ?? t; } catch {}
  const r = await fetch('/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', {
    credentials: 'include',
    headers: { 'Authorization': 'Bearer ' + token }
  });
  const j = await r.json();
  const rows = j?.data?.biz_data?.chat_sessions ?? [];
  return JSON.stringify(rows.slice(0, 8).map(s => ({ t: String(s.title ?? '').slice(0, 45), p: s.pinned === true })));
})()`);
try {
  const sessions = JSON.parse(String(raw));
  console.log("最新 8 条（Bearer 版 API）：");
  for (const s of sessions) console.log(`  ${s.p ? "📌" : "  "} ${s.t}`);
  const ldw = sessions.filter(s => /^LDW/.test(s.t));
  console.log(`\nLDW 前缀: ${ldw.length} 个 ${ldw.length > 0 ? "✅ 自动改名生效！" : "❌ 还没有"}`);
  if (ldw.length > 0) for (const s of ldw) console.log(`  ⭐ ${s.t}`);
} catch { console.log("解析失败:", String(raw).slice(0, 250)); }
try { ws.close(); } catch {}
