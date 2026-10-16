/**
 * 元宝「模型选择」DOM 探测。
 *
 * 目标：找出 ①打开模型选择器的按钮 ②选项列表 ③选项文案 ④当前选中判据。
 * 背景：元宝输入框附近 6 层内全是陷阱按钮（添加/切换模型/AI 生图/写作/解题/
 * 深度研究/PPT 生成/数据分析/更多），所以**不能靠几何打分去点**，必须拿到
 * 稳定的语义选择器。
 *
 * 只探测，不改配置。
 */
import { spawn, execSync } from "node:child_process";

const EXE = "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe";
const DIR = "C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\edge-ldw\\yuanbao";
const PORT = 9421;
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
await send("Page.navigate", { url: "https://yuanbao.tencent.com/" });
await sleep(14000);

console.log("=== ① 登录态 ===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  return JSON.stringify({
    url: location.href,
    ql: document.querySelectorAll('div.ql-editor').length,
    loginUi: [...document.querySelectorAll('button.agent-dialogue__tool__login,.hyc-phone-login__btn')].some(vis)
  });
})()`));

console.log("\n=== ② 输入区附近所有可见可点元素（找「切换模型」）===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const ed=document.querySelector('div.ql-editor');
  if(!ed) return 'no-editor';
  let box=ed;
  for(let i=0;i<6 && box.parentElement;i++) box=box.parentElement;
  const out=[],seen=new Set();
  for(const e of box.querySelectorAll('button,[role="button"],[class*="tool"],[class*="model"],[class*="switch"]')) {
    if(!vis(e)) continue;
    const t=(e.innerText||'').trim().slice(0,24);
    const k=e.tagName+'|'+t+'|'+String(e.className).slice(0,40);
    if(seen.has(k)) continue; seen.add(k);
    out.push({tag:e.tagName, cls:String(e.className||'').slice(0,70), aria:e.getAttribute('aria-label'), text:t});
    if(out.length>=28) break;
  }
  return JSON.stringify(out,null,1);
})()`));

console.log("\n=== ③ 页面里带「模型」字样的可见元素 ===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const out=[],seen=new Set();
  for(const e of document.querySelectorAll('div,span,button')) {
    if(!vis(e)) continue;
    const t=(e.innerText||'').trim();
    if(t.length===0||t.length>24) continue;
    if(!/模型|思考|智能|联网|混元|DeepSeek|R1|T1/.test(t)) continue;
    const k=e.tagName+'|'+t;
    if(seen.has(k)) continue; seen.add(k);
    out.push({tag:e.tagName, cls:String(e.className||'').slice(0,70), text:t, clickable: !!(e.onclick||e.closest('button,[role="button"]'))});
    if(out.length>=24) break;
  }
  return JSON.stringify(out,null,1);
})()`));

console.log("\n=== ④ 试着点「切换模型」看会不会弹出面板 ===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const cands=[...document.querySelectorAll('button,[role="button"],div,span')].filter(e=>vis(e) && /切换模型/.test(e.innerText||''));
  if(cands.length===0) return '没找到「切换模型」字样';
  /** 取最内层那个（外壳 div 也含同样文字）。 */
  const el=cands[cands.length-1];
  el.click();
  return 'clicked: '+el.tagName+' '+(el.className||'').toString().slice(0,50);
})()`));
await sleep(2500);

console.log("\n=== ⑤ 点击后新出现的面板内容（模型选项）===");
console.log(await evalIn(`(() => {
  const vis=(e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length));
  const out=[],seen=new Set();
  for(const e of document.querySelectorAll('[class*="popup"],[class*="panel"],[class*="dropdown"],[class*="menu"],[class*="model"],[role="dialog"],[role="menu"]')) {
    if(!vis(e)) continue;
    const t=(e.innerText||'').trim();
    if(t.length<2) continue;
    const k=String(e.className).slice(0,50)+'|'+t.slice(0,20);
    if(seen.has(k)) continue; seen.add(k);
    out.push({cls:String(e.className||'').slice(0,90), role:e.getAttribute('role')||'', len:t.length, text:t.slice(0,120).replace(/\\n/g,' / ')});
    if(out.length>=14) break;
  }
  return JSON.stringify(out,null,1);
})()`));

try { ws.close(); } catch { /* 忽略 */ }
killByPort(PORT);
console.log("\n（探测用的 Edge 已关闭）");
