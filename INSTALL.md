# 手动安装（`install.ps1` 不适用时）

`install.ps1` 能自动打补丁，但它靠「锚点字符串」定位。如果你的 `dsh-webin`
版本跟 0.2.23 差得多、锚点对不上，就按本文手动改。

**一共只改 4 处，`lib/index.js` 原有逻辑一行不动。**

---

## 0. 放文件

```
<插件目录>/lib/edge-driver.js           ← 新增
<插件目录>/lib/edge-driver-scripts.js   ← 新增
```

---

## 1. 加 import

文件顶部（`import { homedir } from "node:os";` 那一片的末尾）加一行：

```js
import { EdgeDriver, EDGE_DRIVER_DEFAULTS } from "./edge-driver.js";
```

---

## 2. `checkConfig()` 里加归一化

找到 `return { ok: problems.length === 0, config: out, problems };`
（在 `checkConfig` 函数末尾），在它**之前**插一行：

```js
out.edgeDriver = normalizeEdgeDriverConfig(src.edgeDriver, problems);
```

然后把这个函数贴到 `checkConfig` 后面：

```js
function normalizeEdgeDriverConfig(raw, problems) {
    const out = { ...EDGE_DRIVER_DEFAULTS };
    if (raw === void 0 || raw === null) return out;
    if (typeof raw !== "object") {
        problems.push({ field: "edgeDriver", reason: `应为对象，收到 ${typeof raw}`, fellBackTo: "默认值" });
        return out;
    }
    for (const key of Object.keys(EDGE_DRIVER_DEFAULTS)) {
        const value = raw[key];
        if (value === void 0) continue;
        const fallback = EDGE_DRIVER_DEFAULTS[key];
        if (typeof fallback === "boolean") {
            if (typeof value === "boolean") out[key] = value;
            else problems.push({ field: `edgeDriver.${key}`, reason: `应为布尔，收到 ${typeof value}`, fellBackTo: fallback });
            continue;
        }
        if (typeof fallback === "string") {
            if (typeof value === "string") out[key] = value;
            else problems.push({ field: `edgeDriver.${key}`, reason: `应为字符串，收到 ${typeof value}`, fellBackTo: fallback });
            continue;
        }
        const num = typeof value === "number" ? value : Number(value);
        if (!Number.isFinite(num) || num < 0) {
            problems.push({ field: `edgeDriver.${key}`, reason: `不是有效非负数字`, fellBackTo: fallback });
            continue;
        }
        out[key] = Math.round(num);
    }
    if (out.port < 1024 || out.port > 65535) {
        problems.push({ field: "edgeDriver.port", reason: `${out.port} 不是合法端口`, fellBackTo: EDGE_DRIVER_DEFAULTS.port });
        out.port = EDGE_DRIVER_DEFAULTS.port;
    }
    if (out.sendDelayMinMs > out.sendDelayMaxMs) {
        const t = out.sendDelayMinMs;
        out.sendDelayMinMs = out.sendDelayMaxMs;
        out.sendDelayMaxMs = t;
    }
    return out;
}
```

---

## 3. `apply()` 里建实例 + 领活循环

找到 `const adapter = createAdapter({` 那一行，在它**之前**插入整段
（约 120 行）：

