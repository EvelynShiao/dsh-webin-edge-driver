# dsh-webin-edge-driver

给 **dsh-webin（LDW）** 补一个「真 Edge」浏览器载体 —— 让它在 **web 档案（纯 Node，没有 Electron）** 下也能正常登录和使用。

> 只在 Windows + 本机装有 Edge 的环境下验证过。

---

## 📦 改造全记录（2026-10-18 三批合辑）

> 本插件经过三批定制改造（全部只动本机已安装文件，不拉外部源码）。
> 按需求编号记录，每条含实现位置与设计理由。

### 第一批（上午）：八项需求

| # | 需求 | 实现 |
|---|---|---|
| 1 | 配置面板大项可折叠、默认收起（省手机渲染） | OFM 插件 `Section` 组件默认 `open:false`，▸/▾ 箭头、键盘可达；`ofm_sec_open` caret 旋转 CSS |
| 2 | 开机自动启动某账号 | `autoWakeTarget`（"平台#槽位"）+ `autoWakeDelayMs`（默认 45s）；`ctx.effect` 延迟唤醒，失败静默；设置页「开机自启」下拉 |
| 3 | 闲置多久自动关窗 | `idleShutdownMs` 分钟旋钮（已有）+ 驱动器 `touchIdle` 自动关停 |
| 4 | 对话自动删除（真删除） | `session-gc.js` 四模式（never/immediate/delay/count）：账本持久化、差集判定只删机器人自建、置顶跳过；UI 全套旋钮 |
| 5 | 元宝/豆包适配 | 内置 provider 选择器（Quill/tiptap 输入、enterOnly 发送、回复选择器实测校准） |
| 6 | 纯聊天模式 | `dsh-preset-lite` 新增 `lite-chat` 预设（零工具，只 persona）；工坊 `chat` 槽位 |
| 7 | 机器标题带 LDW 前缀 | streamOnce 拦 `purpose==="session-title"`，产出强制 `LDW ` 前缀（幂等） |
| 8 | LDW 快速/思考合并为一个模型 | 单模型 `ldw` + `reasoningEfforts` off(快速)/medium(思考)；`thinkingFor()` 把 effort 翻译成页面开关；旧 id `ldw-fast/think` 靠 `effortFromLegacyId` 兜底 |

### 第二批（下午）：模型自动识别

- 新文件 **`lib/model-autodetect.js`**：探测结果持久化（`webin/detected-models/<平台>.json`，14 天过期）、`slugFromText`（已知代号 hy3/hy4/deepseek/t1/r1 + 中文模式名）、`mergeModels`（叠加不替换、内置兜底）。
- 驱动器 **`detectPageModels()`**：找模型按钮 → 点开 → 全量读取 → Escape 关闭。
- 新路由：`POST /providers/:id/detect-models`（busy 409）、`GET /providers/:id/detected-models`。
- `listModels`/`resolve` 统一走 `effectiveModelsFor()` 合并口径。
- 设置页「识别模型清单」按钮。
- 豆包内置改**聊天模式/工作模式**双条目 + off/medium 强度。
- 顺手修了 lite-plain 在工坊读不到（缺 `workshop:plain` 标记）的旧 bug。

### 第三批（晚上）：双层菜单 + 模式锁定 + 前缀回收 + 分段回放

1. **元宝双层菜单**（用户截图定案）：
   - 模型层 = Hy3 / Hy4 preview（仅 Expert）/ DeepSeek（`pageModel`）；
   - 模式层 = Instant / Thinking / Expert（`reasoningEfforts`，即「思考强度」）。
   - `pageModeFor()` 按 effort 翻译成模式菜单项；`resolvedModelInfo` 支持模型级 efforts 覆盖（Hy4 锁 Expert）。
   - 驱动器面板操作重构：`_openPanel/_readPanelItems/_pickPanelItem/_closePanel` 通用四步；`applyPageMode`（模式）与 `applyPageModel`（模型，支持展开 Models 子层）分离，**先模式后模型**（元宝切模式会重置模型子菜单）。
2. **豆包模式锁定**：工作/聊天模式锁在会话上，必须开新窗口才能切。
   - 游标新增 `pageSig`（`模式#模型` 签名）；变了 ⇒ `forceFresh` ⇒ 丢 `chatUrl` 开新对话 + **全量重发历史**（`diffPrompt` 支持 `forceFresh`）。
