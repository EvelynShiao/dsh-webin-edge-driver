/**
 * 账号槽位解析回归（2026-10-17 真机事故）
 *
 * 用户把槽位改名成 evelyn-xxx 之后，任何「没带账号」的 ensureEdge() 都会
 * 退回字面量 "default" —— 而改名后那个目录只剩一个子目录（空档案），
 * 浏览器起来停在 about:blank、消息发不出去。
 *
 * 这里只测纯函数，不启动浏览器。
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveAccountId } from '../lib/edge-driver.js';

test('不带账号时用配置里的生效槽位，而不是 default', () => {
  assert.equal(resolveAccountId({ configured: 'evelyn-doubao' }), 'evelyn-doubao');
});

test('调用方明确给的账号优先', () => {
  assert.equal(resolveAccountId({ explicit: 'work', configured: 'evelyn-doubao' }), 'work');
});

test('配置没有时用上次用过的', () => {
  assert.equal(resolveAccountId({ previous: 'evelyn-yuanbao' }), 'evelyn-yuanbao');
});

test('全都没有才退回 default（单账号旧行为）', () => {
  assert.equal(resolveAccountId({}), 'default');
  assert.equal(resolveAccountId({ explicit: '', configured: undefined, previous: null }), 'default');
});
