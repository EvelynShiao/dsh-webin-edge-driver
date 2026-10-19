/** 元宝上传终极诊断 v2：CDP send 统一解包 {id,result}（驱动器 CdpConnection 同款语义）。 */
const PORT = 9411;
const FILE = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/webin/biginput/input-1792385505513.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0;
const pending = new Map();
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
/** 与驱动器 CdpConnection.send 同语义：返回 result（或抛 error）。 */
const send = (method, params = {}) => new Promise((resolve, reject) => {
  const i = ++id;
  pending.set(i, (m) => {
    if (m.error) reject(new Error(m.error.message ?? JSON.stringify(m.error)));
    else resolve(m.result);
  });
  ws.send(JSON.stringify({ id: i, method, params }));
});
const evalIn = async (e) => {
  try {
    const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true });
    if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200);
    return r?.result?.value;
  } catch (err) { return "SEND-ERR: " + String(err?.message ?? err).slice(0, 120); }
};
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

let cur = String(await evalIn("location.href"));
if (!/yuanbao\.tencent\.com/.test(cur)) { console.log("⓪ 导航（当前 " + cur.slice(0, 40) + "）"); await evalIn(`location.href='https://yuanbao.tencent.com/'`); await sleep(10000); }
console.log("⓪:", String(await evalIn("location.href")).slice(0, 45));

console.log("① 添加:", String(await evalIn(`(() => { const vis=${vis}; const b=[...document.querySelectorAll('button,[role="button"],[aria-label]')].filter(vis).find(e=>/添加/i.test(String(e.getAttribute('aria-label')||'')+String(e.getAttribute('title')||''))); if(!b) return 'no-add'; b.click(); return 'ok' })()`)));
await sleep(1200);
console.log("② 本地文件:", String(await evalIn(`(() => { const vis=${vis}; const it=[...document.querySelectorAll('div,li,button,span,[role="menuitem"]')].filter(vis).find(e=>/^本地文件$/.test(String(e.innerText||'').trim().split('\\n')[0])); if(!it) return 'no-item'; it.click(); return 'ok' })()`)));
await sleep(1000);
console.log("③ input 数:", String(await evalIn(`document.querySelectorAll('input[type=file]').length`)));

/** CDP 塞文件（DOM.getDocument → querySelectorAll → setFileInputFiles）。 */
try {
  await send("DOM.enable");
  const doc = await send("DOM.getDocument", { depth: -1 });
  const q = await send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
  console.log("④ nodeIds:", JSON.stringify(q.nodeIds));
  let done = false;
  for (const nodeId of q.nodeIds ?? []) {
    try {
      await send("DOM.setFileInputFiles", { files: [FILE], nodeId });
      console.log(`  nodeId ${nodeId}: 塞成功`);
      done = true;
      await evalIn(`(() => { const els=[...document.querySelectorAll('input[type=file]')]; els.forEach(e=>e.dispatchEvent(new Event('change',{bubbles:true}))); return 'ok' })()`);
      break;
    } catch (e) { console.log(`  nodeId ${nodeId}: 失败 - ${String(e?.message ?? e).slice(0, 120)}`); }
  }
  if (!done) console.log("❌ 一个都没塞进去");
} catch (e) {
  console.log("CDP 段失败:", String(e?.message ?? e).slice(0, 150));
}

/** 等附件名出现（35 秒）。 */
console.log("⑤ 等附件名…");
const t0 = Date.now();
let appeared = false;
while (Date.now() - t0 < 35000) {
  const found = String(await evalIn(`(() => { const t=document.body.innerText||''; return t.includes('input-1792385505513') ? 'FOUND' : 'no' })()`));
  if (found === "FOUND") { appeared = true; break; }
  await sleep(2000);
}
console.log(appeared ? "⑤ ✅ 附件名出现在页面里！" : "⑤ ❌ 附件名没出现（塞了但页面没认）");
console.log("⑥ 输入区文件条:", String(await evalIn(`(() => { const vis=${vis}; const out=[]; for(const e of document.querySelectorAll('div,span')){ if(!vis(e))continue; const t=String(e.innerText||'').trim(); if(/input-1792385505513|\\.txt/.test(t)&&t.length<80){ out.push(t.slice(0,60)); if(out.length>=5)break; } } return JSON.stringify(out) })()`)));
try { ws.close(); } catch {}
