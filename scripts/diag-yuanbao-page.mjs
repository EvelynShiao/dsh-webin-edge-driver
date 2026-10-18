/** 诊断元宝页面当前状态 + 菜单打开情况。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
console.log("tabs:", list.map(t => `${t.type}:${String(t.url).slice(0, 60)}`).join(" || "));
const page = list.find((t) => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find((t) => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 150); return r?.result?.result?.value; };

console.log("URL:", await evalIn("location.href"));
console.log("标题:", await evalIn("document.title"));
console.log("输入框在吗:", await evalIn(`(() => { const e=document.querySelector('div.ql-editor'); return e ? '有' : '无' })()`));
console.log("Switch model 按钮:", await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const b=[...document.querySelectorAll('button')].filter(vis);
  return JSON.stringify(b.slice(0,12).map(e=>({ aria: e.getAttribute('aria-label')||'', text: String(e.innerText||'').trim().slice(0,20) })));
})()`));
try { ws.close(); } catch {}
