/** 完整复刻 detectPageModels：每步打印，定位子层断点。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find((t) => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };

const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";
const readItems = `(() => {
  const vis=${vis};
  const read=(sels)=>{ const out=[],seen=new Set();
    for(const s of sels){ for(const e of document.querySelectorAll(s)){ if(!vis(e))continue;
      const t=String(e.innerText||'').trim().replace(/\\n+/g,' | ');
      if(t.length<2||t.length>200)continue; const k=t.slice(0,40);
      if(seen.has(k))continue; seen.add(k); out.push(t.slice(0,80)); if(out.length>=24)break; } if(out.length>=24)break; }
    return out; };
  let out=read(['[role="menuitemradio"]','[role="menuitem"]','[role="option"]','[role="menu"] [role="menuitem"]']);
  if(out.length===0) out=read(['[class*="model-item"]','[class*="modelItem"]','[class*="mode-item"]','[class*="dropdown"] li','[class*="popup"] li','[class*="menu"] li']);
  const cut=out.findIndex(t=>/^recent|最近|^历史/i.test(String(t).split(' | ')[0]));
  if(cut>=0) out=out.slice(0,cut);
  return JSON.stringify(out);
})()`;

// ⓪ 导航
let cur = String(await evalIn("location.href"));
if (!/yuanbao\.tencent\.com/.test(cur)) { console.log("⓪ 导航（当前 " + cur + "）"); await evalIn(`location.href='https://yuanbao.tencent.com/'`); await sleep(9000); }
console.log("⓪:", String(await evalIn("location.href")).slice(0, 50));

// ① 开菜单
console.log("① 开:", String(await evalIn(`(() => { const vis=${vis}; const kw=/switch model|切换模型|模型|mode|模式|hy\\d|deepseek|混元/i; const c=[...document.querySelectorAll('button,[role="button"],[data-testid]')].filter(vis); const h=c.find(e=>kw.test(String(e.getAttribute('aria-label')||'')+String(e.getAttribute('data-testid')||'')+String(e.innerText||''))); if(!h) return 'no-button'; if(h.getAttribute('aria-expanded')==='true') return 'already'; h.click(); return 'opened'; })()`)));
await sleep(1200);
const top = JSON.parse(String(await evalIn(readItems)));
console.log("② 顶层(" + top.length + "):", top.map(t => t.split(" | ")[0]).join(" / "));

// ③ entry 精确匹配（新版逻辑）
const entry = top.find((t) => { const h = t.split(" | ")[0].trim().toLowerCase(); return h === "models" || h === "model" || h === "模型"; });
console.log("③ entry:", entry === undefined ? "NOT_FOUND" : JSON.stringify(entry));
if (entry === undefined) { try { ws.close(); } catch {}; process.exit(0); }

// ④ 点 Models（_pickPanelItem 新版：单名走 wantList）
const want = entry.split(" | ")[0].trim();
console.log("④ 点:", String(await evalIn(`(() => {
  const vis=${vis};
  const wantList=${JSON.stringify([want])};
  const sels=['[role="menuitemradio"]','[role="menuitem"]','[role="option"]','[class*="model-item"]','[class*="dropdown"] li','[class*="popup"] li'];
  const items=[];
  for(const s of sels){ for(const e of document.querySelectorAll(s)){ if(!vis(e))continue; const t=String(e.innerText||'').trim(); if(t.length<2||t.length>200)continue; items.push(e); } }
  if(items.length===0) return 'no-items';
  for(const w of wantList){ const wl=String(w).toLowerCase();
    const h=items.find(e=>String(e.innerText||'').trim().split('\\n')[0].toLowerCase().startsWith(wl)) || items.find(e=>String(e.innerText||'').trim().toLowerCase().includes(wl));
    if(h){ h.click(); return 'picked:'+w; } }
  return 'no-match:'+items.map(e=>String(e.innerText||'').trim().split('\\n')[0]).slice(0,8).join('|');
})()`)));

// ⑤ 多轮读子层
for (const wait of [1800, 1600]) {
  await sleep(wait);
  const sub = JSON.parse(String(await evalIn(readItems)));
  console.log(`⑤ +${wait}ms 子层(${sub.length}):`, sub.map(t => t.split(" | ")[0]).join(" / "));
}
try { ws.close(); } catch {}
