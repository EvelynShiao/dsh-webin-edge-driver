# Changelog

## 2026-10-16 · 改成完整插件包（弃补丁路线）+ 会话惰性回收

### 重大结构变更：`patch/` → `lib/`，本仓库变成**可直接安装的插件**

**触发原因**：用户手机装本插件被拒，报「缺少 package.json 中的 dsh.bundle.patch」。

**根因**：本仓库原本是**打补丁脚本仓库**（`install.ps1` + `patch/`），
给已经装了 dsh-webin 的机器用；它**没有 `package.json`**。
而 DSH 判定「这是不是插件」看的是 `package.json` 的 `dsh.bundle.patch`
（指向 `cordis.patch.yml`）。手机上跑不了 PowerShell，只能走插件安装，
于是必然被拒。

**改法**（用户指示「不要补丁，我们就用完整结构」）：

- 新增 `lib/`（7 个文件的**完整实现**，单一真相源，内容与真机已装版本**逐一哈希一致**）
- 新增 `package.json`：`main` / `exports` / `files` / **`dsh.bundle.patch`** / `dsh.client`
- 新增 `cordis.patch.yml`：`- insert: [{id: dsh-webin-edge-driver, name: ...}]`
- 删除 `patch/`（含 `extract-scripts.mjs` —— 完整结构下不再需要从上游抠脚本）
- `install.ps1` 重写：从「打补丁」变成「用 lib/ 覆盖已装插件」（并整目录备份）
- `INSTALL.md` 重写：三种安装方式 + 7 个必需文件清单 + 「别和上游同时启用」

**验证**（不是推测）：

- `package.json` JSON 合法，`dsh.bundle.patch` → 文件真实存在
- `cordis.patch.yml` 用真 YAML 解析器解析通过，形状 `- insert: [{id,name}]` 正确
- **包入口冒烟测试**：`import lib/index.js` 成功，导出 `apply, inject, name`
  （即所有本地 import 都解析到了 —— 这是「装上不会崩」的关键证据）
- 7 个文件与已装版本逐一 SHA256 一致

⚠️ 本包与上游 `dsh-webin` **不能同时启用**：都会注册同一批 LDW 路由。

### 新增：会话惰性回收（`lib/session-gc.js`）

用户原话：「会话用完了马上删不好，容易被看出来是机器人，建议做个自定义的
多少分钟后删除 / 多少机器人产生会话后删除。」这个直觉是对的 —— 来一条消息就
精准地多一条对话、旋即消失，是很好认的机器特征。

| `sessionDeleteMode` | 行为 |
|---|---|
| `never` | 不删（最保守） |
| `immediate` | 老行为，本轮结束立刻删（最像机器人） |
| `delay` | 记进账本，`sessionDeleteDelayMinutes` 分钟后才删（默认 30） |
| `count` | 记进账本，攒到 `sessionDeleteMaxSessions` 个后删最老的（默认 20） |

留空 ⇒ 回落到旧的布尔 `autoDeleteSessions`，**老配置行为完全不变**。

**三个设计要点**

1. **只碰机器人自己建的会话**：用一份持久化账本记下「哪些是这轮新建的」，
   之后所有删除都只在这个范围内。绝不做「删最近 N 条」（那会误删用户历史）。
2. **惰性 GC，不新开定时器**：删除必须借浏览器（会话列表/删除都是页面里
   fetch），用户又对常驻进程敏感 ⇒ **搭车**：复用每次任务结束时页面已开、
   且刚验证过登录的时刻顺手清算。代价是「没新任务就到期的会一直等」，
   这是刻意的偏向 —— 少删几条对话比多养一个常驻进程好，而且「不急着删」本身更像真人。
3. **账本持久化**（`~/.dsh/webin/pending-session-deletes.json`，原子写）：
   否则重启后「N 分钟后删」就变成永远不删。按 `平台#槽位` 隔离，避免串号。
   删除失败的条目**留在账本里**下次重试，不因一次网络抖动永久漏一条。

