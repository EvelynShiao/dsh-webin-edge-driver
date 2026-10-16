import { readFileSync, writeFileSync } from "node:fs";
const P = "C:/Users/Evelyn/Desktop/肖浩成/小程序/Toekn管理/多平台令牌.py";
let src = readFileSync(P, "utf8");
const done = [];
const rep = (a, b, tag) => {
  if (!src.includes(a)) { console.log("❌ 锚点未找到: " + tag); process.exit(1); }
  src = src.replace(a, b); done.push(tag);
};

// ── ① 探测已有登录的目录（含插件的 edge-ldw —— 只复用登录目录，不调插件任何接口）──
rep(
`def profile_dir(platform, name):
    """账号的 Edge 配置目录。

    ⚠️ deepseek 优先复用**老脚本的**目录（~/.dsh/deepseek-profiles/<名字>）：
    那里已经有登录态，直接拿来用就行 —— 既不用重新登录，也不用复制
    几百 MB 的 Edge profile（一个 profile 动辄 100~300MB）。
    其它平台放在本脚本自己的 profiles/<平台>/<账号> 下。
    """
    if platform == "deepseek":
        legacy = os.path.join(os.path.expanduser("~"), ".dsh", "deepseek-profiles", name)
        if os.path.isdir(legacy):
            return legacy
    return os.path.join(PROFILES_ROOT, platform, name)`,
`# 本机已有的 Edge 配置根目录（**只用来复用登录目录**，不调用插件的任何接口）。
# DSH 插件把它那些平台的登录态放在这里；复用一份能省一次扫码登录，
# 也不复制几百 MB 的 profile。
EDGE_LDW_BASE = os.path.join(os.path.expanduser("~"), ".dsh", "edge-ldw")


def existing_profile_dirs(platform):
    """本机已有登录的 (账号名 → 目录)。default 槽位就是平台那一层。"""
    found = {}
    base = os.path.join(EDGE_LDW_BASE, platform)
    if os.path.isdir(os.path.join(base, "Default")):
        found["default"] = base
    if os.path.isdir(base):
        for sub in sorted(os.listdir(base)):
            if sub == "Default":
                continue
            d = os.path.join(base, sub)
            if os.path.isdir(os.path.join(d, "Default")):
                found[sub] = d
    return found


def profile_dir(platform, name):
    """账号的 Edge 配置目录。**优先复用已有的登录，省一次扫码。**

    查找顺序：
      1. deepseek → ~/.dsh/deepseek-profiles/<名字>（老脚本的，登录态在里面）
      2. 本机 edge-ldw 里已有登录的（~/.dsh/edge-ldw/<平台>[/<账号>]）
      3. 都没有 → 本脚本自己的 profiles/<平台>/<账号>（会让你登录一次）
    """
    if platform == "deepseek":
        legacy = os.path.join(os.path.expanduser("~"), ".dsh", "deepseek-profiles", name)
        if os.path.isdir(legacy):
            return legacy
    hit = existing_profile_dirs(platform).get(name)
    if hit:
        return hit
    return os.path.join(PROFILES_ROOT, platform, name)`,
"① profile_dir 复用已有登录 + EDGE_LDW_BASE");

// ── ② 账号清单：把「已有登录但还没导出」的也列出来 ──────────
rep(
`def list_accounts():
    """扫描 tokens/ 得到 [(平台, 账号)]。"""
    out = []
    if os.path.isdir(OUT_DIR):
        for f in sorted(os.listdir(OUT_DIR)):
            if not f.endswith(".txt"):
                continue
            stem = f[:-4]
            if SEP in stem:
                plat, name = stem.split(SEP, 1)
                if plat in PLATFORMS:
                    out.append((plat, name))
    return out`,
`def list_accounts():
    """列出所有账号 [(平台, 账号)]。

    来源有两处：
      ① tokens/ 里有导出文件的（提取过）
      ② 本机已有登录配置的（还没提取 —— 尤其**元宝/豆包**，
         它们的登录态本来就在，列出来才知道有这个账号，敲一下就能提取）
    """
    seen = set()
    out = []
    if os.path.isdir(OUT_DIR):
        for f in sorted(os.listdir(OUT_DIR)):
            if not f.endswith(".txt"):
                continue
            stem = f[:-4]
            if SEP in stem:
                plat, name = stem.split(SEP, 1)
                if plat in PLATFORMS and (plat, name) not in seen:
                    seen.add((plat, name))
                    out.append((plat, name))
    for plat in PLATFORMS:
        for name in existing_profile_dirs(plat):
            if (plat, name) not in seen:
                seen.add((plat, name))
                out.append((plat, name))
    return sorted(out)`,
"② list_accounts 也列已有登录的账号");

// ── ③ 打印 token 与 cookie 全文 ─────────────────────────────
rep(
`    print("  ✓ " + path)
    print("  token  " + (str(len(token)) + " 字符" if token else "(该平台没有 token，靠 cookie)"))
    print("  cookie " + str(len(cookie)) + " 字符")`,
`    print("  ✓ " + path)
    # 用户要求：token 与 cookie **都打在屏幕上**（方便直接复制），
    # 所以这里把全文打印出来，长度只是附注。
    if token:
        print("  token  (%d 字符)" % len(token))
        print("    " + token)
    else:
        print("  token  (该平台没有 localStorage token，认证全靠 cookie)")
    print("  cookie (%d 字符)" % len(cookie))
    print("    " + cookie)`,
"③ 打印 token/cookie 全文");

// 导出时若目录不存在也要能创建（复用已有目录时 makedirs 会 no-op）
writeFileSync(P, src, "utf8");
console.log("改完 " + done.length + " 处：" + done.join(" / "));
