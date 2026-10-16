/**
 * 账号管理 CLI
 * ============
 *
 * 用法（在本仓库目录下）：
 *
 *   node scripts/accounts.mjs list
 *       列出所有平台的槽位、登录态、凭据状况
 *
 *   node scripts/accounts.mjs add <平台> <槽位>
 *       新增一个账号槽位（例：node scripts/accounts.mjs add deepseek 工作号）
 *
 *   node scripts/accounts.mjs switch <平台> <槽位>
 *       切换该平台当前生效的槽位（派任务时用它）
 *
 *   node scripts/accounts.mjs rm <平台> <槽位>
 *       删掉槽位（连同它的凭据；浏览器 profile 目录会保留，方便日后再登）
 *
 *   node scripts/accounts.mjs import <平台> <槽位> <文件> [--login]
 *       从**两行文本**导入凭据（第 1 行 token、第 2 行 cookie）。
 *       正好兼容桌面那个 `chat.deepseek.com令牌.py` 导出的
 *       `tokens/<名字>.txt` 格式：
 *         node scripts/accounts.mjs import deepseek 工作号 "C:\...\tokens\工作号.txt" --login
 *
 *   node scripts/accounts.mjs login <平台> <槽位>
 *       用凭据文件里存的凭据**注入登录**（不必开浏览器扫码），并用页面
 *       探针验证；凭据过期会如实报失败。
 *
 * ## 关于「验不过」怎么看
 *
 * `login` 会显示 token/cookie 的长度（**不显示内容**）与探针结果。
 * 报失败时基本就是凭据过期了 —— 去重新导出一次即可。
 * 想判断「这个站的凭据多久轮换一次」，看 `list` 里的轮换频率。
 *
 * ## 为什么不直接把凭据打在命令行上
 *
 * 命令行会进 shell 历史、也会出现在进程列表里。所以这个工具**只从文件读**
 * 凭据 —— 想要的就近导出一次，比到处粘贴安全。
 */
import { readFileSync, existsSync } from "node:fs";

const API = (process.env.DSH_WEBIN_API ?? "http://127.0.0.1:3080").replace(/\/+$/, "") + "/dsh-webin/api";

const C = {
  reset: "\x1b[0m", dim: "\x1b[2m", red: "\x1b[31m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};
const ok = (s) => `${C.green}${s}${C.reset}`;
const bad = (s) => `${C.red}${s}${C.reset}`;
const dim = (s) => `${C.dim}${s}${C.reset}`;

async function api(path, init) {
  let r;
  try {
    r = await fetch(`${API}${path}`, init);
  } catch (e) {
    console.log(bad(`\n连不上插件接口（${API}）。\n`) + `  DSH 在跑吗？插件加载了吗？\n  原始错误：${String(e?.message ?? e)}\n`);
    process.exit(1);
  }
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text; }
  return { status: r.status, body };
}
const get = (p) => api(p);
const post = (p, o) => api(p, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const put = (p, o) => api(p, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });
const del = (p, o) => api(p, { method: "DELETE", headers: { "content-type": "application/json" }, body: JSON.stringify(o) });

/** 拉当前 `accounts` 配置（槽位表）与登录态。 */
async function loadAccounts() {
  const r = await get("/accounts");
  if (r.status !== 200 || r.body?.ok !== true) {
    console.log(bad(`读账号配置失败（HTTP ${r.status}）：${JSON.stringify(r.body)}`));
    process.exit(1);
  }
  return r.body.platforms;
}

function findPlatform(platforms, id) {
  const p = platforms.find((x) => x.platform === id);
  if (p === undefined) {
    console.log(bad(`\n没有这个平台：${id}\n`) + `  现有平台：${platforms.map((x) => x.platform).join(", ")}\n`);
    process.exit(1);
  }
  return p;
}

// ── 子命令 ──────────────────────────────────────────────────

async function cmdList() {
  const platforms = await loadAccounts();
  const creds = (await get("/credentials")).body?.accounts ?? [];

  console.log(`\n${C.cyan}平台 / 槽位${C.reset}   ${dim(`接口 ${API}`)}\n`);
  let any = false;
  for (const p of platforms) {
    const active = p.active ?? "default";
    console.log(`  ${C.cyan}${p.platform}${C.reset} ${dim(`(${p.name ?? ""})`)}  当前生效：${active}`);
    for (const s of p.slotStatus ?? []) {
      any = true;
      const mark = s.loggedIn ? ok("已登录") : bad("未登录");
      const via = s.via ? dim(`via ${s.via}${s.cookie ? ` (${s.cookie})` : ""}`) : "";
      const cred = creds.find((c) => c.platform === p.platform && c.slot === s.slot);
      const credText = cred === undefined
        ? dim("凭据：无")
        : `凭据：token ${cred.tokenLen} / cookie ${cred.cookieLen}` +
          `${cred.lastVerify ? (cred.lastVerify.ok ? ok(" 上次验证通过") : bad(" 上次验证失败")) : ""}` +
          (cred.rotation && cred.rotation.level !== "unknown" ? dim(`  ${cred.rotation.text}`) : "");
      const star = s.slot === active ? C.yellow + " *" + C.reset : "  ";
      console.log(`   ${star} ${String(s.slot).padEnd(14)} ${mark.padEnd(20)} ${via}`);
      console.log(`        ${dim(credText)}`);
    }
    console.log("");
  }
  if (!any) console.log("  （一个槽位都没有）\n");
  console.log(`  ${C.yellow}*${C.reset} = 当前生效槽位\n`);
}

