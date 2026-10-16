# Changelog

## 2026-10-16 · 新增**独立**的多平台令牌管理器（与插件解耦）

用户连报三条，根因是我的方向错了：

1. 「这就是你说的全部提取？」—— 回车只提取了 DeepSeek 的账号。
2. 「不要和插件绑定，要分开管理」—— 我把「推/全推/检/对比」做成了插件耦合。
3. 「为什么还是不能添加除了 DeepSeek 以外的账号……给个标准的平台名字拼写和命令格式」
   「提取的 Token 呢？为什么只有一个蔡？」

### 为什么是**新脚本**而不是改老脚本

老脚本 \`chat.deepseek.com令牌.py\` 里 DeepSeek 是**写死**在多处的：
\`cookies_of()\` 按域名过滤 \`"deepseek"\`、\`wake()\` 写死跳 chat.deepseek.com、
\`TOKEN_KEYS\` 只认 DeepSeek 的键、而且 \`run()\` 在「取不到 token」时**直接放弃**
（元宝/豆包根本没有 localStorage token ⇒ 必挂）。在原地做外科手术风险高、
还可能弄坏他已经在用的工具。所以**另起一个平台无关的独立脚本**。

### 新脚本：\`多平台令牌.py\`（在同一个 Toekn管理 目录下）

平台名标准拼写（就三个，小写）：**deepseek / yuanbao / doubao**。

命令：\`[回车]\` 全部提取 · \`提取 [平台]\` · \`l\` 列表 · \`平台\` 打印拼写表 ·
\`+ <平台> <账号>\` 新增/登录 · \`<平台>#<账号>\` 单个提取 · \`m\` 改名 · \`d\` 删除。

目录全在脚本旁边、**不碰插件**：\`profiles/<平台>/<账号>\`、\`tokens/<平台>#<账号>.txt\`。

两个关键实现点：

- 取 cookie 用 CDP \`Network.getAllCookies\`（**含 httpOnly**）——
  不能用 \`document.cookie\`：元宝的 \`hy_token\`、豆包的 \`sid_guard\` 很可能就是
  httpOnly，漏了等于没取到登录态。
- 判据分平台：deepseek 靠 token+cookie；元宝/豆包**只有 cookie**（没有 localStorage token），
  所以「token 为空但 cookie 有」必须算成功 —— 老脚本正是在这里直接放弃的。

实测：自动从老脚本导入「蔡」的导出；\`deepseek#蔡\` 提取成功（**复用原有登录态，不用重新登**），
token 92 / cookie 318 字符，meta 记录指纹后可判断「有没有变」。

### 与老脚本的关系

老脚本里的插件命令（p/切/推/全推/检/对比）**保留但新脚本一概不用**。
deepseek 的 profile 优先复用老目录（\`~/.dsh/deepseek-profiles/<名字>\`）——
零复制、零重登；其它平台放在新脚本自己的 \`profiles/\` 下。

## 2026-10-16 · 修「点进去只看到 DeepSeek」+「加号只能打开 DeepSeek」

用户报的两条，都是**我上一轮没做全**：

### ① 点进去只列 DeepSeek 账号

py 启动时打的那张「账号状况」表是**本脚本自己的**账号（都来自 deepseek-profiles），
所以天生只有 DeepSeek。现在在 \`main()\` 开头补一次 \`plugin_list()\` ——
进去就能同时看到**插件里的全部平台账号**（实测：deepseek default / deepseek Evelyn /
yuanbao default / doubao default，带登录态与当前标记）。

### ② \`+ <名字> <平台>\` 只能打开 DeepSeek

根因：py 原有的 \`launch()\` 把 URL **写死**成 chat.deepseek.com、
profile 也写死成 deepseek-profiles ⇒ 元宝/豆包压根没法用它登录。
（我上一轮对非 deepseek 只是「建个槽位，让你自己去插件设置页登」—— 等于没做。）

新增 \`plugin_open_login()\`：

- profile 用**插件的**目录 \`edge-ldw/<平台>/<槽位>\`（与 slot-names.js /
  userDataDirFor 的规则严格一致，default 槽位不拼账号层）
  ⇒ **登录态直接落在插件要用的地方，登完就能用，不需要再「推」凭据**。
- 地址按平台映射：deepseek / yuanbao / doubao。
- 调试端口 \`port_for("plugin|<平台>#<槽位>")\`，与 py 自己的账号端口不冲突。

实测：\`+ 测试元宝 yuanbao\` → 建好槽位 → 弹出窗口指向
\`https://yuanbao.tencent.com/\`、profile 为 \`edge-ldw\yuanbao\测试元宝\`、
端口 17495（进程确实起来了）。

## 2026-10-16 · 修「推了却看不见」+ 对比指纹 + py 账号改名整理

### 真 bug：`推` 只写凭据、**没注册槽位** ⇒ 设置页看不见

用户的反馈：「你这啥东西，根本没导入，我看不见」。

根因：设置页的账号区是**按 /accounts 的槽位**渲染的，而 py 的 `plugin_push`
只 PUT 了 `/credentials` 就直接注入登录 —— **从没把槽位加进 /accounts**。
于是凭据明明在（`/credentials` 里能看到 `deepseek#奶奶`），
但 `/accounts` 的 slots 还是 `[default]`，UI 自然什么都不显示。
（`scripts/accounts.mjs` 的 import 会自动补槽位，所以那边没这个问题 ——
两份实现的行为不一致，正是这种 bug 的温床。）

