/** 豆包：点胶囊→点「对话」按钮→dump 选项列表。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page" && /doubao/.test(t.url)) ?? list.find((t) => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

// ① 点胶囊
console.log("①:", String(await evalIn(`(() => { const vis=${vis}; const p=[...document.querySelectorAll('[data-testid]')].filter(vis).find(e=>/chat_input_action_mode/i.test(e.getAttribute('data-testid')||'')); if(!p) return 'no-pill'; p.click(); return 'ok' })()`)));
await sleep(1200);
// ② 点「对话」按钮（下拉展开）
console.log("② 点对话钮:", String(await evalIn(`(() => { const vis=${vis}; const b=[...document.querySelectorAll('button')].filter(vis); const h=b.find(e=>/^对话$/.test(String(e.innerText||'').trim())); if(!h) return 'no-btn'; h.click(); return 'ok' })()`)));
await sleep(1500);
// ③ dump 全部可见的短文本元素（找 选项列表：聊天/工作/学习/图像…）
console.log("③ 新出现的选项:");
console.log(String(await evalIn(`(() => {
  const vis=${vis};
  const out=[];
  for(const e of document.querySelectorAll('div,li,section,button,[role]')){
    if(!vis(e)) continue;
    const t=String(e.innerText||'').trim();
    if(!t||t.length>50||t.length<2) continue;
    if(!/^(聊天|工作|学习|对话|图像|写作|翻译|编程|搜索|全能)/.test(t.split('\\n')[0])) continue;
    if([...e.children].some(c=>String(c.innerText||'').trim()===t)) continue;
    out.push({tag:e.tagName,role:e.getAttribute('role')||'-',cls:String(e.className||'').slice(0,40),text:t.slice(0,40)});
    if(out.length>=14) break;
  }
  return JSON.stringify(out,null,1);
})()`)));
try { ws.close(); } catch {}