3. **分段回放**（用户设计「一段发过去，暂停 AI 回复，再发另一段」）：
   - forceFresh 首轮把历史按消息边界切 ≤1200 字符的段挂 `job.replaySegments`；
   - 驱动器逐段「填字 → 发送 → 立刻点停（buildStopScript）→ 清输入框」，最后才发真问题、正常等完整回复；
   - 回放残留计入回复基线，`waitForReply` 只认新增那条。
4. **LDW 前缀识别回收**（用户点名「删除旧对话靠识别带 LDW 的标签」）：
   - DeepSeek provider 声明 `sessionApi`（列表/删除端点实测来源；`renamePath` 待抓包，占位）；
   - `renameSession()`：发送后把本轮新建对话改名 `LDW xxx`（runJob 第 11 步，失败静默）；
   - `purgeByLdwTitle()`：网页列表按前缀删（不置顶）+ **账本孤儿清账**（用户手删过的，本地副本一并抹）；
   - `/sessions/cleanup` force 模式补扫前缀 + 孤儿；session-gc.js 导出 `looksLikeLdwTitle/pickByLdwTitle`。
5. **知识库自然语言协议**（用户点名格式，降低风控特征）：
   - 新预设 `lite-chat-kb`（dsh-preset-lite）：persona + knowledge-sqlite 两个插件（工具面=两层知识库）；
   - 协议句式：**「我要调动第一层知识库，搜索XX」→ knowledge_search；「我要调动第二层知识库，搜索XX」→ archives_search**；
   - webin `translateKbProtocol()` 在 parseToolCalls 前把这句话翻译成 ```ldw 调用（严格判据：短文本 + 工具在目录中 + 非空查询）；
   - 工坊新增 `kb` 槽位（四槽位：dafeyu/plain/chat/kb）。
6. **压缩 .txt 出口分层**（用户定案「LDW 网页端开关高于全局、但不作用于全局」）：
   - 新配置键 `ldwCompactionOverride`（空=跟随全局 / never/auto/always=LDW 专用）；
   - streamOnce 压缩分支优先读它；设置页新「LDW 网页端出口（优先）」下拉（choiceLabels 支持）；
   - 全局开关（adapter-compat 的出口设置）只写 `compactionFileMode`，与 LDW 专用键互不污染。
7. **探测升级为两层**：`detectPageModels()` 返回 `modes`（模式层）+ `models`（Models 子层）；`modesFromItems` 映射成 effort 档位；`saveDetected` 存两层；`effectiveEffortsFor()` 把探测到的模式层接进「思考强度」下拉——**模型和思考强度都自动识别**。

### 验证记录

- 全部改动文件 `node --check` 通过（index/edge-driver/client/session-gc/model-autodetect/session-kit）。
- 测试套件全绿：verify-package(28) / test-slot-names(61) / render-smoke(7组件×2) / login-cookie-probe / login-button / launch-backoff / account-fallback / tool-parse(5) / adapter-compat exit-prefs(5)。
- preset YAML 用 DSH 同款 yaml 包解析：6 条 insert 全在（lite/plain/v2/v3/chat-kb/chat）；workshop 四槽位标记三件套齐。
- test-mobile-overlay 跳过（本机无 playwright，环境问题）。

### 备份

`.bak-20261018-ldwbatch/`：第二批前的全部原始文件（lib×5 + package.json + cordis.patch.yml + preset×2 + ofm×2）。

---

## 这解决什么问题

`dsh-webin` 原版把「真浏览器」这一手交给 **DSH 桌面版（Electron）** 的 webview guest。

但如果你跑的是 **web 档案**（`start-dsh.ps1` 那种纯 Node 启动），环境里没有
`globalThis.dshDesktop`，于是：

```
client.js:4975  function desktopBrowser() {
                  const carrier = globalThis.dshDesktop;
                  if (carrier === void 0 || carrier === null) return void 0;   // ← 这里就返回了
                }