修法：`plugin_push` 开头先调 `plugin_add_slot()`。
实测：`推 deepseek Evelyn <蔡.txt>` → ✓ 已在插件里建好账号 → ✓ 凭据已推 → ✓ 登录成功。

### 新增：一键「提取并对比是否变化」

用户要求：「给个一键提取Token并对比上传的结果是否变化的功能」。

- 插件侧：`GET /credentials` 的每项增加 `tokenSha` / `cookieSha`
  （sha256 前 16 位）。**只回指纹不回明文** —— 既回答了问题，又不用把秘密发出去。
- py 侧：新命令 `对比 <本脚本账号> [平台] [插件槽位]`
  ⇒ 重新提取 → 本地算指纹 → 与插件里那份比 → 打印「一致 ✓ / 已变化 ⚠」。

### py 账号整理（用户要求）

- **删除「奶奶」**：tokens/奶奶.txt、~/.dsh/deepseek-profiles/奶奶、meta 里的键，三处一起清。
- **default 改名为「蔡」**：tokens 文件、登录 profile 目录、meta 键一起改
  （登录态跟着目录走，**不用重新登录**）。

## 2026-10-16 · 「全部清理」按钮 + py 加「全推 / 检 / 选平台」

### 设置页：新增「全部清理」

用户要求：「删除旧对话……应该支持全部打开进行处理」。
对「目标账号」列表里的**每一个**账号逐个清一遍（串行 for + 进度提示）。

为什么串行不并发：删除要在页面里发 fetch，而驱动一次只服务一个 profile
（串行单例设计），并发只会互相顶掉。

### py：三条新命令