async function cmdAdd(platform, slot) {
  if (!platform || !slot) { console.log(bad("用法：add <平台> <槽位>")); process.exit(1); }
  const platforms = await loadAccounts();
  const p = findPlatform(platforms, platform);
  const slots = [...(p.slots ?? ["default"])];
  if (slots.includes(slot)) { console.log(dim(`\n槽位「${slot}」已存在，无需新增。\n`)); return; }
  slots.push(slot);
  const r = await put("/accounts", { platform, slots, active: p.active ?? "default" });
  if (r.status !== 200 || r.body?.ok !== true) {
    console.log(bad(`\n新增失败（HTTP ${r.status}）：${r.body?.message ?? JSON.stringify(r.body)}\n`));
    process.exit(1);
  }
  console.log(ok(`\n✓ 已新增槽位「${slot}」`) + `   ${platform} 现有：[${r.body.slots.join(", ")}]`);
  console.log(dim(`  下一步：给它一份凭据并登录 ——\n    node scripts/accounts.mjs import ${platform} ${slot} <两行凭据文件> --login\n`));
}

async function cmdSwitch(platform, slot) {
  if (!platform || !slot) { console.log(bad("用法：switch <平台> <槽位>")); process.exit(1); }
  const platforms = await loadAccounts();
  const p = findPlatform(platforms, platform);
  if (!(p.slots ?? []).includes(slot)) {
    console.log(bad(`\n槽位「${slot}」不存在。`) + ` 现有：[${(p.slots ?? []).join(", ")}]\n`);
    process.exit(1);
  }
  const r = await put("/accounts", { platform, slots: p.slots, active: slot });
  if (r.status !== 200 || r.body?.ok !== true) {
    console.log(bad(`\n切换失败：${r.body?.message ?? JSON.stringify(r.body)}\n`));
    process.exit(1);
  }
  console.log(ok(`\n✓ ${platform} 当前生效槽位 → ${slot}\n`));
  const st = (r.body.slots ?? []);
  console.log(dim(`  槽位：[${st.join(", ")}]\n`));
}

async function cmdRm(platform, slot) {
  if (!platform || !slot) { console.log(bad("用法：rm <平台> <槽位>")); process.exit(1); }
  if (slot === "default") { console.log(bad("\ndefault 槽位不可删除（它是兜底身份）。\n")); process.exit(1); }
  // 先从槽位表移除，再删凭据（顺序反了会让槽位回落到 default 而误删它的凭据）
  const platforms = await loadAccounts();
  const p = findPlatform(platforms, platform);
  const slots = (p.slots ?? []).filter((s) => s !== slot);
  if (!slots.includes("default")) slots.unshift("default");
  const active = (p.active ?? "default") === slot ? "default" : p.active;
  const r1 = await put("/accounts", { platform, slots, active });
  if (r1.status !== 200 || r1.body?.ok !== true) {
    console.log(bad(`\n删槽位失败：${r1.body?.message ?? JSON.stringify(r1.body)}\n`));
    process.exit(1);
  }
  const r2 = await del("/credentials", { platform, slot });
  console.log(ok(`\n✓ 已删除槽位「${slot}」`) + `  ${platform} 现有：[${r1.body.slots.join(", ")}]`);
  console.log(dim(`  凭据：${r2.body?.removed ? "已删除" : "本来就没有"}`));
  console.log(dim(`  浏览器 profile 目录保留着（下次登录可以直接复用，不用重新扫码）\n`));
}

