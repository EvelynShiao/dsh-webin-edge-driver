/** 豆包胶囊点击后的菜单结构 dump。 */
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
if (!/doubao\.com/.test(cur)) { await evalIn(`location.href='https://www.doubao.com/chat/'`); await sleep(10000); console.log("⓪ 已导航:", String(await evalIn("location.href")).slice(0, 50)); } else { console.log("⓪ 已在豆包"); }

// 找胶囊并点
const pillClick = String(await evalIn(`(() => {
  const vis=${vis};
  const pills=[...document.querySelectorAll('[data-testid]')].filter(vis);
  const p=pills.find(e=>/chat_input_action_(mode|model)/i.test(e.getAttribute('data-testid')||''));
  if(!p) return 'no-pill';
  p.click();
  return 'clicked:'+p.getAttribute('data-testid');
})()`));
console.log("① 胶囊:", pillClick);
await sleep(1500);

// 点击后 dump：所有新增的可见元素（role 菜单 + 含「聊天/工作」的文本元素）
console.log("② 点击后菜单元素:");
console.log(String(await evalIn(`(() => {
  const vis=${vis};
  const out=[];
  for(const e of document.querySelectorAll('[role="menuitem"],[role="menuitemradio"],[role="option"],[role="menu"],[class*="menu"],[class*="dropdown"],[class*="select"],[class*="popover"],[class*="popup"]')){
    if(!vis(e)) continue;
    const t=String(e.innerText||'').trim();
    if(!t||t.length>100) continue;
    if(!/聊天|工作|模式|对话/i.test(t)) continue;
    out.push({tag:e.tagName,role:e.getAttribute('role')||'-',cls:String(e.className||'').slice(0,50),text:t.slice(0,60).replace(/\\n/g,' | ')});
    if(out.length>=10) break;
  }
  return JSON.stringify(out,null,1);
})()`)));
try { ws.close(); } catch {}
