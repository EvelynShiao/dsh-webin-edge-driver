/** 导入令牌脚本：tokens/<平台>#<账号>.txt → webin PUT /credentials + POST /credentials/inject。
 *  用法：node import-tokens.mjs          （导入全部 cai- 系列）
 *        node import-tokens.mjs yuanbao  （只导 yuanbao）
 */
const TOK_DIR = "C:/Users/Evelyn/Desktop/肖浩成/小程序/Toekn管理/tokens";
const API = "http://127.0.0.1:3080/dsh-webin/api";
const only = process.argv[2] ?? "";

import { readdirSync, readFileSync } from "node:fs";

const files = readdirSync(TOK_DIR).filter(f => f.endsWith(".txt") && f.includes("#"));
const results = [];
for (const f of files) {
  const [plat, slot] = f.replace(".txt", "").split("#");
  if (only !== "" && plat !== only) continue;
  const lines = readFileSync(`${TOK_DIR}/${f}`, "utf8").split(/\r?\n/).filter(l => l.trim() !== "");
  /**
  * 格式适配（2026-10-20 实测破案）：
  *   deepseek：2 行 = [userToken JSON, cookie串]
  *   yuanbao/doubao：1 行 = [cookie串]（没有 token 行！）
  * 老逻辑一律 lines[0]=token ⇒ 元宝/豆包把 cookie 存进了 token 字段。
  * 判据：首行含 `=`/`;` 且非 JSON 信封 ⇒ 它就是 cookie。
  */
  const first = lines[0] ?? "";
  const firstIsCookie = /[;=]/.test(first) && !first.startsWith("{");
  const token = firstIsCookie ? "" : first;
  const cookie = firstIsCookie ? lines.join("; ") : lines.slice(1).join("; ");
  if (cookie === "" && token === "") { results.push({ f, skip: "empty" }); continue; }
  // ① PUT /credentials
  const put = await fetch(`${API}/credentials`, {
    method: "PUT",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: plat, slot, token, cookie }),
  }).then(r => r.json()).catch(e => ({ ok: false, reason: String(e) }));
  console.log(`${f}: PUT → ${put.ok === true ? "✅" : "❌ " + (put.reason ?? "")}`);
  if (put.ok !== true) { results.push({ f, put: false }); continue; }
  // ② POST /credentials/inject（真注入 + 探活）
  const inj = await fetch(`${API}/credentials/inject`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ platform: plat, slot }),
  }).then(r => r.json()).catch(e => ({ ok: false, reason: String(e) }));
  console.log(`   inject → ${inj.ok === true ? "✅ loggedIn=" + inj.loggedIn : "❌ " + (inj.reason ?? inj.message ?? "")}`);
  results.push({ f, put: true, inject: inj.ok === true, loggedIn: inj.loggedIn });
}
const okCount = results.filter(r => r.inject === true).length;
console.log(`\n导入完成：${okCount}/${results.length} 个登录成功`);