- **全推 <平台>** —— 把 tokens/ 里**所有**账号一次推给该平台（用户：「把我现存的几个账号弄进去」）。
  实测：\`全推 deepseek\` → default 登录成功；奶奶的凭据已被探针判为过期（如实报出）。
- **检 [平台]** —— 逐个账号 \`/credentials/inject\` 注入验证，回答「token/cookie 还有没有效」。
  判据是**页面探针**而不是看本地文件，所以结论就是真实可用性。
- **+ <名字> [平台]** —— 添加账号时选平台。deepseek 走本脚本抓 token；
  元宝/豆包先在插件里建好槽位，再去插件那边登录（本脚本抓不到它们的登录态，
  那在插件的 Edge profile 里）。

### 顺带

- py 帮助文本补齐了新命令。
- 已知限制：**「全部打开浏览器」做不到** —— 驱动只维持一条 CDP 连接
  （\`this.conn\`），换平台会 shutdown 上一个。要真正同时开多个浏览器，
  得把驱动改成「多连接（Map）+ 每平台独立端口」，是一次实质重构，待排期。

## 2026-10-16 · 会话删除默认改回「从不」+ py 增加平台无关的「推」

### sessionDeleteMode 默认 *delay* → **never**（重要修正）

用户担心：「机器产生的对话我能不能留着下次用，不要轻轻松松把窗口挤爆了」。

这里我原先搞错了方向：

- webin 的机制是**差分投喂** —— 每个 DSH 会话绑定到**一个**网页版对话，
  之后每轮只发**增量**（\`diffPrompt\`）。所以那个网页对话是**这个会话的上下文载体**，
  不是垃圾。
- 而我上一版把默认设成 \`delay\`（30 分钟后删）⇒ **删掉的正是会话赖以续接的载体**：
  下一轮要么新建对话（丢上下文），要么发到已被删的 chatUrl。
- 「挤爆窗口」本来就有解：单轮输入超过 \`compactionFileThresholdChars\`（10 万字符）
  会被打包成附件走 \`.txt\` 通道。

⇒ 默认改回 **never**（留着）。想清理随时用设置页的「立即清理」按钮（手动、可控）。
\`count\` 模式保留，但注释与提示都写明它同样会切掉那些会话的连续性。

### py 增加「推 <平台> <账号> <文件>」—— 平台无关

用户要求「py 要管的不止是 DeepSeek 的账号，元宝豆包的放一起管」。

新增 \`plugin_push()\`：把两行凭据文件推给插件任意平台的任意账号，
并立刻走 \`/credentials/inject\` 注入登录 + 用页面探针验证。

实测：\`推 deepseek default <py导出的default.txt>\` → ✓ 凭据已推给 deepseek#default
→ ✓ 登录成功（cookie 写入 5 条）。

现在 py 里与插件相关的命令：
- \`p\` / \`插件\` —— 列出**所有平台**的账号（登录态 / 凭据 / 当前生效）
- \`切 <平台> <账号>\` —— 切换该平台的当前账号
- \`推 <平台> <账号> <文件>\` —— 推凭据并登录（平台无关）

## 2026-10-16 · 设置页「浏览器 / 清理」UI（手动控浏览器 + 删对话策略）

用户两次点名缺的两样，一起补上。两者都是 `edgeDriver` 配置块里的字段，
所以合成一个区块。

### ① 手动控制后端浏览器（用户原话：「希望能够支持我手动控制后端浏览器是否运行，
手动控制自动关闭时间」）

- **运行状态**：显示「运行中（PID xxx）/ 未运行」（来自 `/status`，2s 刷新）
- **启动 / 关闭按钮** —— 为此新增两个接口：
  - `POST /edge/start`：手动拉起浏览器并连上 CDP。意义是**把冷启动时间提前付掉**
    （用户抱怨过「每次重启响应很慢」，冷启动约 14 秒，第一条消息全在等它）
  - `POST /edge/stop`：立刻关掉腾内存。走 CDP `Browser.close`（优雅退出 ⇒
    会写盘，**登录态不丢**）。driver 忙时返回 409，不打断正在生成的回复
- **启用开关**：`edgeDriver.enabled`（停用 = LDW 模型不可用）
- **自动关闭时间**：`idleShutdownMs` 用**分钟**输入（0 = 不自动关）

### ② 删对话的 UI（用户原话：「删对话的UI你也没做」）

会话回收策略（`never`/`immediate`/`delay`/`count`）的后端与配置早就做好了，
但设置页一直没有入口 —— 这次补上：

- 模式下拉，每个选项带人话解释（选 `delay` 时提示「推荐」，选 `immediate`
  时提示「最像机器人，不推荐」）
- 选 `delay` 才显示「存活时间（分钟）」，选 `count` 才显示「最多留几个」
- 明确写出安全边界：**只清机器人自己建的对话，绝不碰历史与置顶**

### 实现上的两个坑（都写在注释里）

1. `PUT /config` 是**整份替换**，所以必须 GET 拿全量、只改 `edgeDriver` 里的键
   再 PUT —— 只提交局部会被归一化器当成缺字段而回退默认值。
2. 启用开关用**函数式更新** `setCfg(prev => ...)`：用渲染期捕获的陈旧值会丢点击。

`npm test` 61 项 + `npm run verify` 26 项全绿。

## 2026-10-16 · 设置页「账号管理」UI（多账号）

补上最后一块：host 端的账号能力全都在（增删槽位、切当前、导入凭据、注入登录、
状态查询），但设置页**一个入口都没有**（client.js 里 `accounts`/`slotStatus`
出现 0 次）——只能靠 CLI。现在有了。

### 新增 `LdwAccountsSection`（设置页「账号」区块）

每个平台一张可折叠卡（`<details>`），里面：

- **槽位列表**：一行一个 —— 名称 +「当前」标记 + 「已登录/未登录」（鼠标悬停
  能看到**判据**：`via cookie (hy_token)` 这种）+「设为当前」+「删除」
  （`default` 槽位不可删，它是兜底身份）。
- **新增槽位**：输入名字 + 按钮。**中文可以**（host 侧已支持）；名字非法时
  显示 host 给的具体原因，不静默失败。
- **粘贴凭据登录**：槽位名 + 两行凭据（第 1 行 token、第 2 行 cookie）→ 写入
  凭据文件 → 槽位不在表里就自动补 → 注入登录 → 用页面探针报结果。

### 为什么写成**独立组件**而不是塞进 `LdwSettings` 的渲染树

`LdwSettings` 的 `return` 是一棵几千字符深的 `React.createElement` 嵌套树
（一整行！），往里插东西极易改坏。这个组件自己拉 `/accounts`、自己 5s 刷新，
对外只暴露「插进渲染树的一个位置」，对既有代码**零侵入**。

### 几个刻意的取舍（都写在代码注释里了）

- **两行格式**与桌面那个 `chat.deepseek.com令牌.py` 的导出格式一致 ——
  直接从文件里复制粘贴就行。只有一行、且长得像 cookie（有 `=` 没有 `{`）时
  按「只有 cookie」处理（有些平台不需要 token 那一半）。
- `PUT /accounts` 时**必须显式带上原 active** —— host 对缺失的 active 会回落到
  `"default"`，不传的话「加一个账号」会把当前槽位悄悄重置掉。
- 删除槽位会顺手清凭据，但**保留浏览器 profile 目录**（下次登录不用重新扫码）。
- 新增 9 条 CSS（`.ldw-acc-*`），沿用文件里的主题变量
  （`--dsw-alias-state-success-primary` 等），不引入新体系。

`npm test` 61 项 + `npm run verify` 26 项全绿；`client.js` +15.9 KB。

## 2026-10-16 · 真机验证：cookie 持久化修复**确认生效**

上一节的两个修复，重启后实测通过。

**证据一：注入的 cookie 全是持久 cookie**（问浏览器自己要的属性，最权威）

```
Network.getCookies → 5 条，全部 session:false
  ds_session_id / .thumbcache_* / smidV2 / HWWAFSESID / HWWAFSESTIME
  → 2027-04-14 到期（180 天后）
```

**证据二：关掉浏览器后 cookie 仍在磁盘上**

```
Browser.close 优雅关闭 → 残留进程 0 → -wal 已空（刷盘完成）
Cookies: 28672 bytes，deepseek 域 cookie 数 = 5 条（全在）
探针（走 cookie 判据，不再依赖快照）：
  deepseek#default  loggedIn=true  reason=cookie  cookie=ds_session_id
  deepseek#验证号    loggedIn=true  reason=cookie  cookie=ds_session_id
```

**⚠️ 一个测试方法上的坑（值得记下来）**

第一次验证时用 `Stop-Process -Force` **强杀** Edge，磁盘上得到 **0 条 cookie**，
差点误判成「修复没生效」。真实原因是：**Chromium 被强杀时不会刷盘**，
cookie 还留在内存/未提交的 WAL 里。

正确做法有两条，都比强杀可靠：
1. 让它**优雅退出**（`Browser.close`，或等插件的空闲关停），再读磁盘；
2. **直接问浏览器自己要属性** —— 不依赖刷盘时机，最可靠。

**新增** `scripts/check-cookie-persistence.mjs`：把这条诊断固化下来。
它调一次注入、连 CDP 读 `Network.getCookies`、逐条报告 `session` 属性，
最后优雅关闭 —— 以后怀疑 cookie 没落盘就跑它。

**清理**：测试用的槽位与 profile 目录（`验证号` / `测试B` / `second`，共约 231 MB）
与测试快照都已删除；`auth/` 恢复为 `deepseek.json` + `default.json`。

## 2026-10-16 · 修「粘贴登录」两个致命问题 + 账号管理 CLI

### 问题一：注入的 cookie 是**会话 cookie**，浏览器一关登录态就没了

`Network.setCookie` **不给 `expires`** 时，Chromium 把它当**会话 cookie**：
只活在内存里，**不写进磁盘的 cookie 库**，浏览器一关即丢。

症状（真机实测）：注入后**当次**页面里登录成功（探针在页面里读到登录态），
但磁盘的 `<profile>/Default/Network/Cookies` 里**根本没有那些 cookie** ⇒
重启 DSH / 空闲关掉 Edge 之后登录态凭空消失；同一时刻
`/accounts` 报「未登录」而页面里明明登录着 —— 判据和现实打架，最难查。

**修**：注入时统一给 180 天的过期时间，变成持久 cookie。

### 问题二：Edge 运行期间，cookie 判据**必然**失效

Chromium **独占锁**住 `<profile>/Default/Network/Cookies`，Windows 下连复制
都拒绝（`EBUSY: resource busy or locked`，重试也没用，只有等 Edge 关掉）。
而「刚注入完、Edge 还开着」恰恰是最常见的时刻。

**修**（两条一起）：
1. `readViaCopy` 加**有限重试**（3 次 × 100ms，同步 sleep 用 `Atomics.wait`），
   覆盖写完短暂加锁的情形；仍拿不到就返回「读不了」，让调用方回退到快照判据
   —— **绝不因为读不到 cookie 就假装未登录**。
2. **注入成功后补写一份登录快照**（与「任务跑通后补快照」同一套逻辑）。
   快照是纯文件、不受锁影响、跨重启存活，门禁立刻就有依据。

### 新增：账号管理 CLI `scripts/accounts.mjs`

设置页 UI 还没做，先用这个顶着（也方便脚本化）：

```
node scripts/accounts.mjs list
node scripts/accounts.mjs add <平台> <槽位>          # 中文槽位名可以
node scripts/accounts.mjs switch <平台> <槽位>
node scripts/accounts.mjs rm <平台> <槽位>
node scripts/accounts.mjs import <平台> <槽位> <两行凭据文件> [--login]
node scripts/accounts.mjs login <平台> <槽位>
```

`import` 的文件格式就是**两行**（第 1 行 token、第 2 行 cookie），
**正好兼容桌面那个 `chat.deepseek.com令牌.py` 导出的 `tokens/<名字>.txt`**：
一条命令就能把 py 里导出的账号搬进插件并登录。

实测（真凭据）：`import deepseek 测试B <py导出的default.txt> --login`
→ 凭据写入 → 自动新增槽位 → 注入登录 → **✓ 登录成功**，
且 profile 目录 `edge-ldw/deepseek/测试B/` 与默认槽位**完全隔离**
（各自的 cookie 库分开落盘）。

⚠️ 刻意**不支持命令行直接传凭据**（会进 shell 历史与进程列表）—— 只从文件读。

## 2026-10-16 · 中文槽位名支持（槽位名规则收拢到单一模块）

用户要中文账号名（他原来的 py 里就有「奶奶」这类名字）。做完发现这远不止
「放开一个正则」—— 槽位名同时决定**三个地方**，每处都有自己的坑。

### 新增 `lib/slot-names.js`：规则的**唯一**来源

槽位名会落进：① 快照文件名 `auth/<平台>#<槽位>.json`；② profile 目录名
`edge-ldw/<平台>/<槽位>/`；③ 配置键。三处**必须同一套规则**。

历史上就是因为两处各写一份正则、各漏一样（白名单漏了分隔符 `#`），
才有了「所有槽位全落到 default.json」的双向串号（commit 2cf780f 修的）。
所以现在规则收拢成一个模块，`index.js` 与 `edge-driver.js` 都 import 它。

规则改成**黑名单**（只挡真会出事的）：路径分隔 `/ \`、Windows 保留字符
`: * ? " < > |`、控制字符、恰好是 `.`/`..`、槽位名里的 `#`（它是组合名分隔符）。
**中文、日文、emoji、空格、点都放行。**

### 修掉的三个连带问题

1. **sanitizer 把中文全变 `_`**（两处：`edgeProfileDirFor` 与 `userDataDirFor`）
   旧的 `replace(/[^A-Za-z0-9_-]/g,"_")` 会让「奶奶」和「爷爷」**都变成 `__`**
   ⇒ 两个账号**共用同一个浏览器 profile**、登录态互相覆盖。
   改用 `safePathSegment`：只替换危险字符，中文原样保留。
2. **URL 路径里的中文没解码**（两处：`DELETE /accounts/<平台>/<槽位>` 与
   `slotFromPath`）。中文在 URL 里是 percent-encoded，不解码就会被校验拒掉 ——
   表现是「中文槽位能建、却删不掉」，或快照路径被静默打回 default。
   已补 `decodeURIComponent`（畸形编码保持原样交给校验拒，不抛错）。
3. **静默丢弃**（上一版已修，这次换了新规则的文案）：被拒的槽位名会记进
   `problems` 或直接返回 400 + 明确说明，不再悄悄消失。

### 新增测试 `scripts/test-slot-names.mjs`（`npm test`，61 项）

覆盖：该放行的（中文/日文/emoji/带点/带空格）、该挡的（穿越/保留字符/超长/
非字符串）、快照名必须允许 `#`、`safePathSegment` 的中文不撞车（还拿旧实现
当反例证明它确实会撞）、以及**交叉验证 `EdgeDriver.userDataDirFor` 与
`edgeProfileDirFor` 规则一致**（那是同类风险点）。

### 其它

- 移除已失效账号的凭据（用户说那个账号废了）。
- `verify-package.mjs` 的必备文件清单加入 `lib/slot-names.js`（26 项）。
- `install.ps1` 的必备文件清单同步加入（漏了会「装上即崩」）。

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
