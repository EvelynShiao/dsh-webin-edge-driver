import assert from "node:assert/strict";
import { test } from "node:test";
import { createLaunchBackoff, LAUNCH_BACKOFF_MS, LAUNCH_MAX_ATTEMPTS } from "../lib/launch-backoff.js";

test("失败后必须退避，成功清零，不同账号互不影响", () => {
  let clock = 1_000;
  const backoff = createLaunchBackoff({ now: () => clock });

  // 第一次就允许（没有历史失败）
  assert.equal(backoff.ready("deepseek", "default"), true);

  const first = backoff.fail("deepseek", "default");
  assert.deepEqual({ count: first.count, giveUp: first.giveUp }, { count: 1, giveUp: false });
  assert.equal(first.retryInMs, LAUNCH_BACKOFF_MS[0]);
  // 退避期内不再重启 —— 这正是「40 秒拉起 27 个 Chrome」的修复点
  assert.equal(backoff.ready("deepseek", "default"), false);
  clock += LAUNCH_BACKOFF_MS[0] - 1;
  assert.equal(backoff.ready("deepseek", "default"), false);
  clock += 1;
  assert.equal(backoff.ready("deepseek", "default"), true);

  // 另一个槽位不受牵连
  assert.equal(backoff.ready("deepseek", "工作号"), true);
  // 另一个平台也不受影响
  assert.equal(backoff.ready("yuanbao", "default"), true);

  // 退避时间递增
  const second = backoff.fail("deepseek", "default");
  assert.equal(second.retryInMs, LAUNCH_BACKOFF_MS[1]);
  const third = backoff.fail("deepseek", "default");
  assert.equal(third.count, LAUNCH_MAX_ATTEMPTS);
  assert.equal(third.giveUp, true, "连续失败到上限必须放弃，让界面拿到明确错误");

  // 成功一次立刻清零
  backoff.ok("deepseek", "default");
  assert.deepEqual(backoff.state("deepseek", "default"), { count: 0, nextAt: 0 });
  assert.equal(backoff.ready("deepseek", "default"), true);
});

test("放弃后仍有长冷却，避免下一条任务立刻再撞墙", () => {
  let clock = 0;
  const backoff = createLaunchBackoff({ now: () => clock });
  for (let i = 0; i < LAUNCH_MAX_ATTEMPTS; i++) backoff.fail("doubao", "default");
  assert.equal(backoff.ready("doubao", "default"), false);
  clock += LAUNCH_BACKOFF_MS[LAUNCH_BACKOFF_MS.length - 1] - 1;
  assert.equal(backoff.ready("doubao", "default"), false);
  clock += 1;
  assert.equal(backoff.ready("doubao", "default"), true);
});

test("在 60 秒窗口内，退避把尝试次数从 27 次压到个位数", () => {
  // 模拟领活循环 1.5s 一次；浏览器每次都起不来。
  let clock = 0;
  const backoff = createLaunchBackoff({ now: () => clock });
  let attempts = 0;
  const tickMs = 1_500;
  const horizonMs = 60_000;
  for (; clock < horizonMs; clock += tickMs) {
    if (!backoff.ready("deepseek", "default")) continue;
    attempts++;
    backoff.fail("deepseek", "default");
  }
  assert.ok(attempts <= 3, `60 秒内尝试了 ${attempts} 次，退避失效`);
  assert.ok(attempts >= 1);
});
