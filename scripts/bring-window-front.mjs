/**
 * 把插件的 Edge 窗口**拽回屏幕内并置顶**。
 *
 *   node scripts/bring-window-front.mjs [端口=9411]
 *
 * ## 为什么需要它
 *
 * 插件默认 `hideWindow: true`，启动参数是 `--window-position=-24000,-24000`
 * （屏幕外）。Chromium 会**记住窗口位置**，所以即使后来把 hideWindow 改成 false，
 * 那个 profile 下次开窗仍可能回到屏幕外 —— 用户看到的就是「窗口打不开」。
 *
 * 这个脚本用 CDP 直接改窗口 bounds（拉到 80,60）并 bringToFront，
 * 是唯一能**确定**把它弄到眼前的办法（不依赖操作系统的窗口枚举）。
 */
const PORT = Number(process.argv[2] ?? 9411);
/** 可选：把页面导航到这个地址（召唤登录窗时用 —— /edge/start 只起浏览器，不导航）。 */
const NAV = process.argv[3] ?? "";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  let ver;
  try {
    ver = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  } catch (e) {
    console.log(`❌ 端口 ${PORT} 上没有 Edge（CDP 连不上）：${String(e?.message ?? e)}`);
    console.log("   先调 /edge/start 把浏览器起起来。");
    process.exit(1);
  }
  console.log(`  Edge: ${ver.Browser}`);

  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((t) => t.type === "page");
  if (!page) { console.log("❌ 没有 page target"); process.exit(1); }
  console.log(`  页面: ${page.url}`);

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => { ws.addEventListener("open", res); ws.addEventListener("error", rej); });
  ws.addEventListener("message", (ev) => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((res) => {
    const i = ++id; pending.set(i, res); ws.send(JSON.stringify({ id: i, method, params }));
  });

  /** 先看窗口现在在哪 —— 这决定了「打不开」到底是不是位置问题。 */
  const win = await send("Browser.getWindowForTarget", { targetId: page.id });
  const winId = win?.result?.windowId;
  const before = win?.result?.bounds ?? null;
  console.log(`  窗口 id=${winId}  当前 bounds=${JSON.stringify(before)}`);

  if (winId === undefined) { console.log("❌ 拿不到 windowId"); ws.close(); process.exit(1); }

  /** 拉到屏幕内（与 driver 的 setWindowVisible(false) 同一组坐标）。 */
  await send("Browser.setWindowBounds", {
    windowId: winId,
    bounds: { left: 80, top: 60, width: 1100, height: 820, windowState: "normal" },
  });
  await sleep(400);
  /** 再置顶：光挪位置不够，它在别的窗口后面你也看不见。 */
  await send("Page.bringToFront", {});
  await sleep(400);

  /** 需要时导航到指定地址（登录窗必须落在登录页上，否则你看到的是空白页）。 */
  if (NAV !== "") {
    await send("Page.navigate", { url: NAV });
    await sleep(3500);
    const t = String(await (async () => {
      const r = await send("Runtime.evaluate", { expression: "location.href", returnByValue: true });
      return r?.result?.result?.value ?? "";
    })());
    console.log("  导航到: " + t);
  }

  const after = (await send("Browser.getWindowForTarget", { targetId: page.id }))?.result?.bounds ?? null;
  console.log(`  调整后 bounds=${JSON.stringify(after)}`);
  ws.close();

  const ok = after !== null && after.left > -10000 && after.top > -10000;
  console.log(ok
    ? "  ✅ 窗口已移到屏幕内并置顶 —— 应该能看见了"
    : "  ⚠️ 位置看起来还在屏幕外，请把上面那行 bounds 发我");
  process.exit(ok ? 0 : 1);
}

main().catch((e) => { console.log("❌ " + String(e?.message ?? e)); process.exit(1); });
