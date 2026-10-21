/** 网络监听：reload 后 dump 全部 /api/ 请求——看页面 JS 现在自己调什么列表接口。 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
const reqs = [];
ws.addEventListener("message", (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); return; }
  if (m.method === "Network.requestWillBeSent") {
    const u = m.params?.request?.url ?? "";
    if (/chat\.deepseek\.com\/api\//.test(u) && !/telemetry|log/.test(u)) {
      reqs.push({ u: u.slice(0, 130), method: m.params?.request?.method });
    }
  }
});
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });

let cur = null;
try { cur = String((await send("Runtime.evaluate", { expression: "location.href", returnByValue: true })).result?.value); } catch {}
if (!cur || !/chat\.deepseek\.com/.test(cur)) {
  await send("Runtime.evaluate", { expression: "location.href='https://chat.deepseek.com/'" }).catch(() => {});
  await sleep(10000);
}

await send("Network.enable");
await send("Page.enable");
await send("Page.reload", { ignoreCache: true });
console.log("reloaded — 等 10 秒收集请求…");
await sleep(10000);
console.log(`\n页面自己调的 API（${reqs.length} 个）：`);
for (const r of reqs.slice(0, 15)) console.log(`  [${r.method}] ${r.u}`);
const listApi = reqs.find(r => /session|list|conv/i.test(r.u) && r.method === "GET");
if (listApi) console.log(`\n⭐ 列表接口实锤: ${listApi.u}`);
try { ws.close(); } catch {}
