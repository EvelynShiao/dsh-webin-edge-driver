# dsh-webin-edge-driver

给 **dsh-webin（LDW）** 补一个「真 Edge」浏览器载体 —— 让它在 **web 档案（纯 Node，没有 Electron）** 下也能正常登录和使用。

> 只在 Windows + 本机装有 Edge 的环境下验证过。

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
