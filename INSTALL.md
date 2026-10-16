# 安装

本仓库是**完整插件包**（不是补丁集）。`lib/` 就是能直接跑的完整实现。

## 方式一：用 DSH 的插件机制（推荐，手机/电脑通用）

```bash
dsh plugin add dsh-webin-edge-driver
```

或直接从 git 装：

```bash
dsh plugin add https://github.com/EvelynShiao/dsh-webin-edge-driver.git
```

DSH 会读 `package.json` 里的 `dsh.bundle.patch`（→ `cordis.patch.yml`），
把插件插进 profile 的层栈。

**这就是「缺少 dsh.bundle.patch」那个报错的出处** —— 之前本仓库只有
`install.ps1` + `patch/`、**没有 `package.json`**，所以 DSH 压根不认为它是插件。
2026-10-16 起已改成完整包结构。

## 方式二：本地覆盖安装（只在电脑上有用）

已经装了 `dsh-webin`，想把手改的 `lib/` 直接盖上：

```powershell
.\install.ps1                 # 备份 + 覆盖 lib/
.\install.ps1 -RestartDsh     # 顺便结束 DSH 进程，然后你手动重启
```

它会先整目录备份到 `<插件目录>.bak-<时间戳>`，想回退盖回去就行。

## 方式三：手动复制

把 `lib/` 里的 7 个文件覆盖到：

```
%LOCALAPPDATA%\DeepSeekHarness\.dsh\profiles\web\node_modules\dsh-webin\lib\
```

再把 `provider.example.json` 放到插件根目录。

---

## 必须的 7 个文件

缺任何一个，插件**加载即崩**（`import` 解析失败，所有 provider 都不注册）：

| 文件 | 作用 |
|---|---|
| `index.js` | 插件入口（host 半）：provider 注册、HTTP 接口、登录门禁 |
| `client.js` | 界面半：LDW 设置页、模型选择器 UI |
| `edge-driver.js` | CDP 驱动本机真 Edge：填字、发送、抓回复、凭据注入 |
| `edge-driver-scripts.js` | 注入页面里的原生 DOM 脚本（逐字提取自上游，未改写） |
| `login-cookie-probe.js` | 直读 Edge profile 的 cookie 判登录态（零依赖，不起浏览器） |
| `credential-store.js` | 统一 Token/Cookie 凭据文件（手机+电脑共用一份） |
| `session-gc.js` | 会话惰性回收账本（N 分钟后删 / 攒够 M 个删） |

## 依赖

- **Node.js** `^22.18.0 || >=24.11.0`
  （`credential-store.js` / `login-cookie-probe.js` 用内置 `node:sqlite`，**无需任何 npm 依赖**）
- **Microsoft Edge**：Windows 默认路径会自动探测；也可在
  `config.json` 的 `edgeDriver.executable` 指定
- 无第三方运行时依赖

## ⚠️ 别和上游 dsh-webin 同时启用

两者都会注册同一批 LDW 模型路由（`webin-deepseek` / `webin-yuanbao` …），
同时开会撞车。**二选一**。

## 装完要做的

1. **重启 DSH**（host 半的改动必须重启才生效，热重载不一定覆盖）
2. 打开设置页的 LDW 分组，确认平台与登录态
3. 需要登录时：扫码登录一次，或者用凭据接口直接注入（见 README）

## 配置

插件配置在 `~/.dsh/webin/config.json`，`edgeDriver` 块常用项：

```json
{
  "edgeDriver": {
    "enabled": true,
    "hideWindow": true,
    "sessionDeleteMode": "delay",
    "sessionDeleteDelayMinutes": 30,
    "sessionDeleteMaxSessions": 20
  }
}
```

`sessionDeleteMode` 可取 `never` / `immediate` / `delay` / `count`；
留空则回落到旧的布尔 `autoDeleteSessions`（**老配置行为完全不变**）。
