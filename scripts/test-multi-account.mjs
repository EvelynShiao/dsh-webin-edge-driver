/**
 * 端到端验证「同站多账号 + 粘贴凭据登录」。
 *
 * 流程（全程不打印任何凭据明文）：
 *   1. 从统一凭据文件读出 deepseek#奶奶 的 token/cookie
 *   2. 当作新槽位 deepseek#second 的凭据写进文件
 *   3. 给 deepseek 加槽位 second（走 /accounts）
 *   4. 调 /credentials/inject 让它在**自己的 profile 目录**里登录
 *   5. 核对：新 profile 真的独立落盘、且登录成功
 *
 * 为什么槽位名用 ASCII：槽位名有 `[A-Za-z0-9_-]{1,64}` 白名单校验
 * （它会进快照文件名与 profile 目录名），中文会被静默丢弃。
 */
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

const B = "http://127.0.0.1:3080/dsh-webin/api";
const STORE = "C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\webin\\credentials.json";
const EDGE_BASE = "C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\edge-ldw";

const j = async (url, init) => {
  const r = await fetch(url, init);
  const t = await r.text();
  try { return { status: r.status, body: JSON.parse(t) }; } catch { return { status: r.status, body: t }; }
};
const post = (u, o) => j(u, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const put = (u, o) => j(u, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

// ── 1. 读源凭据（不打印内容）────────────────────────────────
const store = JSON.parse(readFileSync(STORE, "utf8"));
const src = store.accounts?.deepseek?.奶奶;
if (src === undefined) { console.log("❌ 凭据文件里没有 deepseek#奶奶"); process.exit(1); }
console.log(`① 源凭据 deepseek#奶奶: token ${src.tokenLen} / cookie ${src.cookieLen} 字符`);

// ── 2. 写成新槽位 ───────────────────────────────────────────
const w = await put(`${B}/credentials`, { platform: "deepseek", slot: "second", token: src.token, cookie: src.cookie });
console.log(`② 写入 deepseek#second: status=${w.status} ok=${w.body?.ok}（token ${w.body?.account?.tokenLen} / cookie ${w.body?.account?.cookieLen}）`);

// ── 3. 加槽位 ───────────────────────────────────────────────
const a = await put(`${B}/accounts`, { platform: "deepseek", slots: ["default", "second"], active: "default" });
console.log(`③ /accounts 结果: slots=[${a.body?.slots?.join(", ")}] active=${a.body?.active}`);

// ── 4. 注入登录（在它自己的 profile 里）──────────────────────
console.log("④ 注入登录中（会起一个独立 profile 的 Edge，请稍候）…");
const inj = await post(`${B}/credentials/inject`, { platform: "deepseek", slot: "second" });
console.log(`   status=${inj.status}`);
console.log(`   loggedIn=${inj.body?.loggedIn}  cookieSet=${inj.body?.cookieSet}  localStorageSet=${JSON.stringify(inj.body?.localStorageSet)}`);
console.log(`   url=${inj.body?.url}`);
console.log(`   detail=${inj.body?.detail}`);

// ── 5. 核对 profile 隔离 ────────────────────────────────────
console.log("\n⑤ profile 目录隔离核对：");
for (const dir of ["deepseek", "deepseek\\second"]) {
  const abs = join(EDGE_BASE, dir);
  const ck = join(abs, "Default", "Network", "Cookies");
  console.log(`   ${dir.padEnd(18)} 存在=${existsSync(abs)}  cookie库=${existsSync(ck) ? (readFileSync ? "" : "") : "无"}`);
}
const secDir = join(EDGE_BASE, "deepseek", "second");
if (existsSync(secDir)) {
  console.log(`   deepseek\\second 下的条目: ${readdirSync(secDir).slice(0, 6).join(", ")} …`);
}

// ── 6. 最终账号状态 ─────────────────────────────────────────
const c = await j(`${B}/credentials`);
console.log("\n⑥ 凭据文件现状：");
for (const x of c.body?.accounts ?? []) {
  console.log(`   ${x.platform}#${x.slot}  token=${x.tokenLen} cookie=${x.cookieLen}  已验证=${x.lastVerify ? (x.lastVerify.ok ? "✅成功" : "❌失败") : "未验证"}`);
}
const acc = await j(`${B}/accounts`);
const ds = (acc.body?.platforms ?? []).find((p) => p.platform === "deepseek");
console.log(`\n⑦ deepseek 槽位: [${ds?.slots?.join(", ")}]  active=${ds?.active}`);
for (const s of ds?.slotStatus ?? []) console.log(`   ${s.slot.padEnd(10)} loggedIn=${s.loggedIn}  via=${s.via ?? "-"}`);
