/** T6d 离线验证：用「新代码的兜底逻辑」直接跑当前豆包页面（不动 DSH）。
 *  完整模拟 detectPageModels 豆包路径：胶囊→一级读（旧逻辑应空）→新兜底→点对话→二级读。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /doubao/.test(t.url)) ?? list.find((t) => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

let cur = String(await evalIn("location.href"));
if (!/doubao\.com/.test(cur)) { console.log("⓪ 导航"); await evalIn(`location.href='https://www.doubao.com/chat/'`); await sleep(10000); }
else console.log("⓪ 已在豆包");

// ① 点胶囊
console.log("① 胶囊:", String(await evalIn(`(() => { const vis=${vis}; const p=[...document.querySelectorAll('[data-testid]')].filter(vis).find(e=>/chat_input_action_mode/i.test(e.getAttribute('data-testid')||'')); if(!p) return 'no-pill'; p.click(); return 'ok' })()`)));
await sleep(1200);

// ② 一级读——新旧逻辑都跑，对比
const readScript = (withFallback) => `(() => {
  const vis=${vis};
  const seen=new Set(); const read=(sels)=>{ const out=[];
    for(const s of sels){ for(const e of document.querySelectorAll(s)){ if(!vis(e))continue;
      const t=String(e.innerText||'').trim().replace(/\\n+/g,' | ');
      if(t.length<2||t.length>200)continue; const k=t.slice(0,40);
      if(seen.has(k))continue; seen.add(k); out.push(t.slice(0,80)); if(out.length>=24)break; } if(out.length>=24)break; }
    return out; };
  let out=read(['[role="menuitemradio"]','[role="menuitem"]','[role="option"]','[role="menu"] [role="menuitem"]']);
  if(out.length===0) out=read(['[class*="model-item"]','[class*="dropdown"] li','[class*="popup"] li','[class*="menu"] li']);
  ${withFallback ? `
  if(out.length===0){
    const MODE=/^(对话|工作|聊天|学习|Instant|Thinking|Expert|快速回答|深度思考|专家模式)$/;
    for(const e of document.querySelectorAll('button,div,li,span')){
      if(!vis(e)) continue;
      const own=Array.from(e.childNodes).filter(n=>n.nodeType===3).map(n=>n.textContent||'').join('').trim();
      if(!own||!MODE.test(own)) continue;
      if([...e.children].some(c=>MODE.test(String(c.innerText||'').trim()))) continue;
      const key=own.slice(0,40);
      if(seen.has(key)) continue; seen.add(key);
      out.push(own.slice(0,80));
      if(out.length>=12) break;
    }
  }` : ""}
  const cut=out.findIndex(t=>/^recent|最近|^历史/i.test(String(t).split(' | ')[0]));
  if(cut>=0) out=out.slice(0,cut);
  return JSON.stringify(out);
})()`;
console.log("② 一级读（旧逻辑）:", String(await evalIn(readScript(false))));
console.log("② 一级读（新兜底）:", String(await evalIn(readScript(true))));

// ③ 点「对话」二级展开，再读
console.log("③ 点对话钮:", String(await evalIn(`(() => { const vis=${vis}; const b=[...document.querySelectorAll('button')].filter(vis); const h=b.find(e=>/^对话$/.test(String(e.innerText||'').trim())); if(!h) return 'no-btn'; h.click(); return 'ok' })()`)));
await sleep(1300);
console.log("④ 二级读（新兜底）:", String(await evalIn(readScript(true))));
try { ws.close(); } catch {}
