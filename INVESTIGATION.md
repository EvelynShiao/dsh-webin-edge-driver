# 手机 UI 失灵调查（未发布，真实手机实例验收未完成）

## 第六轮：在真实 DSH GUI 上跑起来，并找到「整套界面失灵」的直接机制

这一轮不再只做隔离单测：用独立 `DSH_HOME` + 独立端口 3099 + 只挂修复版插件，起了第二个真实 DSH 实例，再用 Chromium 真点。

### 已实测通过（真实 GUI，非 mock）

| 你要的功能 | 结果 | 证据 |
| --- | --- | --- |
| 打开页面不白屏 | 通过 | body 有内容、`pageerror` 0 |
| 新建会话 | 通过 | 点 New session 后出现输入框 |
| 账号/设置页 | 通过 | 设置里「LDW 网页版」完整渲染 3 个平台、登录状态、去登录按钮 |
| 模型切换 | 通过 | 模型菜单列出 `LDW · 快速模式 / LDW · 深度思考`，选中后按钮变为 `current LDW · 快速模式` |
| 发消息 | 通过（链路） | 点发送 → 进入队列 → host 驱动领取 → 真的拉起 Chrome → CDP 连上 → 因该验证实例浏览器未登录而返回 `WEBIN_NOT_LOGGED_IN` 明确报错，**页面不卡死、仍可交互** |
| 覆盖层吞点击 | 已消除 | 手机视口下 `.webin-host` 数量为 0 |

### ⭐ 这一轮找到的关键机制：「启动风暴」

在同一台机器上用**被占用的 CDP 端口**制造「浏览器连不上」，对比同一 60 秒窗口：

| 版本 | 启动/探测次数 |
| --- | --- |
| 修复前（无退避） | 每 1.5 秒重试一次，40 秒拉起 27 个 Chrome，主线程接近满核、端口能连上却不回响应 |
| 修复后（退避 + 重入锁） | 同样窗口只尝试 2 次，`launched` 不再增长 |

机型手机上这就足以解释「插件一启用，账号页/模型/发送/新会话全部点不动」——不是每个功能各自坏，而是**几十个 Chromium 子进程把主线程和内存拖死**。

### 本轮改动

- 新增 `lib/launch-backoff.js`：按「平台#槽位」独立退避 5s→15s→45s→120s，连续失败 3 次判定放弃。
- `lib/index.js` 领活循环：接入退避；放弃时**立刻把该平台×槽位的待领任务判失败并给出可读原因**，不再让界面干等超时。
- 领活循环加重入锁：`ensureEdge` 等端口期间，1.5 秒定时器不会并发再拉一个浏览器。
- `/status` 新增 `launchFailures`，设置页/诊断能看到「已重试几次、多久后重试」。
- 新增 `scripts/test-launch-backoff.mjs`（3 项，含「60 秒内尝试 ≤3 次」回归），并入 `npm run test:safety`。

### 仍未完成（不隐瞒）

- 没有在**你自己的 3080 实例**上启用验证：启用需要改 bundles 并重启 Web，会中断当前会话，且失败会让你再次无法使用。**开之前我会先告诉你并征得同意。**
- 验证实例里浏览器是全新 profile（没有你的 DeepSeek 登录态），所以「真实网页回复」没有跑通；链路与错误提示已验证。
- 右栏 LDW 标签在这个 390px 视口下没找到 `role=tab`，标签内容渲染未确认（不影响上面的四项，也不再有覆盖层遮挡）。

---

## 第二轮进展（优先于下方第一轮记录）

