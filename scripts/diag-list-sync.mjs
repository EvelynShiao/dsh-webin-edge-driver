/** userToken 已写入但 fetch 返回 undefined——evalIn 的 awaitPromise 可能没等完。同步版重查。 */
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
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.value; };

console.log("userToken 现状:", String(await evalIn(`(() => { const t = localStorage.getItem('userToken'); return t ? '在(' + t.length + '字符)' : '不在'; })()`)));

/** 同步 fetch（不用 awaitPromise 的 async——直接 JSON stringify 在页内拼）。 */
const raw = await evalIn(`fetch('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' }).then(r => r.text()).then(t => t.slice(0, 300))`);
console.log("列表:", String(raw));
try { ws.close(); } catch {}