async function cmdImport(platform, slot, file, doLogin) {
  if (!platform || !slot || !file) {
    console.log(bad("用法：import <平台> <槽位> <文件> [--login]"));
    console.log(dim("  文件格式：第 1 行 token、第 2 行 cookie（兼容那个 py 导出的 tokens/<名字>.txt）\n"));
    process.exit(1);
  }
  if (!existsSync(file)) { console.log(bad(`\n找不到文件：${file}\n`)); process.exit(1); }
  const lines = readFileSync(file, "utf8").split(/\r?\n/);
  const token = (lines[0] ?? "").trim();
  const cookie = (lines[1] ?? "").trim();
  if (token === "" && cookie === "") { console.log(bad("\n文件里没有内容（第 1 行应是 token、第 2 行是 cookie）\n")); process.exit(1); }

  const r = await put("/credentials", { platform, slot, token, cookie });
  if (r.status !== 200 || r.body?.ok !== true) {
    console.log(bad(`\n写入凭据失败（HTTP ${r.status}）：${r.body?.message ?? JSON.stringify(r.body)}\n`));
    process.exit(1);
  }
  console.log(ok(`\n✓ 凭据已写入 ${platform}#${slot}`) + `  token ${r.body.account.tokenLen} / cookie ${r.body.account.cookieLen} 字符`);
  console.log(dim(`  ${r.body.account.rotation?.text ?? ""}`));

  /** 槽位不在表里就自动补上 —— 用户 import 一个新账号时显然是想用它。 */
  const platforms = await loadAccounts();
  const p = findPlatform(platforms, platform);
  if (!(p.slots ?? []).includes(slot)) {
    const slots = [...(p.slots ?? ["default"]), slot];
    await put("/accounts", { platform, slots, active: p.active ?? "default" });
    console.log(ok(`✓ 已自动新增槽位「${slot}」`));
  }
  if (doLogin) await cmdLogin(platform, slot);
  else console.log(dim(`\n  想立刻用它登录，跑：node scripts/accounts.mjs login ${platform} ${slot}\n`));
}

async function cmdLogin(platform, slot) {
  if (!platform || !slot) { console.log(bad("用法：login <平台> <槽位>")); process.exit(1); }
  console.log(dim(`\n正在注入凭据并验证（会起一个独立 profile 的浏览器，约 10~20 秒）…`));
  const r = await post("/credentials/inject", { platform, slot });
  const b = r.body ?? {};
  if (b.ok === true) {
    console.log(ok(`\n✓ 登录成功`) + `  ${platform}#${slot}`);
    console.log(`  cookie 写入 ${b.cookieSet} 条${b.cookieFailed?.length ? bad(`（失败 ${b.cookieFailed.join("/")}）`) : ""}，localStorage 写入 ${b.localStorageSet?.length ?? 0} 项`);
    console.log(dim(`  当前页面：${b.url}\n`));
    return;
  }
  console.log(bad(`\n✗ 登录未通过（HTTP ${r.status}）`));
  console.log(`  ${b.detail ?? b.message ?? JSON.stringify(b)}`);
  if (r.status === 422) {
    console.log(dim(`\n  这通常意味着凭据已过期 —— 去重新导出一次，再 import。`));
    console.log(dim(`  也可以打开浏览器扫码登录（不经凭据文件）。\n`));
  } else {
    console.log("");
  }
  process.exitCode = 1;
}

function usage() {
  console.log(`
${C.cyan}账号管理${C.reset}   ${dim(`接口 ${API}`)}

  node scripts/accounts.mjs ${C.yellow}list${C.reset}
      列出平台 / 槽位 / 登录态 / 凭据状况

  node scripts/accounts.mjs ${C.yellow}add${C.reset} <平台> <槽位>
      新增账号槽位（中文也可以）

  node scripts/accounts.mjs ${C.yellow}switch${C.reset} <平台> <槽位>
      切换该平台当前生效的槽位

  node scripts/accounts.mjs ${C.yellow}rm${C.reset} <平台> <槽位>
      删除槽位（连凭据一起；profile 目录保留）

  node scripts/accounts.mjs ${C.yellow}import${C.reset} <平台> <槽位> <文件> [--login]
      从两行文本导入凭据（第 1 行 token、第 2 行 cookie）
      兼容那个 py 导出的 tokens/<名字>.txt

  node scripts/accounts.mjs ${C.yellow}login${C.reset} <平台> <槽位>
      用已存凭据注入登录并验证（不必扫码）

${dim('例：')}
  node scripts/accounts.mjs list
  node scripts/accounts.mjs import deepseek 工作号 "C:\\Users\\Evelyn\\Desktop\\肖浩成\\小程序\\Toekn管理\\tokens\\default.txt" --login
`);
}

// ── 入口 ────────────────────────────────────────────────────
const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith("--")));
const args = argv.filter((a) => !a.startsWith("--"));
const [cmd, a1, a2, a3] = args;

switch (cmd) {
  case "list": case undefined: await cmdList(); break;
  case "add": await cmdAdd(a1, a2); break;
  case "switch": await cmdSwitch(a1, a2); break;
  case "rm": await cmdRm(a1, a2); break;
  case "import": await cmdImport(a1, a2, a3, flags.has("--login")); break;
  case "login": await cmdLogin(a1, a2); break;
  case "help": case "-h": case "--help": usage(); break;
  default:
    console.log(bad(`\n不认识这个命令：${cmd}`));
    usage();
    process.exit(1);
}
