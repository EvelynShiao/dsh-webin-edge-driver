/** 清网页端测试对话（删标题含测试特征的：自动测试/测试消息/测试确认/收到/验证/确认——保留 LDW 前缀的）。
 *  用 ids-array delete（Bearer）。
 */
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
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.value; };

let cur = String(await evalIn("location.href"));
if (!/chat\.deepseek\.com/.test(cur)) { console.log("导航…"); await evalIn("location.href='https://chat.deepseek.com/'"); await sleep(10000); }

const raw = await evalIn(`(async () => {
  const t = localStorage.getItem('userToken');
  let token = t; try { token = JSON.parse(t).value ?? t; } catch {}
  const H = { 'Authorization': 'Bearer ' + token };
  // 拉列表
  const lr = await fetch('/api/v0/chat_session/fetch_page?lte_cursor.pinned=false', { credentials: 'include', headers: H });
  const lj = await lr.json();
  const all = lj?.data?.biz_data?.chat_sessions ?? [];
  // 测试特征（保留 LDW 前缀的——那是「该留」的标记样本）
  const isTest = (title) => /自动测试|测试消息|测试确认|测试会话|附件与协议|生成会话标题|问候回应|鉴权测试|改名验证|三真凶|最终验证|收到$|^确认/.test(String(title ?? ''));
  const targets = all.filter(s => !s.pinned && !/^LDW/i.test(s.title ?? '') && isTest(s.title));
  const keep = all.filter(s => /^LDW/i.test(s.title ?? ''));
  const removed = [];
  for (const s of targets) {
    const dr = await fetch('/api/v0/chat_session/delete', {
      method: 'POST', credentials: 'include',
      headers: { 'content-type': 'application/json', ...H },
      body: JSON.stringify({ chat_session_ids: [s.id] })
    });
    const dj = await dr.json().catch(() => ({}));
    if (dj?.code === 0) removed.push(String(s.title).slice(0, 30));
    await new Promise(r => setTimeout(r, 700));
  }
  return JSON.stringify({ total: all.length, removed, keptLdw: keep.map(s => String(s.title).slice(0, 35)) }, null, 1);
})()`);
try {
  const r = JSON.parse(String(raw));
  console.log(`列表总数: ${r.total}`);
  console.log(`已删 ${r.removed.length} 条:`);
  for (const t of r.removed) console.log(`  🗑 ${t}`);
  console.log(`保留 LDW ${r.keptLdw.length} 条:`);
  for (const t of r.keptLdw) console.log(`  ⭐ ${t}`);
} catch { console.log("结果:", String(raw).slice(0, 400)); }
try { ws.close(); } catch {}