- 两条整页自动刷新均已移除：host tapIndex 注入和 desktop heartbeat reload。保留 build/heartbeat 协议。
- Cookie 探针改为单 worker、有界队列/缓存、超时、失败冷却与 unref；支持 Default/Network/Cookies、Default/Cookies、Cookies。每任务独立副本，不复用旧 WAL/SHM。
- host 状态、账号、模型列表及发送前门禁接入 await waitForCookieProbe；快照读取改异步，冷启动首轮等待真实结果而非把 pending 当未登录。
- 模型列表逐槽位验证，不再无条件把 default 当可用；providerInfo 未改。
- LdwLoginButton 隐藏时停 poll，in-flight 限制、请求 timeout/abort、卸载取消、MutationObserver rAF 合并。
- 全套测试通过：包27项、槽位61项、7组件×2渲染、Chromium点击命中、入口轮询、5组worker合成测试。
- 真实 apply + 临时 DSH_HOME + 合成 SQLite 的 handler 测试通过：首轮登录结果、账号新增/切换/持久化、模型隐藏/恢复。三个库各10000行的受控测试，主线程冷状态耗时从约128ms降至约14–24ms；不是实机历史故障耗时。
- 所有改动仅在本调查仓库，未发布、未启用、未重启。辅助任务异常中断后已由主代理直接重跑全部测试；不能仅依赖辅助代理声称完成。

### 真实页面观测目前缺口

/app/ui/dump 和 screenshot 返回 SCREEN_TARGET_UNAVAILABLE；设备信息显示前台且屏幕亮。受保护 adb-shell id 返回：`[DEVICE_CHANNEL_UNAVAILABLE] 请在设置 → 设备能力授权中连接 root、Shizuku 或 ADB 通道`。没有绕过或重复请求权限。3080在线但未认证请求401，旧本地诊断cookie也已失效。因此尚未完成启用前后真实页面采样，也未验收真实消息发送/新对话。用户已授权能自行操作的部分，无需再让用户处理技术操作；遇原生权限仍须尊重。

### 第三轮复核

- 修复多账号门禁不一致：模型列表逐槽位查登录，不因当前active未登录而隐藏其他已登录槽位；发送校验实际targetAccount，不再拿平台其他账号的登录状态放行。新断言已用合成Cookie+真实adapter.stream验证未登录目标返回WEBIN_NOT_LOGGED_IN。
- 保留自定义provider的no-rule兼容行为，避免逐槽位验证把自定义模型全部隐藏。
- worker启动失败与close取消等待者测试补齐，6组测试全部通过，未登录与合成登录两种host集成测试均通过。
- 这些仍是隔离协议测试，不是消息发送成功或新对话UI实机验收。

### 第四轮：发送协议闭环

- 通过真实 adapter.stream 发起两条不同合成session的消息，真实 /job/next 按session领取，再经 /job/:id/result 提交合成回复，stream收到stop完成事件。
- 验证两任务ID不同、两新session均freshChat=true、其他session不能领取已分配任务。没有真实模型网络调用，不等同GUI创建新会话或网页模型真实回复。
- npm run test:safety 固化为统一命令并通过；新增worker文件进入包必备检查（现28项）。Chromium覆盖层测试独立为test:overlay；有登录的大表发送测试用 TEST_COOKIE_ROWS=10000 node scripts/test-host-isolation.mjs。

### 第五轮：发布完整性与验收阻碍

- Chromium新增无bridge、错误协议版本、缺acquire三种降级验证，均不挂覆盖层；有效bridge仍挂原host。
- npm pack --dry-run 检查35个文件，worker及proot launcher均被包含；未生成/安装发布包、未commit/push。
- 同一真实验收阻碍持续三个自动轮次：当前没有可用的原生读屏/截屏目标，设备shell无已连接授权通道，3080未认证、旧诊断登录失效。无法安全观察开启后的现有GUI，故不能逐项实机验收，也不盲开插件。
- 本轮目标应标记blocked而不是complete。可继续的条件：原生设备通道恢复，或取得用户正常登录的3080浏览器诊断访问；不得修改鉴权、签发伪造cookie或绕过设备策略。

### 下一步

1. 复核worker取消/错误、异步门禁和多账号兼容；补全消息队列隔离测试。
2. 获得合法可观测的3080页面后做四项真实验收；启用插件前明确告知用户。
3. 不把脚本通过或隔离handler配置成功当成真实UI/真实模型发送成功。仍不发布半验证版本。

---

以下保留第一轮记录（部分待办已在上方完成）：

## 实际状态

