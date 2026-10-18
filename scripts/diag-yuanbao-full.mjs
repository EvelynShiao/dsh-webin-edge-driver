/** 全程模拟 detectPageModels：开菜单 → 读顶层 → 点 Models → 逐步读子层。每步打印。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find((t) => t.type === "page");
if (!page) { console.log("NO_PAGE url=", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };

const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";
// ⓪ 确保在元宝域（edge/start 只起浏览器不导航——踩过 about:blank 的坑）
const cur = String(await evalIn("location.href"));
if (!/yuanbao\.tencent\.com/.test(cur)) {
  console.log("⓪ 导航到元宝…（当前 " + cur + "）");
  await evalIn(`location.href = 'https://yuanbao.tencent.com/'`);
  await sleep(9000);
  console.log("⓪ 现在:", String(await evalIn("location.href")));
} else {
  console.log("⓪ 已在元宝域");
}
// ① 开菜单（复刻 _openPanel 的关键词找按钮）
const opened = await evalIn(`(() => {
  const vis=${vis};
  const kw=/switch model|模型|mode|模式|hy\\d|deepseek|混元|hunyuan|聊天|工作/i;
  const cands=[...document.querySelectorAll('button,[role="button"],[data-testid]')].filter(vis);
  const hit=cands.find(e=>kw.test(String(e.getAttribute('aria-label')||'')+String(e.getAttribute('data-testid')||'')+String(e.innerText||'')));
  if(!hit) return 'no-button';
  hit.click();
  return 'opened:'+(hit.getAttribute('aria-label')||String(hit.innerText||'').slice(0,20));
})()`);
console.log("① 开菜单:", opened);
await sleep(1600);

// ② 读顶层（复刻 _readPanelItems role 优先版）
const top = JSON.parse(String(await evalIn(`(() => {
  const vis=${vis};
  const read=(sels)=>{ const out=[],seen=new Set();
    for(const s of sels){ for(const e of document.querySelectorAll(s)){ if(!vis(e))continue;
      const t=String(e.innerText||'').trim().replace(/\\n+/g,' | ');
      if(t.length<2||t.length>200)continue; const k=t.slice(0,40);
      if(seen.has(k))continue; seen.add(k); out.push(t.slice(0,80)); if(out.length>=24)break; } if(out.length>=24)break; }
    return out; };
  let out=read(['[role="menuitemradio"]','[role="menuitem"]','[role="option"]','[role="menu"] [role="menuitem"]']);
  if(out.length===0) out=read(['[class*="model-item"]','[class*="dropdown"] li','[class*="popup"] li','[class*="menu"] li']);
  const cut=out.findIndex(t=>/^recent|最近/i.test(String(t).split(' | ')[0]));
  if(cut>=0) out=out.slice(0,cut);
  return JSON.stringify(out);
})()`)));
console.log("② 顶层(" + top.length + "):", top.join(" | "));

// ③ 找 Models 项，看它的真实结构再点
const modelsInfo = await evalIn(`(() => {
  const vis=${vis};
  const cands=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],li,div')].filter(vis);
  for (const e of cands) {
    const t = String(e.innerText||'').trim();
    if (!/^models?$/i.test(t.split('\\n')[0])) continue;
    return JSON.stringify({ tag: e.tagName, role: e.getAttribute('role')||'-', cls: String(e.className||'').slice(0,90), text: t.slice(0,40), hasKids: e.children.length });
  }
  return 'NOT_FOUND';
})()`);
console.log("③ Models 项结构:", modelsInfo);

// ④ 点它
const picked = await evalIn(`(() => {
  const vis=${vis};
  const cands=[...document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],li,div')].filter(vis);
  for (const e of cands) {
    const t = String(e.innerText||'').trim();
    if (!/^models?$/i.test(t.split('\\n')[0])) continue;
    e.click();
    return 'clicked:' + e.tagName + '/' + String(e.className||'').slice(0,40);
  }
  return 'no-match';
})()`);
console.log("④ 点 Models:", picked);

// ⑤ 等 2 秒再读——先看有没有新增的 Hy3/Hy4/DeepSeek 文本元素
for (const wait of [1200, 2000, 3000]) {
  await sleep(wait);
  const sub = await evalIn(`(() => {
    const vis=${vis};
    const read=(sels)=>{ const out=[],seen=new Set();
      for(const s of sels){ for(const e of document.querySelectorAll(s)){ if(!vis(e))continue;
        const t=String(e.innerText||'').trim().replace(/\\n+/g,' | ');
        if(t.length<2||t.length>200)continue; const k=t.slice(0,40);
        if(seen.has(k))continue; seen.add(k); out.push(t.slice(0,80)); if(out.length>=24)break; } if(out.length>=24)break; }
      return out; };
    let out=read(['[role="menuitemradio"]','[role="menuitem"]','[role="option"]']);
    if(out.length===0) out=read(['[class*="model-item"]','[class*="dropdown"] li','[class*="popup"] li','[class*="menu"] li']);
    return JSON.stringify(out);
  })()`);
  console.log(`⑤ 等${wait}ms 后读数:`, String(sub).slice(0, 300));
}
try { ws.close(); } catch {}
