/**
 * 启动失败退避（纯逻辑，便于测试）
 * ================================
 *
 * ## 为什么必须有
 *
 * 2026-10-17 在独立实例上实测：浏览器起不来（CDP 连不上）时，领活循环
 * **每 1.5 秒**就重新 `spawn` 一次，40 秒内拉起了 **27 个 Chrome 进程**，
 * 主线程被拖到接近满核、端口能连上但不回响应。
 *
 * 在手机上这足以造成「插件一启用，整个 DSH 界面失灵」——几十个 Chromium
 * 子进程同时抢内存和 CPU。
 *
 * ## 策略
 *
 *   - 每个「平台#槽位」独立计数，互不牵连；
 *   - 失败后按 5s → 15s → 45s → 120s 退避，成功一次立刻清零；
 *   - 连续失败达到上限就**放弃并让调用方把待领任务判失败**，
 *     给出可读原因，而不是让界面干等 claimGrace 超时。
 */
export const LAUNCH_BACKOFF_MS = [5_000, 15_000, 45_000, 120_000];
export const LAUNCH_MAX_ATTEMPTS = 3;

export function createLaunchBackoff({ delays = LAUNCH_BACKOFF_MS, maxAttempts = LAUNCH_MAX_ATTEMPTS, now = Date.now } = {}) {
  const failures = new Map();
  const keyOf = (platformId, account) => `${platformId}#${account ?? "default"}`;

  return {
    /** 现在允许尝试吗？ */
    ready(platformId, account) {
      const state = failures.get(keyOf(platformId, account));
      return state === undefined || state.count === 0 || now() >= state.nextAt;
    },
    /** 记录一次失败，返回 { count, retryInMs, giveUp }。 */
    fail(platformId, account) {
      const key = keyOf(platformId, account);
      const count = (failures.get(key)?.count ?? 0) + 1;
      const delay = delays[Math.min(count - 1, delays.length - 1)];
      const giveUp = count >= maxAttempts;
      // 放弃后也留一个很长的冷却，避免「下一条任务」立刻又去撞同一堵墙。
      const wait = giveUp ? delays[delays.length - 1] : delay;
      failures.set(key, { count, nextAt: now() + wait });
      return { count, retryInMs: wait, giveUp };
    },
    /** 成功一次就清零。 */
    ok(platformId, account) {
      failures.delete(keyOf(platformId, account));
    },
    /** 诊断/测试用。 */
    state(platformId, account) {
      const state = failures.get(keyOf(platformId, account));
      return state === undefined ? { count: 0, nextAt: 0 } : { ...state };
    },
    /**
     * 快照：给 `/status` 用，让用户能看见「浏览器起不来，已重试几次」，
     * 而不是只看到界面一直转圈。
     */
    snapshot() {
      return [...failures.entries()].map(([key, state]) => ({
        target: key,
        failures: state.count,
        retryInMs: Math.max(0, state.nextAt - now()),
      }));
    },
    clear() { failures.clear(); },
  };
}
