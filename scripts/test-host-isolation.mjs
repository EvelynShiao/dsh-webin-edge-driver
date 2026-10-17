// 真实 apply + 合成临时数据：不访问用户凭据，不启用浏览器，不起第二个服务。
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
const home = mkdtempSync(join(tmpdir(), 'webin-host-test-'));
process.env.DSH_HOME = home;
mkdirSync(join(home, 'webin'), { recursive: true });
writeFileSync(join(home, 'webin/config.json'), JSON.stringify({ edgeDriver: { enabled: false } }));
const rows = Number(process.env.TEST_COOKIE_ROWS ?? 0);
if (rows) {
  const { DatabaseSync } = await import('node:sqlite');
  for (const platform of ['deepseek', 'yuanbao', 'doubao']) {
    const dir = join(home, 'edge-ldw', platform, 'Default/Network');
    mkdirSync(dir, { recursive: true });
    const db = new DatabaseSync(join(dir, 'Cookies'));
    db.exec('CREATE TABLE cookies(host_key TEXT, name TEXT, encrypted_value BLOB); BEGIN');
    const insert = db.prepare('INSERT INTO cookies VALUES(?,?,zeroblob(32))');
    for (let i = 0; i < rows; i++) insert.run('example.invalid', 'synthetic_' + i);
    if (platform === 'deepseek') insert.run('.deepseek.com', 'ds_session_id');
    db.exec('COMMIT'); db.close();
  }
}
const { apply } = await import('../lib/index.js');
const cleanups = [], taps = [], adapters = new Map(), routes = [];
const noop = () => {};
const ctx = {
  logger: { info: noop, warn: noop, debug: noop, error: noop },
  effect(fn) { const d = fn(); if (typeof d === 'function') cleanups.push(d); return d; },
  llm: { registerAdapter(names, adapter) { names.forEach(n => adapters.set(n, adapter)); return () => names.forEach(n => adapters.delete(n)); } },
  webServer: { register(route) { routes.push(route); return noop; }, tapIndex(tap) { taps.push(tap); return noop; } },
};
try {
  await apply(ctx);
  assert.equal(routes.length, 1);
  assert.equal(routes[0].path, '/dsh-webin/api');
  async function measure(label, fn) {
    const start = performance.now();
    let delay;
    const timer = new Promise(resolve => setTimeout(() => { delay = performance.now() - start; resolve(); }, 0));
    const pending = fn();
    const synchronousMs = performance.now() - start;
    await pending; await timer;
    console.log(JSON.stringify({ label, rowsPerPlatform: rows, synchronousMs, timerDelayMs: delay }));
  }
  const request = (path, method = 'GET', payload) => {
    let status, body;
    const req = Readable.from(payload === undefined ? [] : [Buffer.from(JSON.stringify(payload))]);
    req.method = method; req.url = '/dsh-webin/api/' + path;
    return Promise.resolve(routes[0].handler(req, {
      writeHead(code) { status = code; }, setHeader: noop, end(value) { body = value; },
    })).then(() => { assert.equal(status, 200); return JSON.parse(body); });
  };
  await measure('status cold', async () => {
    /**
     * 热路径是**非阻塞**的（peek）：它不会等探测，而是先返回上次结果、
     * 后台刷新。所以这里先显式把探测跑完，再断言状态接口能如实反映。
     */
    if (rows > 0) {
      const { waitForCookieProbe } = await import('../lib/login-cookie-probe.js');
      await waitForCookieProbe('deepseek', join(home, 'edge-ldw', 'deepseek'));
    }
    let status = await request('status');
    for (let i = 0; i < 20 && !status.loggedInPlatforms.includes('deepseek') && rows > 0; i++) {
      await new Promise(r => setTimeout(r, 100));
      status = await request('status');
    }
    assert.equal(status.loggedInPlatforms.includes('deepseek'), rows > 0, '探测完成后状态接口必须报告已登录');
  });
  const accounts = await request('accounts');
  assert.equal(accounts.platforms.find(p => p.platform === 'deepseek').slotStatus[0].loggedIn, rows > 0);
  assert.equal((await adapters.get('webin-deepseek').listModels('webin-deepseek')).length > 0, rows > 0, 'cookie登录必须列出可用模型');
  await measure('status warm', () => request('status'));
  for (const [route, adapter] of adapters) await measure('listModels ' + route, () => adapter.listModels(route));
  await request('accounts', 'PUT', { platform: 'deepseek', slots: ['default', '测试账号'], active: '测试账号' });
  const configured = (await request('accounts')).platforms.find(p => p.platform === 'deepseek');
  assert.equal(configured.active, '测试账号');
  assert.ok(configured.slots.includes('测试账号'));
  assert.equal((await adapters.get('webin-deepseek').listModels('webin-deepseek')).length > 0, rows > 0, '切到未登录账号不能隐藏其他已登录账号模型');
  const denied = [];
  for await (const event of adapters.get('webin-deepseek').stream({ provider: 'webin-deepseek', model: 'deepseek@测试账号', messages: [], signal: new AbortController().signal })) denied.push(event);
  assert.ok(denied.some(event => event.reason?.failure?.code === 'WEBIN_NOT_LOGGED_IN'), '未登录目标账号必须被拒绝，不能借其他账号的登录态放行');
  await request('accounts', 'PUT', { platform: 'deepseek', slots: ['default', '测试账号'], active: 'default', hiddenInModels: ['default'] });
  assert.equal((await adapters.get('webin-deepseek').listModels('webin-deepseek')).length, 0, '隐藏模型应生效');
  await request('accounts', 'PUT', { platform: 'deepseek', slots: ['default'], active: 'default', hiddenInModels: [] });
  assert.equal((await adapters.get('webin-deepseek').listModels('webin-deepseek')).length > 0, rows > 0, '恢复模型应生效');
  if (rows) {
    const adapter = adapters.get('webin-deepseek');
    const models = await adapter.listModels('webin-deepseek');
    async function syntheticTurn(sessionId, text) {
      const events = [];
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      const completion = (async () => {
        for await (const event of adapter.stream({ provider: 'webin-deepseek', model: models[0].id, sessionId,
          messages: [{ role: 'user', content: text }], signal: controller.signal })) events.push(event);
      })();
      try {
        let job;
        for (let i = 0; i < 100; i++) {
          job = (await request('job/next?platform=deepseek&session=' + sessionId)).job;
          if (job) break;
          await new Promise(resolve => setTimeout(resolve, 10));
        }
        assert.ok(job, '已登录发送应进入任务队列');
        assert.equal(job.sessionId, sessionId);
        assert.equal(job.freshChat, true, '新会话必须要求新网页对话');
        assert.equal((await request('job/next?platform=deepseek&session=other')).job, null);
        await request('job/' + job.id + '/result', 'PUT', { text: '合成回复', chatUrl: 'https://chat.deepseek.com/a/chat/synthetic-' + sessionId });
        await completion;
        assert.ok(events.some(event => event.type === 'finish' && event.reason?.kind === 'stop'));
        return job.id;
      } finally { clearTimeout(timeout); controller.abort(); await completion; }
    }
    const a = await syntheticTurn('synthetic-session-a', '测试消息甲');
    const b = await syntheticTurn('synthetic-session-b', '测试消息乙');
    assert.notEqual(a, b);
    console.log('PASS: 合成发送入队/领取/回复结算与两新会话隔离（未调用真实模型）');
  }
  console.log('PASS: 账号新增/切换/持久化与模型隐藏/恢复（隔离真实handler）');
  console.log(JSON.stringify({ indexInjectionCount: taps.length, adapterRoutes: [...adapters.keys()] }));
  assert.equal(taps.length, 0, '插件不得注入整页自动刷新脚本');
} finally {
  for (const dispose of cleanups.reverse()) await dispose();
  console.log('合成夹具保留用于复查：' + home);
}