**测试抓到的真 bug**：`never` 模式下 `collectNewSessions` 仍会记账。
生产路径虽被 `canManageSessions` 挡住，但方法**被单独调用**时就会自相矛盾
（`never` 却往待删账本写东西）。已在方法内部加模式守卫 —— 安全的东西要在
**最靠近数据的地方**再确认一次。集成测试（假 provider + 假接口）全绿。

### 配置

`~/.dsh/webin/config.json` 的 `edgeDriver` 块新增
`sessionDeleteMode: "delay"` / `sessionDeleteDelayMinutes: 30` /
`sessionDeleteMaxSessions: 20`；`sessionDeleteMode` 有**白名单校验**
（拼错会报 problem 而不是静默回落到 never）。

## 2026-10-16 · 粘贴 Token/Cookie 直接登录（`/credentials/inject`）

**用户点名要的能力**：不必开浏览器扫码，把 Token/Cookie 灌进去就登 ——
这样手机和电脑才能靠同一份凭据文件互相登录。

### 关键实验（先证实再实现）

干净临时 profile + 一份 token/cookie：

| 阶段 | 页面 |
|---|---|
| 注入前 | URL 停在 `/sign_in`，「+86 发送验证码 / 微信扫码」 |
| 注入后 | URL 变 `chat.deepseek.com`，正文出现昵称与「开启新对话」 |

⇒ **全新 profile + 凭据 = 直接登进去，无需扫码**。方案可行。

### 实现

- `EdgeDriver.injectCredentials(provider, {token, cookie, accountId})`：
  ① 先导航到目标域（`Network.setCookie` 与 `localStorage` 都依附 origin，
  停在 about:blank 写了等于没写）→ ② `Network.setCookie` 逐条灌 cookie
  → ③ 页面 JS 写 `localStorage`（值用**原始 appKit 信封**）
  → ④ reload → ⑤ **用现成的登录探针验证**（这就是「token 还能用吗」的答案）。
- `POST /dsh-webin/api/credentials/inject`，body `{platform, slot}`（从凭据文件读）
  或直接带 `token`/`cookie`（便于「先试着登，成了再存」）。
  验证结果**回填** `lastVerify` 到凭据文件。driver 忙时返回 409（串行设计，不抢浏览器）。
- provider 可声明 `credentialInjection: { localStorageKeys, cookieUrl }`；DeepSeek 已声明。

### 为什么走 CDP 注入而不是写 cookie 库

Edge 磁盘上的 cookie 是**加密的**（DPAPI + AES-GCM，密钥绑当前用户），自己拼加密值
极脆；而 `Network.setCookie` 是**浏览器自己**写进去的，加密/索引/域校验全由它处理。

### 为什么两半都必需

DeepSeek 登录态 = cookie（`smidV2` / `.thumbcache_*` / `HWWAFSESID` / `HWWAFSESTIME`
/ `ds_session_id`）+ **localStorage `userToken`**。光有 cookie 不够（真正的 httpOnly
凭据从 `document.cookie` 抄不出来）、光有 token 也不够 —— 实测**两者一起**才能登。

### 实测（真调用生产代码，非复刻逻辑）

用临时 profile + 独立端口调用 `EdgeDriver.injectCredentials()`：

```
ok: true, loggedIn: true, url: https://chat.deepseek.com/
cookieSet: 5/5   localStorageSet: ["userToken"]
detail: 注入成功，页面登录探针已确认
耗时: 13.7s
```

## 2026-10-16 · 统一 Token/Cookie 凭据文件 + 自定义平台修复

### 新增：`lib/credential-store.js` + `/credentials` 接口

用户要「一个文件，手机和电脑都能用」地管各平台 Token/Cookie，并且**能看出会不会过期**。

- 文件：`~/.dsh/webin/credentials.json`（**原子写**：先写 `.tmp` 再 rename，
  防止手机端同步到半截文件）；环境变量 `DSH_WEBIN_CREDENTIALS` 可指到同步目录。
- 接口：`GET/PUT/DELETE /dsh-webin/api/credentials`。
  **GET 一律脱敏**（只回长度/指纹/轮换频率，绝不回明文）；日志也只记长度。
