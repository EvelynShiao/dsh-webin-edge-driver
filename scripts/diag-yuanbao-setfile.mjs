/** 元宝上传终极诊断：点本地文件后，dump 全部 input[type=file]（含 shadow DOM）、试 setFileInputFiles 前后对比。 */
const PORT = 9411;
const path = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/webin/biginput/input-1792385505513.txt";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /yuanbao/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const sendRaw = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); }); const send = async (m, p) => { const r = await sendRaw(m, p); return r?.result ?? r; };
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };
const vis = "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";

let cur = String(await evalIn("location.href"));
if (!/yuanbao\.tencent\.com/.test(cur)) { console.log("⓪ 导航"); await evalIn(`location.href='https://yuanbao.tencent.com/'`); await sleep(10000); }
console.log("⓪:", String(await evalIn("location.href")).slice(0, 45));

// ① 点添加→本地文件（两段式）
console.log("① 添加:", String(await evalIn(`(() => { const vis=${vis}; const b=[...document.querySelectorAll('button,[role="button"],[aria-label]')].filter(vis).find(e=>/添加/i.test(String(e.getAttribute('aria-label')||'')+String(e.getAttribute('title')||''))); if(!b) return 'no-add'; b.click(); return 'ok' })()`)));
await sleep(1200);
console.log("② 本地文件:", String(await evalIn(`(() => { const vis=${vis}; const it=[...document.querySelectorAll('div,li,button,span,[role="menuitem"]')].filter(vis).find(e=>/^本地文件$/.test(String(e.innerText||'').trim().split('\\n')[0])); if(!it) return 'no-item'; it.click(); return 'ok' })()`)));
await sleep(1000);

// ③ 全部 input[type=file]（含每种的 id/name/接受）——用 CDP DOM 查询数 nodeIds
const count = String(await evalIn(`(() => document.querySelectorAll('input[type=file]').length)()`));
console.log("③ input[type=file] 数量:", count);

// ④ 用 CDP DOM.setFileInputFiles 塞真实文件（复刻驱动器）
await send("DOM.enable");
const docRaw = await send("DOM.getDocument", { depth: -1 }); const doc = docRaw.root ?? docRaw; console.log("root nodeId:", doc?.nodeId);
const q = await send("DOM.querySelectorAll", { nodeId: doc.root.nodeId, selector: 'input[type=file]' });
console.log("④ CDP nodeIds:", JSON.stringify(q.nodeIds));
let lastErr = null;
let ok = false;
for (const nodeId of q.nodeIds ?? []) {
  try {
    const r = await send("DOM.setFileInputFiles", { files: [path], nodeId });
    if (r?.error) { lastErr = r.error; continue; }
    console.log(`  nodeId ${nodeId}: setFileInputFiles 成功`);
    ok = true;
    /** 触发 change（驱动器同款） */
    await evalIn(`(() => { const els=[...document.querySelectorAll('input[type=file]')]; els.forEach(e=>e.dispatchEvent(new Event('change',{bubbles:true}))); return 'ok' })()`);
    break;
  } catch (e) { lastErr = e; }
}
if (!ok) console.log("❌ 全部失败:", String(lastErr).slice(0, 200));

// ⑤ 等页面出现文件名（驱动器同款等待逻辑，缩短到 30 秒观察）
console.log("⑤ 等附件名出现（30 秒观察）…");
const t0 = Date.now();
while (Date.now() - t0 < 30000) {
  const found = String(await evalIn(`(() => { const t=document.body.innerText||''; return t.includes('input-1792385505513') || t.includes('.txt') && /上传|解析|附件/.test(t) ? 'FOUND:'+t.slice(0,100) : 'no' })()`));
  if (found.startsWith("FOUND")) { console.log("⑤ ✅", found.slice(0, 120)); break; }
  await sleep(2000);
  if (Date.now() - t0 >= 30000) console.log("⑤ ❌ 30 秒内附件名没出现");
}
// ⑥ 输入区上有没有文件 chip
console.log("⑥ 输入区附近文件条:", String(await evalIn(`(() => { const vis=${vis}; const out=[]; for(const e of document.querySelectorAll('div,span')){ if(!vis(e))continue; const t=String(e.innerText||'').trim(); if(/\.txt|input-\d+/.test(t)&&t.length<80){ out.push(t.slice(0,60)); if(out.length>=5)break; } } return JSON.stringify(out) })()`)));
try { ws.close(); } catch {}
