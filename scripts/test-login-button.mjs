// 真实导出组件 + 有依赖/cleanup 的假 hooks + 假时钟，不联网，不改写组件源码。
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function mount({ tabs = false } = {}) {
  let now = 0, id = 0, cursor = 0, dirty = false, mounted = true, exported, tree;
  const timers = new Map(), frames = new Map(), hooks = [], pending = [], requests = [], observers = [];
  const stats = { queries: 0, writesAfterUnmount: 0, settingsClicks: 0 };
  const timer = (fn, delay, repeat = false) => { const key = ++id; timers.set(key, { fn, at: now + delay, delay, repeat }); return key; };
  const react = {
    Component: class {},
    createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }),
    useState(initial) {
      const i = cursor++;
      if (!hooks[i]) hooks[i] = { value: typeof initial === 'function' ? initial() : initial };
      return [hooks[i].value, value => {
        if (!mounted) { stats.writesAfterUnmount++; return; }
        const next = typeof value === 'function' ? value(hooks[i].value) : value;
        if (!Object.is(next, hooks[i].value)) { hooks[i].value = next; dirty = true; }
      }];
    },
    useRef(value) { const i = cursor++; return hooks[i] ??= { current: value }; },
    useEffect(fn, deps) {
      const i = cursor++, old = hooks[i];
      if (!old || deps.some((dep, index) => !Object.is(dep, old.deps[index]))) {
        hooks[i] = { deps, cleanup: old?.cleanup };
        pending.push(() => { hooks[i].cleanup?.(); hooks[i].cleanup = fn(); });
      }
    },
  };
  const document = {
    body: {},
    querySelector(selector) {
      if (selector === '[data-conversation-tabs]') { stats.queries++; return tabs ? {} : null; }
      if (selector === '[data-shortcut-modal="settings"]') return { querySelectorAll: () => [{ textContent: 'LDW 网页版', click: () => stats.settingsClicks++ }] };
      return null;
    },
  };
  const window = {
    __ModuleLoader__: { load: mod => { exported = mod; } },
    setTimeout: (fn, delay) => timer(fn, delay), clearTimeout: key => timers.delete(key),
    setInterval: (fn, delay) => timer(fn, delay, true), clearInterval: key => timers.delete(key),
    requestAnimationFrame: fn => { const key = ++id; frames.set(key, fn); return key; },
    cancelAnimationFrame: key => frames.delete(key),
  };
  const sandbox = {
    console, URL, document, window, AbortController,
    requestAnimationFrame: window.requestAnimationFrame,
    MutationObserver: class {
      constructor(fn) { this.fn = fn; observers.push(this); }
      observe(target, options) { assert.equal(target, document.body); assert.equal(options.subtree, true); this.connected = true; }
      disconnect() { this.connected = false; }
    },
    fetch(url, options) { const req = { ...deferred(), url, signal: options.signal }; requests.push(req); return req.promise; },
  };
  vm.runInNewContext(source, sandbox, { filename: 'lib/client.js' });
  const api = exported.factory(name => { assert.equal(name, 'react'); return react; });
  function render() {
    do { dirty = false; cursor = 0; tree = api.LdwLoginButton(); while (pending.length) pending.shift()(); } while (dirty);
    return tree;
  }
  render();
  return {
    requests, stats, timers, frames, observers,
    get tree() { return tree; },
    async flush() { for (let i = 0; i < 10; i++) await Promise.resolve(); if (mounted && dirty) render(); },
    tick(ms) {
      const end = now + ms;
      while (true) {
        const next = [...timers].filter(([, t]) => t.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        const [key, t] = next; now = t.at;
        if (t.repeat) t.at += t.delay; else timers.delete(key);
        t.fn();
      }
      now = end;
    },
    mutate(count = 1) { for (let i = 0; i < count; i++) for (const o of observers) if (o.connected) o.fn([]); },
    frame() { const callbacks = [...frames.values()]; frames.clear(); callbacks.forEach(fn => fn()); if (dirty) render(); },
    setTabs(value) { tabs = value; this.mutate(); this.frame(); },
    unmount() { mounted = false; hooks.forEach(h => h.cleanup?.()); },
  };
}

