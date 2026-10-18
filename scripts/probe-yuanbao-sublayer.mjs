/** 探测元宝 Models 子层结构：点开菜单→点 Models→dump 子层元素（带 role/cls）。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 150); return r?.result?.result?.value; };

// 1) 打开菜单
console.log("① 开菜单:", await evalIn(`(() => { const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)); const b=[...document.querySelectorAll('button[aria-label="Switch model"]')].filter(vis)[0]; if(!b) return 'no-btn'; b.click(); return 'ok' })()`));
await sleep(1400);

// 2) 找 Models 项并点
console.log("② 点 Models:", await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const items=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],li,div[class*="menu"],div[class*="item"]')].filter(vis);
  const hit=items.find(e=>/^models?$/i.test(String(e.innerText||'').trim().split('\\n')[0]));
  if(!hit) return 'no-models-item';
  console.log('点的是:', hit.tagName, String(hit.className||'').slice(0,60));
  hit.click();
  return 'clicked';
})()`));
await sleep(1600);

// 3) dump 点开后新出现的所有可见文本元素（找 Hy3/Hy4/DeepSeek 在哪个结构里）
console.log("③ 子层结构:");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const out=[];
  for(const e of document.querySelectorAll('div,li,section,button,[role]')){
    if(!vis(e)) continue;
    const t=String(e.innerText||'').trim().replace(/\\n+/g,' | ');
    if(!/hy3|hy4|deepseek|混元/i.test(t)) continue;
    if(t.length>120) continue;
    // 最内层优先：没有子元素也命中关键词的
    if([...e.children].some(c=>/hy3|hy4|deepseek|混元/i.test(String(c.innerText||'')))) continue;
    out.push({ tag:e.tagName, role:e.getAttribute('role')||'-', cls:String(e.className||'').slice(0,80), text:t.slice(0,90) });
    if(out.length>=10) break;
  }
  return JSON.stringify(out,null,1);
})()`));

try { ws.close(); } catch {}
console.log("（探测完，Edge 留给 idle 自动关）");
