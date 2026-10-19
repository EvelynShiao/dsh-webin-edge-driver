/** 元宝「添加」按钮定位 + 点击后是否出现 input[type=file]。 */
const PORT = 9411;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

console.log("⓪:", String(await evalIn("location.href")).slice(0, 50));

// ① 输入区附近找「添加」按钮（aria-label / title / 文本）
console.log("① 添加类按钮:");
console.log(String(await evalIn(`(() => {
  const vis=${vis};
  const out=[];
  for (const e of document.querySelectorAll('button,[role="button"],[aria-label],div,span')) {
    if (!vis(e)) continue;
    const t=String(e.innerText||'').trim();
    const a=String(e.getAttribute('aria-label')||'')+' '+String(e.getAttribute('title')||'');
    const hit=/^(添加|附件|上传)/.test(t) || /添加|附件|上传|attach|upload|add/i.test(a);
    if (!hit) continue;
    out.push({tag:e.tagName, text:t.slice(0,14), aria:a.trim().slice(0,30), cls:String(e.className||'').slice(0,36)});
    if (out.length>=8) break;
  }
  return JSON.stringify(out,null,1);
})()`)));

// ② 点第一个「添加」候选（aria 优先），看 input[type=file] 出不出
console.log("② 点添加:", String(await evalIn(`(() => {
  const vis=${vis};
  const cands=[];
  for (const e of document.querySelectorAll('button,[role="button"],[aria-label]')) {
    if (!vis(e)) continue;
    const a=String(e.getAttribute('aria-label')||'')+' '+String(e.getAttribute('title')||'');
    if (/添加|附件|上传|attach|upload|add/i.test(a)) cands.push(e);
  }
  const btn=cands[0];
  if (!btn) return 'no-add-btn';
  btn.click();
  return 'clicked:'+(btn.getAttribute('aria-label')||btn.getAttribute('title')||'').slice(0,20);
})()`)));
await sleep(1500);
console.log("③ 点后 input[type=file]:", String(await evalIn(`(() => { const f=[...document.querySelectorAll('input[type=file]')]; return JSON.stringify(f.map(e=>({accept:(e.getAttribute('accept')||'').slice(0,80),vis:!!(e.offsetWidth||e.offsetHeight||e.getClientRects().length)}))) })()`)));

// ④ 顺带看弹出了什么面板（文件选择来源选项：本机文件/图片等）
console.log("④ 弹层文本:", String(await evalIn(`(() => { const vis=${vis}; const out=[]; for(const e of document.querySelectorAll('div,li,span')){ if(!vis(e))continue; const t=String(e.innerText||'').trim(); if(!t||t.length>20) continue; if(/本机|文件|图片|拍照|截图|电脑|local|photo/i.test(t)){ out.push(t.slice(0,20)); if(out.length>=8)break; } } return JSON.stringify([...new Set(out)]) })()`)));
try { ws.close(); } catch {}
