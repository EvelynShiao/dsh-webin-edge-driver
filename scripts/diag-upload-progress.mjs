/** 看当前元宝页面上传进度推进到多少（复现后残余状态）。 */
const PORT = 9411;
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((resolve, reject) => { const i = ++id; pending.set(i, (m) => { if (m.error) reject(new Error(m.error.message)); else resolve(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true }); return r?.result?.value; };
console.log("上传状态:", String(await evalIn(`(() => { const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)); const out=[]; for(const e of document.querySelectorAll('div,span')){ if(!vis(e))continue; const t=String(e.innerText||'').trim(); if(/input-\\d+|上传中|解析|\\.txt/.test(t)&&t.length<60){ out.push(t.replace(/\\n/g,' | ').slice(0,60)); if(out.length>=6)break; } } return JSON.stringify([...new Set(out)]) })()`)));
/** 网络面：文件上传的 XHR/fetch 有没有发出去 */
console.log("页面 URL:", String(await evalIn("location.href")).slice(0, 60));
try { ws.close(); } catch {}
