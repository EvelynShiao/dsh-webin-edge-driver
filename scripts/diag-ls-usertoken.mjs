/** INVALID_TOKEN 还在——检查 localStorage.userToken 是否真写上了（DSH 注入要求 userToken+cookie 两半）。
 *  令牌文件的第一行是 JSON 信封 {"value":"...","__version":"0"}——注入的 token 参数应该就是这个信封。
 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res) => { const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR"; return r?.result?.value; };

const probe = await evalIn(`(() => {
  const t = localStorage.getItem('userToken');
  return JSON.stringify({ has: t !== null, head: String(t ?? '').slice(0, 60) });
})()`);
console.log("localStorage.userToken:", String(probe));

/** 如果没有：直接写（信封原文）+ reload。 */
if (!String(probe).includes('"has":true')) {
  const { readFileSync } = await import("node:fs");
  const lines = readFileSync("C:/Users/Evelyn/Desktop/肖浩成/小程序/Toekn管理/tokens/deepseek#cai-deepseek.txt", "utf8").split(/\r?\n/).filter(l => l.trim() !== "");
  const tokenEnvelope = lines[0];
  console.log("写入 localStorage…", tokenEnvelope.slice(0, 50));
  await evalIn(`localStorage.setItem('userToken', ${JSON.stringify(tokenEnvelope)}); 'written'`);
  await send("Page.enable");
  await send("Page.reload", { ignoreCache: true });
  await sleep(8000);
  const raw = await evalIn(`(async () => {
    const r = await fetch('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' });
    const text = await r.text();
    return JSON.stringify({ status: r.status, head: text.slice(0, 300) });
  })()`);
  console.log("再查:", String(raw));
} else {
  const raw = await evalIn(`(async () => {
    const r = await fetch('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' });
    return JSON.stringify({ status: r.status, head: (await r.text()).slice(0, 300) });
  })()`);
  console.log("userToken 在但还 INVALID——可能是 token 本身过期:", String(raw));
}
try { ws.close(); } catch {}