- gitcode main 查询结果：cb0f5997ee9ab3f6387a64231e73b17003fb6f19，9999.9.44。
- 手机已安装包仍为 9999.9.43；当前 profiles/web/package.json 未将其列入 bundles。
- 本目录为新 clone 的独立调查副本；未改已安装插件、配置、凭据、浏览器登录 profile，未发布或重启服务。
- 原 /root/.dsh/work/webin-src 有未提交改动，保持不动。

## 已复现的机制及边界

客户端 desktopBrowser() 不可用时，LdwHost 初始化 effect 仅返回，但原 shell.overlay 仍渲染 fixed 的 webin-host。DSH overlay CSS 为父层 pointer-events:none、直接子元素 pointer-events:auto；webin-note 的 none 不让外层穿透。

隔离 Chromium 测试使用真实组件渲染体、真实插件 CSS 与 DSH overlay 的上述 CSS，模拟 390×844 非零占位矩形，没有访问真实 DSH/API/账号：

- 基线：hit=webin-host，hostCount=1，clicks=0，断言失败。
- 修复后：hit=under，hostCount=0，clicks=1，断言通过。

这是覆盖层遮挡机制的受控复现，**不是实机全流程复现**：测试手动发布矩形、不运行 React effects、不证明真实手机必然生成全屏矩形；未证明它是所有 UI 失灵的唯一根因。

## 最小修改

- lib/client.js：无 hooks 的 LdwHostSlot 包装组件，复用现有 desktopBrowser 能力判据，无 bridge 返回 null；有 bridge 仍 createElement(LdwHost)。
- 无 bridge 的 placeholder 不测量/发布矩形，以普通文档流显示说明；保留原会话身份上报。
- 设置与输入入口仍注册；host 独立 CDP 队列/模型适配器未改。
- scripts/test-slot-names.mjs：使用本平台绝对路径及 path.join，去掉只在 Windows 成立的硬编码预期。
- scripts/test-mobile-overlay.mjs：新隔离测试；脚本以 WEBIN_TEST_CHROME 指定其他平台 Chrome 可执行文件，默认用本目录 proot 测试启动器。依赖当前环境已提供的 playwright；没有新增下载依赖。

## 验证

```sh
node scripts/test-mobile-overlay.mjs
node scripts/verify-package.mjs
node scripts/test-slot-names.mjs
node scripts/render-smoke.mjs
git diff --check
```

结果：点击测试通过、包检查27项通过、槽位61项通过、7组件×2模式渲染通过、diff检查通过。桌面分支只验证包装后仍返回 host，不代表真实 Desktop guest 生命周期端到端通过。

## 交接文档需要纠正/细分的判断

- 当前 LLM registry 的 prepareRoutes 按显式 providers 注册，并直接读取 providerInfo(provider).id/name。providerInfo 并非自主路由发现；不能仅凭对任意参数返回对象就认定抢占其他渠道。返回 undefined 则可能在注册路径触发 TypeError。本轮不改该处。
- 当前 cookie 探针已有5秒 Map缓存和复制后读取逻辑；不能说完全无缓存。Default/Cookies 缺少支持仍成立，本轮未修改。
- 无 bridge 时 ready=false，LdwHost 就绪后的心跳/任务轮询/客户端版本刷新不执行。但 host 的 tapIndex 整页自动刷新注入是另一条独立路径，仍待处理。
- 输入入口即使返回 null，body MutationObserver 和5秒 status 请求仍可能运行；缺少超时/并发控制，是另一个待测性能风险。

## 发布前剩余工作

1. 在可观测的真实 DSH 页面记录点击命中、placeholder矩形、console、长任务与网络耗时，区分遮挡、事件循环堵塞、整页重载。
2. 验证 Desktop 内嵌 guest，以及 Web/手机设置、模型切换、新会话、发送和独立CDP任务。
3. cookie候选路径、同步读盘、status请求积累和自动重载应分别测试修复，不混入本最小补丁。
4. 通过后再决定版本号/提交/远端同步/原生插件管理器云端更新。本轮未提高版本、未commit、未push、未安装，不能宣称手机已修好。