client.js:5046  setStatus("当前环境没有 DSH 桌面浏览器通道。")
```

面板永远不挂载 ⇒ **LDW 登不上、任务没人领**。

**注意：这不是登录凭证问题。** 你贴 Token、贴 Cookie 都没用，因为
client 在 `desktopBrowser()` 就 return 了，**面板根本没挂载**，没地方贴。

---

## 这个补丁做什么

在 **host 半**（`lib/index.js`）里补一只「手」：用 **CDP（Chrome DevTools Protocol）**
驱动**本机真 Edge**，干原本 webview 干的活：

```
领活 → 导航 → 填字 → 等 2~4 秒 → 点发送 → 读回复 → 交结果 → 清废对话
```

### 核心设计：脚本**逐字复用**，一个字不改

`lib/edge-driver-scripts.js` 是从 `client.js` **逐字提取**的原生 DOM 脚本
（`buildFillScript` / `buildTriggerScript` / `buildScrapeScript` /
`buildProbeScript` / `buildDeepSeekHook` / `buildSnapshotScript` /
`buildStopScript` / `buildClearInputScript` 等 14 个）。

所以 webin 的优势**一个都没丢**：

| webin 的优势 | 本补丁 |
|---|---|
| 真浏览器、真打字、真点发送 | ✅ 真 Edge，脚本逐字复用 |
| 不伪造 header、不自己拼请求 | ✅ 一样，请求是**页面自己发的** |
| 从 hook 读流式回复 | ✅ 注入的还是 webin 原生 hook |
| 差分发送 / 工具调用 / 会话绑定 | ✅ 全在 host 半，本补丁不碰 |
| 2~4 秒随机间隔、串行 | ✅ 照抄 `sendDelayMinMs` / `MaxMs` |

**换掉的只有「脚本在哪个 Chromium 里跑」。**

---

## 三个实现要点（踩过的坑，写在这免得你再踩）

### 1. 「隐藏窗口」用移出屏幕，**绝不用 `--headless`**

`--headless` 是最典型的机器人特征（UA 里带 `HeadlessChrome`、缺 GPU 信息），
一开就等于自毁反封优势。

本补丁把窗口移到 `-24000,-24000`：

- 页面 `document.visibilityState` 仍是 **`'visible'`**（和真实用户拖到第二屏一样）
- UA / WebGL / 字体 **全部不变** ⇒ 指纹零变化
- 你看不见它，但它是个货真价实的可见窗口

⚠️ **必须同时关掉后台节流**，否则屏幕外的窗口会被 Chromium 降频（定时器
1s → 1min、渲染停滞），页面「假死」：

```
--disable-background-timer-throttling
--disable-backgrounding-occluded-windows
--disable-renderer-backgrounding
```

这三个是**进程调度策略**，页面 JS 探测不到，也不影响任何指纹。

### 2. 登录态持久化：一平台一 profile 目录

```
<DSH_HOME>/edge-ldw/<平台id>/      ← profile（登录态在硬盘上）
<DSH_HOME>/edge-ldw/<平台id>/...   端口 9411 + 平台序号
```

原版 webin 的 partition 是 `dsh-sidebar-browser-${randomUUID()}`
（**随机 + 内存态**）—— 那正是它「每次重启都要重新登录」的根因。

本补丁用**平台 id** 当目录名 ⇒ 登录态跟着平台走，重启后还在原地。

### 3. 自动清理网页版废对话 ⭐

每开一个新 DSH 会话，网页版就多一条对话。用久了账号里全是「测试正常」
「链路通畅」这种一句话垃圾。

打开 `autoDeleteSessions` 后，任务跑完会删掉**本轮新建**的那条：

- 只删**本轮新建**的（对比任务前后的会话列表，取差集）
- **绝不**碰任务开始前就存在的对话
- **绝不**碰置顶的
- 拿不到基线时**直接放弃**（绝不「删最近 N 条」这种危险策略）

接口（实测自 DeepSeek 网页版）：

```
GET  /api/v0/chat_session/fetch_page?count=50&page=N   → 列表
POST /api/v0/chat_session/delete  {chat_session_id}    → 删除
```

---

## 安装

### 前置

- Windows + 本机装了 **Edge**（`msedge.exe`）
- DSH 用的是 **web 档案**（`%LOCALAPPDATA%\DeepSeekHarness\.dsh\profiles\web`）
- 已装 `dsh-webin`（版本 **0.2.23**；其他版本脚本可能不一致，见下）

### 步骤

```powershell
# 1) 备份（务必）
$PLUGIN = "$env:LOCALAPPDATA\DeepSeekHarness\.dsh\profiles\web\node_modules\dsh-webin"
Copy-Item $PLUGIN "$PLUGIN.bak-$(Get-Date -Format yyyyMMdd-HHmmss)" -Recurse -Force

# 2) 放入两个新文件
Copy-Item .\patch\edge-driver.js         "$PLUGIN\lib\" -Force
Copy-Item .\patch\edge-driver-scripts.js "$PLUGIN\lib\" -Force