// Abort 被忽略且 promise 永不 settle：无论经过多少周期，都只能存在一条请求。
{
  const h = mount();
  assert.equal(h.requests.length, 1);
  assert.match(h.requests[0].url, /\/status$/);
  h.tick(7999); assert.equal(h.requests[0].signal.aborted, false);
  h.tick(1); assert.equal(h.requests[0].signal.aborted, true);
  h.tick(120000); assert.equal(h.requests.length, 1);
  h.setTabs(true); assert.equal(h.tree, null); assert.equal(h.timers.size, 0);
  h.setTabs(false); h.tick(30000); assert.equal(h.requests.length, 1, '跨隐藏/显示也不能积累未 settle 请求');
  h.requests[0].resolve({ json: async () => ({ loggedInPlatforms: ['late'] }) });
  await h.flush(); assert.equal(h.tree, null, '过期成功结果不更新状态');
  h.tick(5000); assert.equal(h.requests.length, 2, 'settle 后才恢复请求');
  h.unmount(); assert.equal(h.requests[1].signal.aborted, true); assert.equal(h.timers.size, 0);
}
// JSON body 未完成也占用 in-flight；卸载后迟到结果不能写状态。
{
  const h = mount(), body = deferred();
  h.requests[0].resolve({ json: () => body.promise }); await h.flush();
  h.tick(5000); assert.equal(h.requests.length, 1);
  h.unmount(); assert.equal(h.requests[0].signal.aborted, true);
  body.resolve({ loggedInPlatforms: ['deepseek'] }); await h.flush();
  assert.equal(h.stats.writesAfterUnmount, 0); assert.equal(h.timers.size, 0);
}
// 初始有 tabs 不发请求；动态隐藏取消现有请求与轮询，移除 tabs 后恢复。
{
  const h = mount({ tabs: true }); h.tick(60000);
  assert.equal(h.requests.length, 0); assert.equal(h.timers.size, 0); assert.equal(h.tree, null);
  h.setTabs(false); assert.equal(h.requests.length, 1);
  h.setTabs(true); assert.equal(h.requests[0].signal.aborted, true);
  h.requests[0].reject(new Error('aborted')); await h.flush();
  h.tick(60000); assert.equal(h.requests.length, 1); assert.equal(h.timers.size, 0);
  h.setTabs(false); assert.equal(h.requests.length, 2); h.unmount();
}
// 一帧内上千次 body mutation 只安排一次查询；cleanup 取消已排帧。
{
  const h = mount({ tabs: true }), initial = h.stats.queries;
  h.mutate(1000); assert.equal(h.frames.size, 1); assert.equal(h.stats.queries, initial);
  h.frame(); assert.equal(h.stats.queries, initial + 1);
  h.mutate(1000); h.frame(); assert.equal(h.stats.queries, initial + 2);
  h.mutate(); h.unmount(); assert.equal(h.frames.size, 0); assert.equal(h.observers[0].connected, false);
  h.mutate(); h.frame(); assert.equal(h.stats.queries, initial + 2);
}
// 正常状态文案、非 submit 按钮及进入设置的点击语义保持。
{
  const h = mount();
  h.requests[0].resolve({ json: async () => ({ loggedInPlatforms: [], clients: { online: 1 } }) }); await h.flush();
  assert.equal(h.tree.type, 'button'); assert.equal(h.tree.props.type, 'button');
  assert.equal(h.tree.children[1].children[0], 'LDW 登录');
  h.tree.props.onClick(); await h.flush(); assert.equal(h.stats.settingsClicks, 1);
  h.tick(5000); h.requests[1].resolve({ json: async () => ({ loggedInPlatforms: ['deepseek'] }) }); await h.flush();
  assert.equal(h.tree.children[1].children[0], 'LDW 已登录'); assert.equal(h.tree.children[0].props.className, 'ldw-dot ok');
  h.tick(5000); h.requests[2].reject(new Error('offline')); await h.flush();
  assert.equal(h.tree.children[1].children[0], 'LDW 未就绪'); h.unmount();
}
console.log('PASS: LdwLoginButton 未 settle 不积累、超时/卸载 abort、隐藏无 poll、observer rAF 合并、正常按钮语义');
