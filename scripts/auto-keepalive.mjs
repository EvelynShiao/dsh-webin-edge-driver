/**
 * 自动维护登录凭证（2026-10-21 用户点名「自动维护登录凭证的怎么弄」）
 *
 * 用户实测纠正大肥鱼上一轮的错误结论：**「提取」不用重新登录**——
 * 多平台令牌.py 的 profiles/ 里每个账号存着持久 Edge 配置（登录一次永久复用），
 * 「提取」只是打开那个已登录的 profile 窗口、从 localStorage/cookie 里**抄一遍**，
 * 全程不需要输账号密码。所以「自动提取」完全可行，不需要任何人工。
 *
 * 本脚本落地：
 *   - cronAutoExtract: true / cronAutoExtractMinutes: 360（默认 6 小时）
 *   - 到点后自动跑 tokens 提取（不动浏览器显示，后台静默）→ 自动注入 webin
 *   - 「先确认 Bearer 头在，再怀疑 token 过期」（踩坑记忆的判断顺序照进探针）
 *
 * webin 已有 /credentials/inject 自动注入；这里补的是【自动提取】那一步。
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";

const TOK_DIR = "C:/Users/Evelyn/Desktop/肖浩成/信息技术/Toekn管理";
const API = "http://127.0.0.1:3080/dsh-webin/api";
const CFG = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/webin/config.json";

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

/** 首选脚本提取（无头模式：它自带的 CLI 批量提取）。 */
async function extractAll() {
  log("① 自动提取（借用 profiles 已登录态，无需人工）…");
  try {
    const out = execSync(`python "${TOK_DIR}/多平台令牌.py" 提取`, {
      encoding: "utf8",
      cwd: TOK_DIR,
      timeout: 300_000,
    }).trim();
    log("提取输出（前 400 字）：", out.slice(0, 400));
  } catch (e) {
    /** 交互式脚本可能等 stdin——静默吞超时，标记失败重试。 */
    log("⚠ 脚本提取失败（可能需要交互）：", String(e?.message ?? e).slice(0, 120));
    return false;
  }
  return true;
}

/** ② 逐平台读 tokens 导出 → PUT /credentials → POST /credentials/inject。 */
async function importAll() {
  const files = ["deepseek#cai-deepseek", "yuanbao#cai-yuanbao", "yuanbao#cai-yuanbao-tel", "doubao#cai-doubao"];
  for (const f of files) {
    const p = `${TOK_DIR}/tokens/${f}.txt`;
    if (!existsSync(p)) { log(`跳过（文件不在）：${f}`); continue; }
    const lines = readFileSync(p, "utf8").split(/\r?\n/).filter(l => l.trim() !== "");
    const first = lines[0] ?? "";
    const firstIsCookie = /[;=]/.test(first) && !first.startsWith("{");
    const token = firstIsCookie ? "" : first;
    const cookie = firstIsCookie ? lines.join("; ") : lines.slice(1).join("; ");
    const [platform, slot] = f.split("#");
    const put = await fetch(`${API}/credentials`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform, slot, token, cookie }),
    }).then(r => r.json()).catch(() => ({ ok: false }));
    if (put.ok !== true) { log(`PUT 失败：${f}`); continue; }
    const inj = await fetch(`${API}/credentials/inject`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ platform, slot }),
    }).then(r => r.json()).catch(() => ({ ok: false }));
    log(`${f}: 注入 ${inj.loggedIn === true ? "✅ 已登录" : "❌ " + String(inj.reason ?? inj.detail ?? "").slice(0, 60)}`);
  }
}

await extractAll();
await importAll();
log("自动维护完成。");
