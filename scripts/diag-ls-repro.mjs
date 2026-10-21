/** 复现 listSessions（驱动器同款 expr+Bearer）——看在登录后页面里能不能拿到列表。 */
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
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 250); return r?.result?.value; };

let cur = String(await evalIn("location.href"));
if (!/chat\.deepseek\.com/.test(cur)) { console.log("导航…"); await evalIn("location.href='https://chat.deepseek.com/'"); await sleep(10000); }
console.log("URL:", String(await evalIn("location.href")).slice(0, 50));

/** listSessions 同款（带 Bearer——驱动的 listPath 是 fetch_page?count=50&page=N 不是 lte_cursor 版） */
const raw = await evalIn(`(async () => {
  const bearer = (() => { try { const t = localStorage.getItem('userToken'); return t ? 'Bearer ' + (JSON.parse(t).value ?? t) : ''; } catch (e) { return ''; } })();
  const cfg = { listPath: '/api/v0/chat_session/fetch_page?count=50&page={page}', rowsPath: 'data.biz_data.chat_sessions', morePath: 'data.biz_data.has_more' };
  const out = [];
  for (let page = 0; page < 10; page++) {
    const u = cfg.listPath.replace('{page}', String(page));
    const r = await fetch(u, { credentials: 'include', headers: { 'Authorization': bearer } });
    if (!r.ok) break;
    const j = await r.json();
    const rows = cfg.rowsPath.split('.').reduce((v, k) => v?.[k], j);
    if (!Array.isArray(rows) || rows.length === 0) break;
    for (const s of rows) out.push({ id: s.id, title: s.title, pinned: s.pinned === true });
    const more = cfg.morePath ? cfg.morePath.split('.').reduce((v, k) => v?.[k], j) : false;
    if (!more) break;
  }
  return JSON.stringify({ n: out.length, first: String(out[0]?.title ?? "").slice(0, 30), bearer: bearer !== "" ? "有" : "空" });
})()`);
console.log("listSessions 复现:", String(raw));
try { ws.close(); } catch {}
