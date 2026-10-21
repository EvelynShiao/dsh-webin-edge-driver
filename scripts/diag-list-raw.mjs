/** 列表是空的——fetch_page 401/403（DeepSeek 登录态掉了？）或返回结构变了。dump 原始响应。 */
const PORT = 9412;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR"; return r?.result?.result?.value; };

const raw = await evalIn(`(async () => {
  const r = await fetch('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' });
  const text = await r.text();
  return JSON.stringify({ status: r.status, head: text.slice(0, 400) });
})()`);
console.log(String(raw));
try { ws.close(); } catch {}
