/**
 * py 第三批改动：
 *   1) 全推 <平台>        —— 把 tokens/ 里的**全部**账号批量推给插件（"把我现存的几个账号弄进去"）
 *   2) + <名字> [平台]     —— 添加账号时**选平台**；非 deepseek 先在插件里建槽位
 *   3) 检 [平台]          —— 逐个账号注入登录验证 token/cookie 还有没有效
 *   4) plugin_add_slot()  —— 给插件加一个槽位（平台无关）
 */
import { readFileSync, writeFileSync, copyFileSync } from "node:fs";

const P = "C:/Users/Evelyn/Desktop/肖浩成/小程序/Toekn管理/chat.deepseek.com令牌.py";
const stamp = new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14);
copyFileSync(P, P + ".bak3-" + stamp);
console.log("已备份: .bak3-" + stamp);

const hadCRLF = readFileSync(P, "utf8").includes("\r\n");
let src = readFileSync(P, "utf8").replace(/\r\n/g, "\n");
if (src.includes("plugin_push_all")) { console.log("已改过"); process.exit(0); }

const rep = (a, b, tag) => {
  if (!src.includes(a)) { console.log("❌ 锚点未找到: " + tag); process.exit(1); }
  src = src.replace(a, b);
  console.log("  ✓ " + tag);
};

// ── 1) 三个新函数 ───────────────────────────────────────────
rep(
`def plugin_switch(platform, slot):`,
`def plugin_add_slot(platform, slot):
    """给插件加一个账号槽位（平台无关）。已存在则什么都不做。"""
    try:
        acc = plugin_api("/accounts")
    except Exception as e:
        print("  连不上插件接口: %s" % e)
        return False
    for p in acc.get("platforms", []):
        if p.get("platform") == platform:
            slots = list(p.get("slots", []))
            if slot in slots:
                print("  插件里已经有 %s#%s 了" % (platform, slot))
                return True
            slots.append(slot)
            try:
                plugin_api("/accounts", "PUT",
                           {"platform": platform, "slots": slots, "active": p.get("active", "default")})
            except Exception as e:
                print("  加槽位失败: %s" % e)
                return False
            print("  ✓ 已在插件里建好账号 %s#%s" % (platform, slot))
            return True
    print("  插件里没有平台 [%s]" % platform)
    return False


def plugin_push_all(platform, verify=False):
    """把 tokens/ 里的**全部**账号批量推给插件的某个平台。

    用户要求：「把我现存的几个账号弄进去」—— 一个一个敲 `推` 太笨。
    """
    names = []
    if os.path.isdir(OUT_DIR):
        names = sorted(f[:-4] for f in os.listdir(OUT_DIR) if f.endswith(".txt"))
    if not names:
        print("  还没导出过任何账号（先按回车提取，或用 + <名字> 添加）")
        return
    print("  将推给 [%s] 的账号: %s" % (platform, ", ".join(names)))
    ok = 0
    for n in names:
        print("")
        print("[" + n + "]")
        if plugin_push(platform, n, os.path.join(OUT_DIR, n + ".txt")):
            ok += 1
    print("")
    print("  —— %d/%d 个账号已进插件" % (ok, len(names)))


def plugin_verify_all(platform=None):
    """逐个账号注入登录并验证 —— 回答「我的 token/cookie 还有效吗」。

    用户要求：「每次点进去给个选项检测所有账号的 Token 和 Cookie」。
    判据是**页面探针**（不是看本地文件），所以结论就是真实可用性。
    代价：每个账号要起一次浏览器，10~20 秒。
    """
    try:
        acc = plugin_api("/accounts")
        cred = plugin_api("/credentials")
    except Exception as e:
        print("  连不上插件接口（%s）: %s" % (PLUGIN_API, e))
        return
    have = {}
    for c in cred.get("accounts", []):
        have.setdefault(c.get("platform"), []).append(c.get("slot"))
    todo = []
    for p in acc.get("platforms", []):
        plat = p.get("platform")
        if platform and plat != platform:
            continue
        for slot in have.get(plat, []):
            todo.append((plat, slot))
    if not todo:
        print("  插件里没有可检测的账号（凭据文件是空的）")
        return
    print("  要检测 %d 个账号，每个约 10~20 秒…" % len(todo))
    ok = 0
    for i, (plat, slot) in enumerate(todo, 1):
        print("")
        print("  [%d/%d] %s#%s 检测中…" % (i, len(todo), plat, slot))
        try:
            r = plugin_api("/credentials/inject", "POST", {"platform": plat, "slot": slot}, timeout=180)
        except Exception as e:
            print("      ✗ 请求失败: %s" % e)
            continue
        if r.get("loggedIn") is True:
            ok += 1
            print("      ✅ 有效（cookie 写入 %s 条）" % r.get("cookieSet", 0))
        else:
            print("      ❌ 已失效或登不上: %s" % (r.get("detail") or r.get("message") or ""))
    print("")
    print("  —— %d 个账号里 %d 个有效" % (len(todo), ok))
    if ok < len(todo):
        print("  失效的这样修：先 `+ <名字> <平台>` 重新导出，再 `推 <平台> <账号> <文件>`")


def plugin_switch(platform, slot):`,
"三个新函数");

