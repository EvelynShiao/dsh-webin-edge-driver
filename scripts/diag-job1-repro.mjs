/** 现场勘查：job-1 失败在哪一步——起元宝 Edge 复现一轮完整 runJob（带 .txt）。 */
const PORT = 9411;
const fs = await import("node:fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 250); return r?.result?.result?.value; };
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

let cur = String(await evalIn("location.href"));
if (!/yuanbao\.tencent\.com/.test(cur)) { console.log("⓪ 导航"); await evalIn(`location.href='https://yuanbao.tencent.com/'`); await sleep(10000); }
console.log("⓪:", String(await evalIn("location.href")).slice(0, 45));

// ① 复现上传：点「添加」→「本地文件」→ input 出来吗
console.log("① 点添加:", String(await evalIn(`(() => { const vis=${vis}; const b=[...document.querySelectorAll('button,[role="button"],[aria-label]')].filter(vis).find(e=>/添加|attach|upload/i.test(String(e.getAttribute('aria-label')||'')+String(e.getAttribute('title')||''))); if(!b) return 'no-add'; b.click(); return 'ok' })()`)));
await sleep(1200);
console.log("② 点本地文件:", String(await evalIn(`(() => { const vis=${vis}; const it=[...document.querySelectorAll('div,li,button,span,[role="menuitem"]')].filter(vis).find(e=>/^本地文件$/.test(String(e.innerText||'').trim().split('\\n')[0])); if(!it) return 'no-item'; it.click(); return 'ok' })()`)));
await sleep(1000);
console.log("③ input[type=file]:", String(await evalIn(`(() => { const f=[...document.querySelectorAll('input[type=file]')]; return JSON.stringify(f.map(e=>({accept:(e.getAttribute('accept')||'').slice(0,60),vis:!!(e.offsetWidth||e.offsetHeight)}))) })()`)));
try { ws.close(); } catch {}
