/** 页面还在旧状态（INVALID_TOKEN）——注入后没 reload。导航一次再查（或 dispatch reload）。 */
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
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR"; return r?.result?.value; };

/** 硬 reload（注入的 cookie 要新请求才带上）。 */
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
await sleep(8000);
console.log("reloaded");

const raw = await evalIn(`(async () => {
  const r = await fetch('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' });
  const text = await r.text();
  return JSON.stringify({ status: r.status, head: text.slice(0, 300) });
})()`);
console.log(String(raw));
try { ws.close(); } catch {}