# 3) 给 lib\index.js 打补丁（见下面「改动清单」）
#    或者跑： .\install.ps1
```

### 改动清单（`lib/index.js` 只加 4 处，不动原有逻辑）

| 位置 | 改动 |
|---|---|
| 顶部 import | `import { EdgeDriver, EDGE_DRIVER_DEFAULTS } from "./edge-driver.js";` |
| `checkConfig()` 里 | 加一行 `out.edgeDriver = normalizeEdgeDriverConfig(src.edgeDriver, problems);` |
| `apply()` 里 | 建 `EdgeDriver` 实例 + 心跳 + 领活循环（约 120 行） |
| `/status` 路由里 | 加一行 `edgeDriver: edgeDriver.status(),` |

<details>
<summary>展开：`apply()` 里的领活循环（原样贴）</summary>

见 `patch/edge-driver.js` 顶部注释；完整片段在仓库的 `INSTALL.md`。

</details>

---

## 配置

`<DSH_HOME>/webin/config.json` 里加 `edgeDriver` 块：

```json
{
  "edgeDriver": {
    "enabled": true,
    "port": 9411,
    "executable": "",
    "userDataDir": "",
    "hideWindow": true,
    "autoDeleteSessions": true,
    "sessionDeleteSettleMs": 4000,
    "idleShutdownMs": 120000,
    "launchTimeoutMs": 30000,
    "pollIntervalMs": 1500,
    "replyTimeoutMs": 600000,
    "sendDelayMinMs": 2000,
    "sendDelayMaxMs": 4000,
    "verboseLog": false
  }
}
```

| 键 | 说明 |
|---|---|
| `enabled` | `false` = 完全不动，回到 webin 原版行为 |
| `hideWindow` | `true` = 窗口移到屏幕外（**代码里写死不用 headless**） |
| `autoDeleteSessions` | `true` = 跑完自动删本轮新建的网页对话 |
| `idleShutdownMs` | 空闲这么久自动关 Edge（省内存）。`0` = 不自动关 |
| `userDataDir` | 留空 = `<DSH_HOME>/edge-ldw` |
| `port` | 基准端口，第 N 个平台用 `port + N` |

---

## 资源占用（实测）

| 状态 | 占用 |
|---|---|
| 不干活 | **0**（一个进程都没有，`running: false`） |
| 干活时 | 约 **596~617 MB**（省内存参数已开；不开约 670 MB） |
| 空闲超时后 | 自动关，回到 0 |

---

## 排查

```powershell
# 状态
Invoke-RestMethod http://127.0.0.1:3080/dsh-webin/api/status | ConvertTo-Json -Depth 6
```

看 `edgeDriver` 段：

| 字段 | 含义 |
|---|---|
| `running` | Edge 起了吗 |
| `cdpConnected` | CDP 连上了吗 |
| `targetUrl` | 停在哪个页面 |
| `windowHidden` | 窗口藏了吗 |
| `stats` | 领了几个活 / 成了几个 / 失败几个 |

**常见问题**

- **`failed` 涨、错误说「未登录」**：浏览器窗口会被**自动叫到前台**，你在里面登录一次即可（登录态会存下来）。
- **端口占用**：换个 `port`。
- **找不到 Edge**：在配置里显式填 `executable`。

---

## ⚠️ 版本对齐

`edge-driver-scripts.js` 里的脚本是**逐字提取**自 **dsh-webin v0.2.23**
（rev `f8d00be9c5df`）。文件头写了来源。

**dsh-webin 升级后必须重新提取**，否则页面上跑的是旧脚本：

```powershell
node .\patch\extract-scripts.mjs
```

它按缩进层级精确切函数，不重写任何一个字节。

---

## 已知限制

1. **只支持有 `urlPattern` / `inputSelectors` 定义的平台。** 加新平台要在
   provider 里给出 `homeUrl` + `urlPattern` + `completionPath`。
2. **DOM 兜底路径在 DeepSeek 上已失效**：DeepSeek 把类名换成随机哈希，
   `.ds-markdown` 这个选择器找不到了。但**主路径（hook 抓 SSE）好得很**，
   不影响使用。这跟本补丁无关 —— 原版装了桌面版一样会踩。
3. **一平台一只 Edge**（串行）。这是刻意的：并行会同时暴露多个浏览器
   指纹并发的特征，反而危险。

---

## License

MIT
