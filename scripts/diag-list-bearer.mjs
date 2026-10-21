/** 带 Authorization: Bearer <userToken> 调 fetch_page——验证 data API 的鉴权头。 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

const raw = await evalIn(`(async () => {
  const t = localStorage.getItem('userToken');
  if (!t) return 'no-token';
  let token = t;
  try { token = JSON.parse(t).value ?? t; } catch {}
  const r = await fetch('/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', {
    credentials: 'include',
    headers: { 'Authorization': 'Bearer ' + token, 'x-ds-token': token }
  });
  const text = await r.text();
  return JSON.stringify({ status: r.status, head: text.slice(0, 600) });
})()`);
console.log("带 Bearer 调法:", String(raw));
try { ws.close(); } catch {}
