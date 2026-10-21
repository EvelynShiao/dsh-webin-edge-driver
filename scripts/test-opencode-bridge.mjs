/** OpenCode 桥接全链验证：杀掉服务 → serviceInfo 应自动拉起 → generateText 出活。 */
import { pathToFileURL } from "node:url";
const basePath = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/profiles/web/node_modules/dsh-our-free-model/src/local-opencode.js";
const mod = await import(pathToFileURL(basePath).href);
const { serviceInfo, generateText } = mod;
import { execSync } from "node:child_process";

// ① 杀掉服务（模拟闪退现场：服务死后 service.json 指向死端口）
try { execSync('powershell -NoProfile -Command "Get-Process | Where-Object { $_.Name -match \'opencode\' } | Stop-Process -Force -ErrorAction SilentlyContinue"', { encoding: "utf8" }); console.log("① 服务已杀"); } catch { console.log("① 杀失败（可能本来就没跑）"); }
await new Promise(r => setTimeout(r, 1500));

// ② serviceInfo 应该自动拉起并等到就绪
const t0 = Date.now();
const svc = await serviceInfo();
console.log(`② serviceInfo（${Date.now() - t0}ms）:`, svc ? "✅ url=" + svc.url : "❌ null");

// ③ generateText 真跑一条（mimo）
if (svc) {
  try {
    const text = await generateText({ key: "selftest-" + Date.now(), modelId: "mimo-v2.6-flash-free", messages: [{ role: "user", content: "回复「收到」两个字" }] });
    console.log("③ generateText:", text.length > 0 ? "✅ 回复=" + text.slice(0, 80) : "⚠️ 空文本");
  } catch (e) {
    console.log("③ generateText ❌:", String(e?.message ?? e).slice(0, 150));
  }
}
process.exit(0);
