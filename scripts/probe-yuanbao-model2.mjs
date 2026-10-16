/**
 * 元宝模型选择器：点开 `button[aria-label="Switch model"]`，dump 选项列表。
 */
import { spawn, execSync } from "node:child_process";

const EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DIR = "C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\edge-ldw\\yuanbao";
const PORT = 9422;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const kill = (port) => { try { execSync(`powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`, { encoding: "utf8" }); } catch {} };

const proc = spawn(EXE, [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${DIR}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
  "--no-service-autorun", "--disable-sync", "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  "--disable-features=Translate,msEdgeIdentityFeature,msEdgeSidebarFeature,EdgeCollections",
  "--disk-cache-size=52428800", "--window-size=1100,820", "--window-position=-24000,-24000",
  "about:blank",
], { detached: true, stdio: "ignore", windowsHide: false });
proc.unref();

let up = false;
for (let i = 0; i < 80; i++) { try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { up = true; break; } } catch {} await sleep(300); }
if (!up) { console.log("❌ CDP 起不来"); process.exit(1); }
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const ws = new WebSocket(list.find((t) => t.type === "page").webSocketDebuggerUrl);
let id = 0; const pending = new Map();
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.result?.exceptionDetails) return "ERR: " + String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.result?.value; };

await send("Page.enable");
await send("Page.navigate", { url: "https://yuanbao.tencent.com/" });
await sleep(14000);

/** 关掉可能的引导弹窗，免得挡着。 */
await evalIn(`(() => { const b=[...document.querySelectorAll('button,div')].find(e=>/Got It|知道了|我知道了/.test((e.innerText||'').trim())); if(b) b.click(); return 'ok'; })()`);
await sleep(800);

console.log("=== ① 模型按钮 + 当前值 ===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const b=[...document.querySelectorAll('button[aria-label="Switch model"],button[aria-label*="model" i]')].filter(vis);
  return JSON.stringify(b.map(e=>({aria:e.getAttribute('aria-label'), text:(e.innerText||'').trim(), cls:String(e.className||'').slice(0,60)})),null,1);
})()`));

console.log("\n=== ② 点开它 ===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const b=[...document.querySelectorAll('button[aria-label="Switch model"]')].filter(vis)[0];
  if(!b) return 'no-button';
  b.click();
  return 'clicked（当前显示：'+((b.innerText||'').trim())+'）';
})()`));
await sleep(2500);

console.log("\n=== ③ 弹出面板里的选项（找 role=menuitem / option 之类）===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const sels=['[role="menuitem"]','[role="option"]','[role="menuitemradio"]','[class*="model-item"]','[class*="modelItem"]','[class*="dropdown"] li','[class*="popup"] li','[class*="list"] > *'];
  const out=[],seen=new Set();
  for(const s of sels){
    for(const e of document.querySelectorAll(s)){
      if(!vis(e)) continue;
      const t=(e.innerText||'').trim();
      if(t.length<2||t.length>200) continue;
      const k=t.slice(0,30);
      if(seen.has(k)) continue; seen.add(k);
      out.push({sel:s, tag:e.tagName, cls:String(e.className||'').slice(0,80), ariaChecked:e.getAttribute('aria-checked'), text:t.slice(0,80).replace(/\\n/g,' / ')});
      if(out.length>=20) break;
    }
    if(out.length>=20) break;
  }
  return JSON.stringify(out,null,1);
})()`));

console.log("\n=== ④ 兜底：所有新出现的、文字像模型名的可见块 ===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const out=[],seen=new Set();
  for(const e of document.querySelectorAll('div,li,button,span')){
    if(!vis(e)) continue;
    const t=(e.innerText||'').trim();
    if(t.length<2||t.length>40) continue;
    if(!/Instant|Expert|DeepSeek|Hunyuan|混元|R1|T1|Thinking|联网|Search|Image|Writing/i.test(t)) continue;
    const cls=String(e.className||'');
    if(!/model|dropdown|popup|menu|list|item/i.test(cls)) continue;
    const k=t+'|'+cls.slice(0,30);
    if(seen.has(k)) continue; seen.add(k);
    out.push({tag:e.tagName, cls:cls.slice(0,90), text:t.slice(0,60).replace(/\\n/g,' / ')});
    if(out.length>=18) break;
  }
  return JSON.stringify(out,null,1);
})()`));

try { ws.close(); } catch {}
kill(PORT);
console.log("\n（已关闭探测 Edge）");
