/** 检查「开机自动维护提取最新 token/cookie」机制：看多平台令牌.py 有没有自启任务（计划任务/启动项），以及 DSH 配置里有没有 auto 提取钩子。 */
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { execSync } from "node:child_process";

console.log("=== ① Windows 计划任务里有没有令牌相关 ===");
try {
  const out = execSync('schtasks /query /fo csv | findstr /i "token opencode 令牌 Toekn"', { encoding: "utf8", shell: "powershell" }).catch?.(() => "");
  console.log(String(out) || "（无）");
} catch { console.log("（无匹配计划任务）"); }

console.log("\n=== ② 启动文件夹 ===");
const startup = process.env.APPDATA + "\\Microsoft\\Windows\\Start Menu\\Programs\\Startup";
if (existsSync(startup)) for (const f of readdirSync(startup)) console.log("  " + f);

console.log("\n=== ③ 多平台令牌.py 里的开机自提逻辑（搜 schedule/startup/开机/auto）===");
const py = readFileSync("C:/Users/Evelyn/Desktop/肖浩成/小程序/Toekn管理/多平台令牌.py", "utf8");
const hits = py.split(/\r?\n/).filter(l => /schedule|开机|自启|startup|autorun|task|loop|every|interval/i.test(l)).slice(0, 12);
for (const h of hits) console.log("  " + h.trim().slice(0, 100));
if (hits.length === 0) console.log("（脚本里没有定时/开机逻辑——它是交互式工具，只有你手动跑才提取）");

console.log("\n=== ④ DSH 配置里有没有 token 相关的定时任务 ===");
const dshConfig = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/profiles/web/cordis.patch.yml", "utf8");
const dshHits = dshConfig.split(/\r?\n/).filter(l => /token|credential|refresh|extract|提取/i.test(l)).slice(0, 6);
for (const h of dshHits) console.log("  " + h.trim().slice(0, 90));
if (dshHits.length === 0) console.log("（profile patch 无 token 自动化）");
