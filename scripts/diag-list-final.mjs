/** 列表终查 v4：导航 → userToken → fetch_page。 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE:", list.map(t => t.url).join(",")); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.value; };

let cur = String(await evalIn("location.href"));
if (!/chat\.deepseek\.com/.test(cur)) { console.log("导航…"); await evalIn("location.href='https://chat.deepseek.com/'"); await sleep(10000); }
console.log("URL:", String(await evalIn("location.href")).slice(0, 50));

const probe = String(await evalIn("(() => { const t = localStorage.getItem('userToken'); return t ? '在(' + t.length + '字符)' : '不在'; })()"));
console.log("userToken:", probe);

if (probe.startsWith("在")) {
  const raw = await evalIn("fetch('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' }).then(r => r.text()).then(t => t.slice(0, 300))");
  console.log("列表:", String(raw));
  if (String(raw).startsWith("{") && !String(raw).includes("INVALID")) {
    const full = await evalIn("fetch('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' }).then(r => r.json()).then(j => JSON.stringify((j?.data?.biz_data?.chat_sessions ?? []).map(s => ({ t: String(s.title ?? '').slice(0, 40), p: s.pinned === true }))))");
    try {
      const sessions = JSON.parse(String(full));
      console.log("\n最新会话：");
      for (const s of sessions.slice(0, 6)) console.log(`  ${s.p ? "📌" : "  "} ${s.t}`);
      const ldw = sessions.filter(s => /^LDW/.test(s.t));
      console.log(`\nLDW 前缀: ${ldw.length} 个 ${ldw.length > 0 ? "✅" : "❌"}`);
    } catch { console.log("解析失败"); }
  }
} else {
  console.log("userToken 不在——需要重新注入（DSH credentials/inject 只写 cookie 没写 localStorage？检查 injectCredentials 的 keys 配置）");
}
try { ws.close(); } catch {}
