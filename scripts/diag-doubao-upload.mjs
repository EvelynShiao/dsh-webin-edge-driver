/** 豆包上传控件探测：input[type=file] 直查 + 添加按钮两段式。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /doubao/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

let cur = String(await evalIn("location.href"));
if (!/doubao\.com/.test(cur)) { console.log("⓪ 导航"); await evalIn(`location.href='https://www.doubao.com/chat/'`); await sleep(11000); }
console.log("⓪:", String(await evalIn("location.href")).slice(0, 45));

// ① 直查 input[type=file]
console.log("① input[type=file]:", String(await evalIn(`(() => { const f=[...document.querySelectorAll('input[type=file]')]; return JSON.stringify(f.map(e=>({accept:(e.getAttribute('accept')||'').slice(0,50),vis:!!(e.offsetWidth||e.offsetHeight)}))) })()`)));

// ② 传文件按钮（data-testid 含 upload 的）
console.log("② upload 按钮:", String(await evalIn(`(() => { const vis=${vis}; const out=[]; for(const e of document.querySelectorAll('[data-testid],button')){ const dt=e.getAttribute('data-testid')||''; if(!/upload|attach|file/i.test(dt)) continue; if(!vis(e)) continue; out.push({tag:e.tagName,dt,text:String(e.innerText||'').trim().slice(0,16)}); if(out.length>=6)break; } return JSON.stringify(out) })()`)));

// ③ 点它 → 再看 input
console.log("③ 点 upload:", String(await evalIn(`(() => { const vis=${vis}; const b=[...document.querySelectorAll('[data-testid],button')].filter(vis).find(e=>/upload|attach/i.test(e.getAttribute('data-testid')||'')); if(!b) return 'no-btn'; b.click(); return 'clicked:'+(b.getAttribute('data-testid')||'') })()`)));
await sleep(1500);
console.log("④ 点后 input[type=file]:", String(await evalIn(`(() => { const f=[...document.querySelectorAll('input[type=file]')]; return JSON.stringify(f.map(e=>({accept:(e.getAttribute('accept')||'').slice(0,60),vis:!!(e.offsetWidth||e.offsetHeight)}))) })()`)));
try { ws.close(); } catch {}
