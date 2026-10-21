/** renameSession 没跑成功——查代码：runJob 第 11 步调 renameSession 时带的 Bearer 头格式对不对。
 *  思路：①等久一点（rename 在 runJob 尾部，job done 后还要跑几步）②检查 renameSession 的 expr ③必要时手动调一次 update_title 验证端点 + Bearer 组合。
 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 250); return r?.result?.value; };

/** 手动调 update_title：把「鉴权测试回复收到」改名 LDW 前缀——验证 Bearer+端点组合。
 *  （这同时就是 runJob 第 11 步该干的事——如果手动成功，说明 runJob 没调到或时序问题。）
 */
const raw = await evalIn(`(async () => {
  const t = localStorage.getItem('userToken');
  let token = t; try { token = JSON.parse(t).value ?? t; } catch {}
  // 先拿列表找目标
  const lr = await fetch('/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', {
    credentials: 'include', headers: { 'Authorization': 'Bearer ' + token }
  });
  const lj = await lr.json();
  const rows = lj?.data?.biz_data?.chat_sessions ?? [];
  const target = rows.find(s => String(s.title ?? '').includes('鉴权测试'));
  if (!target) return 'no-target（列表里没有那条）';
  // 调 update_title
  const rr = await fetch('/api/v0/chat_session/update_title', {
    method: 'POST', credentials: 'include',
    headers: { 'content-type': 'application/json', 'Authorization': 'Bearer ' + token },
    body: JSON.stringify({ chat_session_id: target.id, title: 'LDW ' + String(target.title).slice(0, 20) })
  });
  const rj = await rr.json().catch(() => ({}));
  return JSON.stringify({ status: rr.status, resp: JSON.stringify(rj).slice(0, 200), renamed: 'LDW ' + String(target.title).slice(0, 20) });
})()`);
console.log("手动 update_title:", String(raw));
try { ws.close(); } catch {}
