/**
 * 千问（qianwen.com）DOM 探测：找出**助手回复**的容器与「停止生成」按钮。
 *
 * 背景：四平台端到端测试里，只有千问超时（消息发出去了、抓不到回复）。
 * 抓不到回复 = 现在的 `replySelectors` / `stopSelectors` 与实际 DOM 不符。
 * 只做探测，不改任何配置。
 */
import { spawn, execSync } from "node:child_process";

const EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DIR = "C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\edge-ldw\\qwen";
const PORT = 9420;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function killByPort(port) {
  try {
    execSync(
      `powershell -NoProfile -Command "Get-CimInstance Win32_Process -Filter \\"Name='msedge.exe'\\" | Where-Object { $_.CommandLine -match 'remote-debugging-port=${port}' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }"`,
      { encoding: "utf8" },
    );
  } catch { /* 没有就算了 */ }
}

const args = [
  `--remote-debugging-port=${PORT}`, `--user-data-dir=${DIR}`,
  "--no-first-run", "--no-default-browser-check", "--disable-background-mode",
  "--no-service-autorun", "--disable-sync", "--disable-background-timer-throttling",
  "--disable-backgrounding-occluded-windows", "--disable-renderer-backgrounding",
  "--disable-features=Translate,msEdgeIdentityFeature,msEdgeSidebarFeature,EdgeCollections",
  "--disk-cache-size=52428800", "--window-size=1100,820", "--window-position=-24000,-24000",
  "about:blank",
];
const proc = spawn(EXE, args, { detached: true, stdio: "ignore", windowsHide: false });
proc.unref();

let up = false;
for (let i = 0; i < 80; i++) {
  try { const r = await fetch(`http://127.0.0.1:${PORT}/json/version`); if (r.ok) { up = true; break; } } catch { /* 等 */ }
  await sleep(300);
}
if (!up) { console.log("❌ CDP 起不来"); process.exit(1); }

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find((t) => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0; const pending = new Map();
await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((res) => {
  const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
});
const evalIn = async (expr) => {
  const r = await send("Runtime.evaluate", { expression: expr, returnByValue: true, awaitPromise: true });
  if (r?.result?.exceptionDetails) return `ERR: ${String(r.result.exceptionDetails.exception?.description ?? "").slice(0, 200)}`;
  return r?.result?.result?.value;
};

await send("Page.enable");
await send("Page.navigate", { url: "https://www.qianwen.com/" });
await sleep(14000);

console.log("=== ① 页面与登录态 ===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const slate=[...document.querySelectorAll('div[data-slate-editor="true"]')].filter(vis).length;
  const sendBtn=[...document.querySelectorAll('button[aria-label="发送消息"]')].filter(vis).length;
  const loginUi=[...document.querySelectorAll('button[class*="login"],[class*="qrGuide"],[class*="Login"]')].filter(vis).length;
  return JSON.stringify({url:location.href,title:document.title,slate,sendBtn,loginUi});
})()`));

console.log("\n=== ② 现有 replySelectors 命中情况（发送前）===");
const CHECK = `(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const out={};
  for (const s of ['[data-message-role="assistant"]','[data-role="assistant"]','button[aria-label*="停止"]','[class*="message"]','[class*="markdown"]','[class*="answer"]','[class*="assistant"]','[class*="reply"]']) {
    out[s]=[...document.querySelectorAll(s)].filter(vis).length;
  }
  return JSON.stringify(out,null,1);
})()`;
console.log(await evalIn(CHECK));

console.log("\n=== ③ 发一条消息（用驱动真实路径：paste 事件）===");
console.log(await evalIn(`(async () => {
  const el=document.querySelector('div[data-slate-editor="true"]');
  if(!el) return 'no-slate';
  el.focus();
  try { document.execCommand('selectAll', false, undefined); document.execCommand('delete', false, undefined); } catch(e) {}
  /** 驱动的真实路径是派发 paste 事件（富文本编辑器会处理它）。 */
  const dt = new DataTransfer();
  dt.setData('text/plain', '斑马为什么有条纹');
  el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
  await new Promise(r=>setTimeout(r,900));
  return 'filled:[' + String(el.innerText||'').slice(0,30).replace(/\\n/g,'|') + ']';
})()`));

/** 点发送键（配置里就是 button[aria-label="发送消息"]）。 */
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const b=[...document.querySelectorAll('button[aria-label="发送消息"]')].filter(vis)[0];
  if(!b) return 'no-send-button';
  b.click();
  return 'clicked';
})()`));

for (let i = 1; i <= 8; i++) {
  await sleep(4000);
  const s = await evalIn(CHECK);
  console.log(`  [${i}] ${String(s).replace(/\s+/g, " ")}`);
}

console.log("\n=== ④ 所有包含「斑马」的容器（不过滤提问，看全貌）===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const res=[],seen=new Set();
  for (const e of [...document.querySelectorAll('div,section,article,li,p')].filter(vis)) {
    const t=(e.innerText||'').trim();
    if(!t.includes('斑马')) continue;
    if(t.length>1200) continue;
    const hasInnerChild=[...e.children].some(c=>{
      const ct=(c.innerText||'').trim();
      return ct.includes('斑马') && !ct.includes('为什么');
    });
    const k=String(e.className).slice(0,70)+'#'+e.tagName;
    if(seen.has(k)) continue; seen.add(k);
    res.push({tag:e.tagName,cls:String(e.className||'').slice(0,100),testid:e.getAttribute('data-testid'),
              isInner:!hasInnerChild,len:t.length,text:t.slice(0,60).replace(/\\n/g,' ')});
    if(res.length>=16) break;
  }
  return JSON.stringify(res,null,1);
})()`));

console.log("\n=== ⑤ 聊天区骨架（找滚动容器与「消息」层）===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const out=[],seen=new Set();
  /** 找「文本量大且可滚动」的容器 —— 那通常就是消息列表。 */
  for (const e of [...document.querySelectorAll('div')].filter(vis)) {
    const t=(e.innerText||'').trim();
    if(t.length<40 || t.length>6000) continue;
    const scrollable = e.scrollHeight > e.clientHeight + 20;
    if(!scrollable) continue;
    const k=String(e.className).slice(0,60);
    if(seen.has(k)) continue; seen.add(k);
    out.push({cls:String(e.className||'').slice(0,110),testid:e.getAttribute('data-testid'),len:t.length,childCount:e.children.length,head:t.slice(0,50).replace(/\\n/g,' ')});
    if(out.length>=10) break;
  }
  return JSON.stringify(out,null,1);
})()`));

console.log("\n=== ⑤ 页面里所有带 data-* 角色的元素 ===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const out=[],seen=new Set();
  for (const e of [...document.querySelectorAll('[data-role],[data-message-role],[data-testid]')].filter(vis)) {
    const k=(e.getAttribute('data-role')||'')+'|'+(e.getAttribute('data-message-role')||'')+'|'+(e.getAttribute('data-testid')||'');
    if(seen.has(k)) continue; seen.add(k);
    out.push(k);
    if(out.length>=25) break;
  }
  return JSON.stringify(out,null,1);
})()`));

try { ws.close(); } catch { /* 忽略 */ }
killByPort(PORT);
console.log("\n（探测用的 Edge 已关闭）");