- **过期判断的诚实结论**：DeepSeek 的 `userToken` 实测是 56 字符**不透明随机串**
  （`{"value":"...","__version":"0"}`）、**不是 JWT**，解不出 `exp`。
  所以只有两条真判据：① 注入后用页面登录探针验证 ② **记录轮换频率**
  （`changedCount` + `describeRotation()`，回答「这站多久轮一次」）。
- 已把桌面 `chat.deepseek.com令牌.py` 的 `tokens/*.txt` **迁移进来**（含它积累的
  轮换历史，那是最值钱的部分）。

### 修复：自定义平台原来**根本用不了**

用户问「那个自定义平台能用吧」——实测三道 brick：

1. `isLoggedInByCookies` 对未知 id 返回 `no-rule` ⇒ 门禁永远 false
   ⇒ `listModels` 不列模型、`streamOnce` 直接报未登录。
   **修**：门禁在 `no-rule`（= 自定义平台，我们没有判据）时 **fail-open 放行**；
   `no-login-cookie` 与 `profile-unreadable` 仍保持 false，内置四站不受影响。
2. `probe()` 对无 `authProbe` 的 provider 返回 `{unsupported:true}`
   ⇒ `runJob` 抛 `WEBIN_NOT_LOGGED_IN` 并把窗口叫前台。
   **修**：退化为「`input.selectors` 任一可见即算登录」（失败方向安全，
   真没登录时后续步骤会报更具体的原因）。
3. `provider.example.json` 缺 `replyCapture` / `authProbe` / `loginProbe`
   ⇒ 照示例配出来的平台会被「没配回复选择器」守卫拒发。**示例已补齐**。

### 修复：cookie 判据偶发失效

Chromium cookie 库是 **WAL 模式**，Edge 开着时「只读打开」会**时好时坏**
（实测同一千问 profile：手工试能读 27 条，插件跑报 `unable to open database file`）。
加回退：复制 `Cookies`+`-wal`+`-shm` 到 `~/.dsh/webin/cache/cookies/<hash>/` 再读副本。
连跑 3 轮全通。⚠️ `db` 必须 `close()`，否则 Windows 删临时目录报 `EPERM`（踩过）。

### 修复：`/accounts` 槽位登录态

原只看快照 ⇒ 设置页显示未登录。改用与 `isPlatformLoggedIn` 一致的双判据
（快照 **或** cookie），并回传 `via` / `cookie` 便于排查。

### 安装脚本

`install.ps1` 的文件清单补上 `login-cookie-probe.js` / `credential-store.js`
（index.js 会 import，漏装=加载即崩）；`provider.example.json` 单独放到插件根目录。

## 2026-10-16 · 修「明明登录了却说未登录」死锁（多账号 profile 撞车 + cookie 判据）

**用户报的现象**：元宝（以及千问 / 豆包）在 Edge 里明明是登录状态，插件一直说没登录，消息发不出去。

**根因（A/B 实测定位）**：`userDataDirFor()` 在加多账号时**无条件**多拼一层账号目录，
而 Windows 路径**大小写不敏感** —— `edge-ldw/yuanbao/default` 与 Edge 自己创建的
`edge-ldw/yuanbao/Default` **是同一个目录**。于是 Edge 把 profile 目录本身当成了
user-data-dir，再往里建一层 `Default/`，得到一个**全新空白身份**：

| user-data-dir | 实测探测结果 |
|---|---|
| `<base>/yuanbao`（旧路径） | `loggedIn: true` ✅ hy_token 663B 密文在位 |
| `<base>/yuanbao/default`（新路径） | `loggedIn: false` ❌ 0 条 tencent cookie |

**为什么是死锁**：页面未登录 ⇒ host 门禁 `isPlatformLoggedIn` 判 false ⇒ 任务**根本不入队**
⇒ driver 领不到活 ⇒ 快照写不出来（快照只在任务跑通后写）⇒ 门禁继续 false。
「把窗口叫出来让用户登录」的 `surfaceForLogin()` 虽然在 runJob 里调了，
但**永远执行不到**——门禁在前面就把路堵死了。

**修复**

1. `edge-driver.js · userDataDirFor()`：**default 槽位不拼账号层**（沿用旧布局，
   兼容所有既有登录态）；只有真正的多账号（`work` 之类）才多拼一层。