// ── 2) + 支持平台 ───────────────────────────────────────────
rep(
`        if cmd == "+" or cmd == "add":
            if len(parts) < 2:
                print("  用法: + <新账号名>")
                continue
            extract([parts[1]])
            continue`,
`        if cmd == "+" or cmd == "add":
            if len(parts) < 2:
                print("  用法: + <新账号名> [平台]")
                print("        平台: deepseek（默认，本脚本抓 token）/ yuanbao / doubao")
                continue
            _name = parts[1]
            _plat = parts[2] if len(parts) > 2 else "deepseek"
            if _plat == "deepseek":
                extract([_name])
                continue
            # 非 deepseek：本脚本抓不到它（登录态在**插件的** Edge profile 里），
            # 所以先在插件里把账号建好，再让用户去插件那边登录一次。
            if plugin_add_slot(_plat, _name):
                print("")
                print("  下一步（元宝/豆包只能这样加）：")
                print("    1. 打开 DSH 设置页 → LDW → 账号，找到 %s#%s" % (_plat, _name))
                print("    2. 点「登录」用扫码/粘贴凭据把它登进去（一次即可，之后长期有效）")
                print("    3. 回到这里敲 `p` 就能看到它，用 `切 %s %s` 切换" % (_plat, _name))
            continue`,
"+ 支持平台");

// ── 3) 全推 / 检 命令 ───────────────────────────────────────
rep(
`        if cmd in ("推", "push"):`,
`        if cmd in ("全推", "pushall"):
            if len(parts) < 2:
                print("  用法: 全推 <平台>")
                print("        把 tokens/ 里**所有**账号一次推给该平台（省得一个个敲）")
                continue
            plugin_push_all(parts[1])
            continue
        if cmd in ("检", "verify"):
            plugin_verify_all(parts[1] if len(parts) > 1 else None)
            continue
        if cmd in ("推", "push"):`,
"全推 / 检 命令");

// ── 4) 帮助 ─────────────────────────────────────────────────
rep(
`    print("  推 <平台> <账号> <文件>   把两行凭据推给插件并注入登录（平台无关）")`,
`    print("  推 <平台> <账号> <文件>   把两行凭据推给插件并注入登录（平台无关）")
    print("  全推 <平台>       把 tokens 里所有账号一次推给该平台")
    print("  检 [平台]         检测插件里所有账号的 token/cookie 还有没有效")
    print("  + <名字> [平台]   添加账号（平台默认 deepseek）")`,
"帮助文本");

writeFileSync(P, hadCRLF ? src.replace(/\n/g, "\r\n") : src, "utf8");
console.log("全部改完");
