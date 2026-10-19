/** 元宝附件上传实测：复刻驱动器 uploadFileToPage 找控件 → 塞文件 → 看解析。 */
const PORT = 9411;
const fs = await import("node:fs");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
console.log("tabs:", list.map(t => `${t.type}:${String(t.url).slice(0, 50)}`).join(" || "));
const page = list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

// ⓪ 导航到元宝
let cur = String(await evalIn("location.href"));
if (!/yuanbao\.tencent\.com/.test(cur)) { console.log("⓪ 导航（当前 " + cur.slice(0,40) + "）"); await evalIn(`location.href='https://yuanbao.tencent.com/'`); await sleep(10000); }
console.log("⓪:", String(await evalIn("location.href")).slice(0, 50));

// ① 找上传控件：input[type=file] 直接有吗？
console.log("① input[type=file]:", String(await evalIn(`(() => { const f=[...document.querySelectorAll('input[type=file]')]; return JSON.stringify(f.map(e=>({vis:!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length),accept:(e.getAttribute('accept')||'').slice(0,60),id:e.id||'-',cls:String(e.className||'').slice(0,40)}))) })()`)));

// ② 「添加」按钮（驱动器注释说元宝输入区附近有「添加」陷阱按钮）
console.log("② 「添加」类按钮:", String(await evalIn(`(() => { const vis=${vis}; const out=[]; for(const e of document.querySelectorAll('button,[role="button"],[aria-label],div,span'){ if(!vis(e))continue; const t=String(e.innerText||'').trim(); const a=(e.getAttribute('aria-label')||'')+(e.getAttribute('title')||''); if(/^(添加|附件|上传|上传文件|attach|upload)/i.test(t) || /添加|附件|上传|attach|upload/i.test(a)){ out.push({tag:e.tagName,text:t.slice(0,16),aria:a.slice(0,30)}); if(out.length>=8)break; } } return JSON.stringify(out) })()`)));

// ③ DOM.setFileInputHandler 需要先知道有没有 input；有就直接试塞
const fileInputs = JSON.parse(String(await evalIn(`(() => { const f=[...document.querySelectorAll('input[type=file]')]; return JSON.stringify(f.length) })()`)));
console.log("③ input[type=file] 总数:", fileInputs);
try { ws.close(); } catch {}