2. **新增 `lib/login-cookie-probe.js`**：直接读 Edge profile 的 cookie 库
   （`<profile>/Default/Network/Cookies`，SQLite）判登录态。
   - 零依赖（`node:sqlite` 内置）、**不起浏览器、不联网、不解密**（只看 cookie 名 + 密文长度）
   - 跨重启存活，且不碰任何指纹
   - 各平台特征 cookie：元宝 `hy_token` / 千问 `tongyi_sso_ticket` /
     豆包 `sid_guard`+`sessionid` / DeepSeek `ds_session_id`
3. `index.js · isPlatformLoggedIn()`：把 cookie 判据接成**第二条判据**
   （快照没有时回退到 cookie）—— 这是破死锁的关键。
4. 清理误建的 4 个空 profile 目录（约 87 MB，已移到隔离目录未删）。

**顺带修掉的两个「改版失效」**（实测发现，否则登录修好也发不出去）

- 元宝 / 豆包的 `replyCapture.replySelectors` 原本是**空数组** ⇒ `runJob` 守卫直接拒发。
  实测补上：元宝 `div.hyc-common-markdown`、豆包 `[class*="md-box"]`。
- 豆包**输入框改版**：`textarea[data-testid="chat_input_input"]` 在现网**已不存在**
  （`querySelector` 返回 null）。改为 `div.tiptap.ProseMirror[contenteditable="true"]`。
  同时修正豆包的 `authProbe.loggedInSelectors`（它引用的也是那个消失的 textarea，
  导致登录着也被判未登录）。

**实测证据**

- A/B 探测：同一台机同一账号，旧路径 `loggedIn:true` / 新路径 `loggedIn:false`
- cookie 探针：四个平台全部 `loggedIn=true`；对照组（多账号那层）全部 `false`（判据有区分度）
- 门禁端到端：deepseek（快照+cookie 双命中）、qwen/yuanbao/doubao（cookie 命中）
- 元宝两轮对话实测：`div.hyc-common-markdown` 节点数 1→3，随回复递增，且不含用户提问
- 豆包实测：`[class*="md-box"]` 取 `at(-1)` 正是助手回复文本

## 1.0.0

首个版本。CDP 驱动本机真 Edge，替代缺失的 DSH Electron webview 载体。

**功能**

- 真浏览器载体：CDP 驱动本机 Edge，逐字复用 dsh-webin 原生 DOM 脚本
- 隐藏窗口：移到屏幕外（非 headless，指纹零变化）+ 关掉后台节流
- 登录态持久化：一平台一 profile 目录，跨重启存活
- 按需启动 / 空闲自动关（默认 120 秒）
- 多平台串行支持（deepseek / qwen / 自定义）
- 自动清理网页版废对话（只删本轮新建的，绝不碰历史与置顶）
- 未登录时自动把窗口叫到前台，方便登录
- /status 暴露驱动器状态，便于排查

**实测**

- 端到端：起 Edge → 填字 → 等 2~4 秒 → 点击发送 → hook 抓到回复 → 交结果，约 5~26 秒
- 内存：干活时 596~617 MB，不干活时 0

## 2026-10-15 · 压缩 .txt 出口（compactionFileMode）

- \/compact\ 摘要不再被 webin 一律拒绝：新增 \compactionFileMode\ 配置（never/auto/always，默认 auto）。
- auto：序列化后 ≤ \compactionFileThresholdChars\（默认 10 万字符）直接发输入框；超过则全文落盘
  \~/.dsh/webin/compaction/compaction-<ts>.txt\，job 带 \ile\，走附件上传通道。
- edge-driver（web 档案主路径）：runJob 新增 4.5 步 —— CDP \DOM.setFileInputFiles\ 塞文件 + 轮询等解析完成（120s）再发短指令。
- webview 路径（client.js）：同语义的 \<webview>.debugger\ CDP 上传分支。
- 设置页新增「压缩 .txt 出口」分组：出口模式下拉 + 阈值输入，改完保存即生效。
- 配套（DSH 侧，另一个仓库）：compaction-basic 摘要目标改为 \liveSelection ?? agentTarget ?? latest\（右下角选中即生效，不用先发消息），maxTokens 4096→131072。
