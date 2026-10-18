/** 点击 Models 后 dump 弹层 DOM 树，找 Hy3/Hy4/DeepSeek 的容器结构。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find((t) => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

let cur = String(await evalIn("location.href"));
if (!/yuanbao\.tencent\.com/.test(cur)) { await evalIn(`location.href='https://yuanbao.tencent.com/'`); await sleep(9000); }

// 开菜单
await evalIn(`(() => { const vis=${vis}; const c=[...document.querySelectorAll('button,[role="button"]')].filter(vis); const h=c.find(e=>/switch model|切换模型|模型/i.test(String(e.getAttribute('aria-label')||'')+String(e.innerText||''))); if(h)h.click(); return 'ok' })()`);
await sleep(1500);

// 找到 Models 项，依次试 click / mouseenter（hover 展开）并观察
const modelsEl = `(() => { const vis=${vis}; const c=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],li,div')].filter(vis); const h=c.find(e=>{ const t=String(e.innerText||'').trim().split('\\n')[0]; return /^(models?|模型)$/i.test(t) }); return h ? 'FOUND' : 'NO' })()`;
console.log("Models 元素:", String(await evalIn(modelsEl)));

// 方案A：hover（mouseenter/mouseover）
console.log("hover 结果:", String(await evalIn(`(() => { const vis=${vis}; const c=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],li,div')].filter(vis); const h=c.find(e=>{ const t=String(e.innerText||'').trim().split('\\n')[0]; return /^(models?|模型)$/i.test(t) }); if(!h) return 'no'; for(const ty of ['mouseenter','mouseover']){ h.dispatchEvent(new MouseEvent(ty,{bubbles:true,cancelable:true,view:window})) } return 'hovered' })()`)));
await sleep(1500);
const afterHover = String(await evalIn(`(() => { const vis=${vis}; const hits=[...document.querySelectorAll('div,li,section,button,[role]')].filter(vis).filter(e=>{ const t=String(e.innerText||'').trim(); return /hy3|hy4|deepseek|混元/i.test(t) && t.length<60 && ![...e.children].some(c=>/hy3|hy4|deepseek|混元/i.test(String(c.innerText||''))) }); return JSON.stringify(hits.slice(0,8).map(e=>({tag:e.tagName,role:e.getAttribute('role')||'-',cls:String(e.className||'').slice(0,60),text:String(e.innerText||'').trim().slice(0,40)}))) })()`));
console.log("hover 后 Hy 元素:", afterHover);

// 方案B：再 click 一次 + 等
console.log("click 结果:", String(await evalIn(`(() => { const vis=${vis}; const c=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],li,div')].filter(vis); const h=c.find(e=>{ const t=String(e.innerText||'').trim().split('\\n')[0]; return /^(models?|模型)$/i.test(t) }); if(!h) return 'no'; h.click(); return 'clicked' })()`)));
await sleep(2000);
const afterClick = String(await evalIn(`(() => { const vis=${vis}; const hits=[...document.querySelectorAll('div,li,section,button,[role]')].filter(vis).filter(e=>{ const t=String(e.innerText||'').trim(); return /hy3|hy4|deepseek|混元/i.test(t) && t.length<60 && ![...e.children].some(c=>/hy3|hy4|deepseek|混元/i.test(String(c.innerText||''))) }); return JSON.stringify(hits.slice(0,8).map(e=>({tag:e.tagName,role:e.getAttribute('role')||'-',cls:String(e.className||'').slice(0,60),text:String(e.innerText||'').trim().slice(0,40)}))) })()`));
console.log("click 后 Hy 元素:", afterClick);

// 无论如何：全 DOM 找 Hy3/Hy4/DeepSeek 文本（不限定可见）——看子层是否渲染了但藏起来
const anywhere = String(await evalIn(`(() => { const hits=[]; for(const e of document.querySelectorAll('*')){ const t=String(e.childNodes.length===1&&e.childNodes[0].nodeType===3?e.textContent:'').trim(); if(!t) continue; if(/^(hy\\s?3|hy\\s?4|deepseek)$/i.test(t)){ hits.push({tag:e.tagName,cls:String(e.className||'').slice(0,70),vis:!!(e.offsetWidth||e.offsetHeight),text:t.slice(0,20)}) } if(hits.length>=10) break; } return JSON.stringify(hits) })()`));
console.log("全 DOM 的 Hy/DeepSeek 文本节点:", anywhere);
try { ws.close(); } catch {}
