/** 比对令牌文件 vs LDW Edge localStorage 的 userToken——看注入是不是真写对了。
 *  另外从 LDW Edge 直接调 API 时 dump 请求头（看它实际带的 Authorization/自定义头长什么样）。
 */
const { readFileSync } = await import("node:fs");
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
/** ① 比对两个 token。 */
const fileLines = readFileSync("C:/Users/Evelyn/Desktop/肖浩成/小程序/Toekn管理/tokens/deepseek#cai-deepseek.txt", "utf8").split(/\r?\n/).filter(l => l.trim() !== "");
const fileToken = fileLines[0].trim();
const lsToken = String(await evalIn("localStorage.getItem('userToken') ?? ''"));
console.log("文件 token 尾8:", fileToken.slice(-8));
console.log("页面 token 尾8:", lsToken.slice(-8));
console.log("一致:", fileToken === lsToken ? "✅" : "❌ 不一致！");

/** ② dump 真实请求头——网页 JS 调 fetch_page 时带什么头。 */
const hdr = await evalIn(`(async () => {
  // 拦截一次真实请求看头
  const captured = {};
  const origSet = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.setRequestHeader = function(k, v) { captured[k] = v; return origSet.call(this, k, v); };
  try {
    await fetch('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' }).then(r => r.text());
  } catch {}
  XMLHttpRequest.prototype.setRequestHeader = origSet;
  // fetch 请求看不到头——换 Request 对象自省
  const req = new Request('/api/v0/chat_session/fetch_page?count=50&page=0', { credentials: 'include' });
  const cookieKeys = document.cookie.split(';').map(c => c.trim().split('=')[0]);
  return JSON.stringify({ ls: localStorage.getItem('userToken')?.slice(0, 20) ?? null, cookieKeys: cookieKeys.slice(0, 12) });
})()`);
console.log("页面状态:", String(hdr));

/** ③ 直查：用【cookie 里的 ds_session_id】作为权威性判断——它在令牌文件的 cookie 段里。 */
const cookieStr = fileLines.slice(1).join('; ');
const dsMatch = cookieStr.match(/ds_session_id=([^;]+)/);
const lsCookie = String(await evalIn("document.cookie"));
console.log("文件 ds_session_id 尾8:", dsMatch ? dsMatch[1].slice(-8) : '(无)');
console.log("页面 cookie 含同值:", dsMatch && lsCookie.includes(dsMatch[1]) ? "✅" : "❌");

try { ws.close(); } catch {}
