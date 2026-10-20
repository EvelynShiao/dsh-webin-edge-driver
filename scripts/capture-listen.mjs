/**
 * 抓包监听器（长跑版）：挂 CDP Network + 重载页面 → 你手动操作（改名/删除）→ 抓到请求就写盘。
 * 用法：node capture-listen.mjs <platform>
 * 跑起来后你去对应平台的 Edge 里手动：改名一条对话、删一条对话。
 * Ctrl+C 结束，抓到的请求存 webin/captures/<platform>-<ts>.json
 */
const platform = process.argv[2] ?? "yuanbao";
const PORT = 9411;
const OUT_DIR = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/webin/captures";
import { mkdirSync, writeFileSync } from "node:fs";

/** slot 名：cai 系列 */
const slot = platform === "yuanbao" ? "cai-yuanbao" : platform === "doubao" ? "cai-doubao" : "cai-deepseek";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 先让 webin 起 Edge（导航到平台页） */
const start = await fetch(`http://127.0.0.1:3080/dsh-webin/api/edge/start`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ platform, slot }),
}).then(r => r.json()).catch(e => ({ ok: false, reason: String(e) }));
console.log("edge/start:", start.ok === true ? "✅" : "❌ " + (start.reason ?? ""));
if (start.ok !== true) process.exit(1);
await sleep(20000);

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && new RegExp(platform).test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0;
const pending = new Map();
const captured = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent") {
    const u = m.params?.request?.url ?? "";
    if (/rumt|mcs\.|\/list$|\.js|\.css|\.png|\.woff|\.svg|log|track|collect|speed/i.test(u)) return;
    captured.push({
      ts: Date.now(),
      method: m.params?.request?.method,
      url: u.slice(0, 300),
      postData: String(m.params?.request?.postData ?? "").slice(0, 1000),
      requestId: m.params?.requestId,
    });
    console.log(`[${captured.length}] ${m.params?.request?.method} ${u.slice(-90)}`);
    if (m.params?.request?.postData) console.log(`     body: ${String(m.params.request.postData).slice(0, 200)}`);
  }
  if (m.method === "Network.responseReceived") {
    const rec = captured.find(c => c.requestId === m.params?.requestId && c.status === undefined);
    if (rec) rec.status = m.params?.response?.status;
  }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Network.enable");
console.log(`\n🎧 监听已挂（${platform}，Edge 已开）——你现在去 Edge 里手动操作：`);
console.log("   1. 侧栏找一条对话 → 悬停 → 点「…」→ 改名（改成什么都行）");
console.log("   2. 再挑一条 → 删除");
console.log("   每次操作大肥鱼都会实时打印抓到的请求。");
console.log("   操作完回来按 Ctrl+C，抓到的存到 captures/ 目录。\n");

/** 每 10 秒把已抓的写盘（防中途断） */
mkdirSync(OUT_DIR, { recursive: true });
const outPath = `${OUT_DIR}/${platform}-${Date.now()}.json`;
const flush = () => writeFileSync(outPath, JSON.stringify(captured, null, 1), "utf8");
setInterval(flush, 10000);
process.on("SIGINT", () => {
  flush();
  console.log(`\n✅ 存盘：${outPath}（${captured.length} 条请求）`);
  process.exit(0);
});
/** 长跑（最多 10 分钟自动存盘退出） */
setTimeout(() => { flush(); console.log(`\n⏰ 10 分钟到，存盘退出：${outPath}（${captured.length} 条）`); process.exit(0); }, 600000);
