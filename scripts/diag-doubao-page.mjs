/** 豆包页面诊断：找「模式」按钮 + 菜单结构。 */
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
console.log("⓪ URL:", cur.slice(0, 60));
if (!/doubao\.com/.test(cur)) { console.log("不在豆包域——先导航"); await evalIn(`location.href='https://www.doubao.com/chat/'`); await sleep(10000); console.log("⓪ 现在:", String(await evalIn("location.href")).slice(0, 60)); }

// 找所有带「聊天/工作/模式/对话」文字的可见按钮
console.log("① 候选按钮:");
console.log(String(await evalIn(`(() => {
  const vis=${vis};
  const out=[];
  for(const e of document.querySelectorAll('button,[role="button"],[data-testid]')){
    if(!vis(e)) continue;
    const t=String(e.innerText||'').trim();
    const dt=e.getAttribute('data-testid')||'';
    if(/聊天|工作|模式|对话|chat|work|mode/i.test(t+' '+dt)){
      out.push({tag:e.tagName,dt:dt.slice(0,40),text:t.slice(0,24),aria:(e.getAttribute('aria-label')||'').slice(0,30)});
    }
    if(out.length>=10) break;
  }
  return JSON.stringify(out,null,1);
})()`)));

// data-testid 含 mode 的控件全列出来
console.log("② data-testid 含 mode/chat/work:");
console.log(String(await evalIn(`(() => {
  const vis=${vis};
  const out=[];
  for(const e of document.querySelectorAll('[data-testid]')){
    const dt=e.getAttribute('data-testid')||'';
    if(!/mode|chat|work/i.test(dt)) continue;
    if(!vis(e)) continue;
    out.push({tag:e.tagName,dt,text:String(e.innerText||'').trim().slice(0,30)});
    if(out.length>=10) break;
  }
  return JSON.stringify(out,null,1);
})()`)));
try { ws.close(); } catch {}
