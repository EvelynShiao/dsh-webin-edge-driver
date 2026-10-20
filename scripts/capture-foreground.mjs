/** 前台版抓包监听（不依赖 PowerShell job——上轮 job 句柄跨 shell 会丢）。
 *  直接前台跑 150 秒窗口，期间用户操作，抓到的打印+存盘。
 *  用法：node capture-foreground.mjs <platform>
 */
const platform = process.argv[2] ?? "deepseek";
const PORT = 9411;
const OUT_DIR = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/webin/captures";
import { mkdirSync, writeFileSync } from "node:fs";
const slot = platform === "yuanbao" ? "cai-yuanbao" : platform === "doubao" ? "cai-doubao" : "cai-deepseek";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Edge 已在跑（用户刚操作过）——直接连 CDP，不重启浏览器。 */
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && new RegExp(platform).test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
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
    if (/rumt|mcs\.|\/list$|\.js|\.css|\.png|\.woff|\.svg|log|track|collect|speed|_next\/static/i.test(u)) return;
    captured.push({
      ts: Date.now(),
      method: m.params?.request?.method,
      url: u.slice(0, 300),
      postData: String(m.params?.request?.postData ?? "").slice(0, 1200),
      requestId: m.params?.requestId,
    });
    console.log(`[${captured.length}] ${m.params?.request?.method} ${u.slice(-95)}`);
    if (m.params?.request?.postData) console.log(`     body: ${String(m.params.request.postData).slice(0, 250)}`);
  }
  if (m.method === "Network.responseReceived") {
    const rec = [...captured].reverse().find(c => c.requestId === m.params?.requestId && c.status === undefined);
    if (rec) rec.status = m.params?.response?.status;
  }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });

await send("Network.enable");
console.log(`🎧 已挂 ${platform}（前台 150 秒窗口）——你现在去 Edge 操作改名/删除，大肥鱼实时打印。`);
console.log("   （这轮抓你刚才的「LDW 测试」改名 + 接下来的删除）\n");

/** 150 秒收网 */
await sleep(150000);
mkdirSync(OUT_DIR, { recursive: true });
const outPath = `${OUT_DIR}/${platform}-${Date.now()}.json`;
writeFileSync(outPath, JSON.stringify(captured, null, 1), "utf8");
console.log(`\n✅ 存盘：${outPath}（${captured.length} 条）`);
