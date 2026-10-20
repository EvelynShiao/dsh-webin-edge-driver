/** 前台抓包 v2：连【用户手动开的登录窗口】（10880）——不动驱动、不起新浏览器。
 *  用法：node capture-10880.mjs
 *  150 秒窗口：期间用户在该窗口改名一条 + 删一条。
 */
const PORT = 10880;
const OUT_DIR = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/webin/captures";
import { mkdirSync, writeFileSync } from "node:fs";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url));
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
console.log("🎧 连上你的窗口:", String(page.url).slice(0, 60));
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
    if (/rumt|mcs\.|\.js|\.css|\.png|\.woff|\.svg|log|track|collect|speed|_next\/static|jquery/i.test(u)) return;
    captured.push({
      ts: Date.now(),
      method: m.params?.request?.method,
      url: u.slice(0, 300),
      postData: String(m.params?.request?.postData ?? "").slice(0, 1500),
      requestId: m.params?.requestId,
    });
    console.log(`[${captured.length}] ${m.params?.request?.method} ${u.slice(-100)}`);
    if (m.params?.request?.postData) console.log(`     body: ${String(m.params.request.postData).slice(0, 300)}`);
  }
  if (m.method === "Network.responseReceived") {
    const rec = [...captured].reverse().find(c => c.requestId === m.params?.requestId && c.status === undefined);
    if (rec) rec.status = m.params?.response?.status;
  }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Network.enable");
console.log("\n🎧🎧 150 秒监听已挂到你手上的窗口——现在去操作：");
console.log("   1. 把「LDW 测试」再改一次名（比如「LDW 测试2」）");
console.log("   2. 删一条不要的对话");
console.log("   大肥鱼实时打印。开始！\n");

await sleep(150000);
mkdirSync(OUT_DIR, { recursive: true });
const outPath = `${OUT_DIR}/deepseek-manual-${Date.now()}.json`;
writeFileSync(outPath, JSON.stringify(captured, null, 1), "utf8");
console.log(`\n✅ 存盘：${outPath}（${captured.length} 条）`);