```js
const edgeDriver = new EdgeDriver({
    config: { ...EDGE_DRIVER_DEFAULTS, ...readConfig().config.edgeDriver ?? {} },
    log,
    getProvider: (id) => registry.get(id),
});
edgeDriver.platformId = DEFAULT_PROVIDER_ID;

/** 驱动器自己发心跳 —— 否则看门狗会认为「面板失联」误杀长任务。 */
const EDGE_DRIVER_CLIENT_ID = "edge-driver";
ctx.effect(() => {
    const beat = () => {
        if (edgeDriver.proc === null) return;
        beats.set(EDGE_DRIVER_CLIENT_ID, {
            clientId: EDGE_DRIVER_CLIENT_ID,
            platform: edgeDriver.platformId,
            at: Date.now(),
            loggedIn: edgeDriver.lastProbeLoggedIn === true,
            hasGuest: true,
            replyCount: edgeDriver.stats.done,
        });
    };
    beat();
    const timer = setInterval(beat, 5e3);
    return () => { clearInterval(timer); beats.delete(EDGE_DRIVER_CLIENT_ID); };
}, "dsh-webin: edge-driver heartbeat");

/** 领活循环。队列空时**完全不碰 Edge**（省内存）。 */
ctx.effect(() => {
    if (edgeDriver.config.enabled !== true) {
        log.info?.("edge-driver 未启用（edgeDriver.enabled = false）");
        return;
    }
    const tick = async () => {
        if (edgeDriver.busy === true || edgeDriver.stopping === true) return;
        try {
            // 多平台：从队列读出真正待领的平台，逐个处理（串行）
            const pendingPlatforms = [...new Set(
                queue.inspect().filter((j) => j.state === "pending").map((j) => j.platform).filter(Boolean)
            )];
            if (pendingPlatforms.length === 0) return;

            for (const platformId of pendingPlatforms) {
                if (edgeDriver.busy === true || edgeDriver.stopping === true) break;
                if (!queue.inspect().some((j) => j.state === "pending" && j.platform === platformId)) continue;

                try {
                    await edgeDriver.ensureEdge(platformId);
                } catch (e) {
                    log.warn?.(`edge-driver 平台 ${platformId} 起不来: ${String(e?.message ?? e)}`);
                    continue;
                }

                const job = queue.claimNext(platformId, void 0);
                if (job === void 0) continue;
                edgeDriver.busy = true;
                edgeDriver.pending = { jobId: job.id, startedAt: Date.now() };
                edgeDriver.stats.claimed++;
                log.info?.(`edge-driver 领到任务 ${job.id}（平台 ${platformId}）`);
                try {
                    const provider = registry.get(job.platform ?? platformId);
                    const r = await edgeDriver.runJob(job, provider);
                    edgeDriver.lastProbeLoggedIn = true;
                    queue.settle(job.id, {
                        text: r.text, think: r.think, status: r.status,
                        ...r.chatUrl === "" ? {} : { chatUrl: r.chatUrl }
                    });
                    edgeDriver.stats.done++;
                    log.info?.(`edge-driver 任务 ${job.id} 完成（${r.text.length} 字符，via ${r.via}）`);
                    // 顺手写登录态快照（host 靠它判断「登录过」）
                    try {
                        const snap = await edgeDriver.snapshot();
                        if (typeof snap === "string" && snap.trim() !== "" && snap.trim() !== "{}") {
                            await writeAtomic(snapshotPath(job.platform ?? platformId), snap);
                        }
                    } catch (e) {
                        log.debug?.(`edge-driver 写快照失败（不影响本轮）: ${String(e?.message ?? e)}`);
                    }
                } catch (e) {
                    edgeDriver.stats.failed++;
                    const msg = String(e?.message ?? e);
                    log.warn?.(`edge-driver 任务 ${job.id} 失败: ${msg}`);
                    queue.settle(job.id, { error: msg });
                } finally {
                    edgeDriver.busy = false;
                    edgeDriver.pending = null;
                    edgeDriver.lastJobAt = Date.now();
                    const gap = 800 + Math.floor(Math.random() * 1200);
                    await new Promise((r) => setTimeout(r, gap));
                }
            }
            edgeDriver.touchIdle();
        } catch (e) {
            if (edgeDriver.config.verboseLog) log.debug?.(`edge-driver 循环异常: ${String(e?.message ?? e)}`);
        }
    };
    const timer = setInterval(() => void tick(), Math.max(500, edgeDriver.config.pollIntervalMs));
    void tick();
    return () => {
        clearInterval(timer);
        edgeDriver.stopLoop();
        void edgeDriver.shutdownEdge("插件卸载");
    };
}, "dsh-webin: edge-driver loop");
```

---

## 4. `/status` 里暴露状态

找到：

```js
if (method === "GET" && pathname === `${API_PREFIX}/status`) {
    const clients = liveClients();
    sendJson(res, 200, {
        ok: true,
        plugin: name,
```

在 `plugin: name,` 后面加一行：

```js
        edgeDriver: edgeDriver.status(),
```

---

## 5. 配置

`<DSH_HOME>/webin/config.json` 加 `edgeDriver` 块（见 README 的「配置」节）。

---

## 6. 重启 DSH

改完必须重启（或插件热重载）才生效。

**验证：**

```powershell
Invoke-RestMethod http://127.0.0.1:3080/dsh-webin/api/status |
    Select-Object -ExpandProperty edgeDriver | ConvertTo-Json
```

看到 `enabled: true` / `running: false` 就对了（`running: false` 表示
「平时不跑」，正是你要的省内存状态）。
