/** 真最终验证收尾：查列表看「三真凶修复版最终验证」是否变「LDW …」。 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const start = await fetch("http://127.0.0.1:3080/dsh-webin/api/edge/start", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ platform: "deepseek", slot: "cai-deepseek" }),
}).then(r => r.json()).catch(() => ({ ok: false }));
if (start.ok !== true) { console.log("edge/start ❌"); process.exit(1); }
await sleep(18000);
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR"; return r?.result?.value; };

let cur = String(await evalIn("location.href"));
if (!/chat\.deepseek\.com/.test(cur)) { await evalIn("location.href='https://chat.deepseek.com/'"); await sleep(10000); }
/** 改名在 runJob 尾部——多等一会。 */
await sleep(10000);

const raw = await evalIn(`(async () => {
  const t = localStorage.getItem('userToken');
  let token = t; try { token = JSON.parse(t).value ?? t; } catch {}
  const r = await fetch('/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', {
    credentials: 'include', headers: { 'Authorization': 'Bearer ' + token }
  });
  const j = await r.json();
  return JSON.stringify((j?.data?.biz_data?.chat_sessions ?? []).slice(0, 6).map(s => String(s.title ?? '').slice(0, 50)));
})()`);
try {
  const titles = JSON.parse(String(raw));
  console.log("最新 6 条:");
  for (const t of titles) console.log("  " + t);
  const hit = titles.find(t => /^LDW .*(三真凶|最终验证|收到)/i.test(t));
  console.log(`\n${"=".repeat(55)}`);
  console.log(hit ? `🎉🎉🎉 自动改名全链路通了！\n  ⭐ ${hit}` : "❌ 还没改名");
} catch { console.log("解析失败:", String(raw).slice(0, 200)); }
try { ws.close(); } catch {}
