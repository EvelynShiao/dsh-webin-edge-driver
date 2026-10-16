# Changelog

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
