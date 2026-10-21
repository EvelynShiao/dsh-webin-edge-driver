/** 从 DOM 侧栏读会话标题（不依赖 API token）——验证 update_title 自动改名是否生效。 */
const PORT = 9412;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
const page = list.find(t => t.type === "page" && /chat\.deepseek\.com/.test(t.url)) ?? list.find(t => t.type === "page");
if (!page) { console.log("NO_PAGE"); process.exit(1); }
const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise(r => ws.addEventListener("open", () => r()));
let id = 0; const pending = new Map();
ws.addEventListener("message", (ev) => { const m = JSON.parse(ev.data); if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); } });
const send = (method, params = {}) => new Promise((res, rej) => { const i = ++id; pending.set(i, (m) => { if (m.error) rej(new Error(m.error.message)); else res(m.result); }); ws.send(JSON.stringify({ id: i, method, params })); });
const evalIn = async (e) => { const r = await send("Runtime.evaluate", { expression: e, returnByValue: true, awaitPromise: true }); if (r?.exceptionDetails) return "ERR: " + String(r.exceptionDetails.exception?.description ?? "").slice(0, 200); return r?.result?.value; };

let cur = String(await evalIn("location.href"));
if (!/chat\.deepseek\.com/.test(cur)) { await evalIn("location.href='https://chat.deepseek.com/'"); await sleep(10000); }
console.log("URL:", String(await evalIn("location.href")).slice(0, 50));

/** DeepSeek 侧栏结构（实测）：菜单项是带 link 的 div/a——读全部短文本找会话标题。 */
const titles = await evalIn(`(() => {
  const vis = e => !!(e.offsetWidth || e.offsetHeight || e.getClientRects().length);
  const out = [];
  const seen = new Set();
  for (const e of document.querySelectorAll('a, div, li, span')) {
    if (!vis(e)) continue;
    if (e.children.length > 0) continue; // 叶子节点
    const t = String(e.textContent ?? '').trim();
    if (t.length < 2 || t.length > 60) continue;
    if (/^(新对话|搜索|登录|设置|API|分享|APP|深色|浅色|历史)$/.test(t)) continue;
    const k = t.slice(0, 40);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(t);
    if (out.length >= 15) break;
  }
  return JSON.stringify(out);
})()`);
try {
  const list2 = JSON.parse(String(titles));
  console.log("\n侧栏可见文本（前 15）：");
  for (const t of list2) console.log("  " + t.slice(0, 50));
  const ldw = list2.filter(t => /^LDW/.test(t));
  console.log(`\nLDW 前缀: ${ldw.length} 个 ${ldw.length > 0 ? "✅ update_title 自动改名生效！" : "❌（可能 update_title 用了同个失效 API——403 时静默失败）"}`);
} catch { console.log("解析失败:", String(titles).slice(0, 200)); }
try { ws.close(); } catch {}
