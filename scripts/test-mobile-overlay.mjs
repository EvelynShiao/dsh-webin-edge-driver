// 隔离回归：执行真实组件渲染体，再由 Chromium 验证 CSS 点击命中。
// 不连接 DSH、不读取真实账号、不发网络请求；不模拟 React effect 生命周期。
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import { chromium } from 'playwright';
import { resolve } from 'node:path';
const source = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
let mod;
const noop = () => {};
const react = {
  Component: class {},
  createElement: (type, props, ...children) => typeof type === 'function' ? type(props ?? {}) : ({ type, props: props ?? {}, children }),
  useRef: value => ({ current: value }),
  useState: value => [typeof value === 'function' ? value() : value, noop],
  useMemo: fn => fn(), useCallback: fn => fn,
  useEffect: noop, useLayoutEffect: noop,
};
const sandbox = { console, URL, window: { __ModuleLoader__: { load: m => { mod = m; } } }, document: {}, setTimeout, clearTimeout };
sandbox.globalThis = sandbox;
vm.runInNewContext(source.replace('exports.LdwHost = LdwHost;', 'exports.LdwHost = LdwHost; exports.testPublishRect = publishRect; exports.testCss = CSS;'), sandbox);
const api = mod.factory(name => { assert.equal(name, 'react'); return react; });
api.testPublishRect({ left: 0, top: 0, width: 390, height: 844, visible: true });
const mobileTree = (api.LdwHostSlot ?? api.LdwHost)();
// 只将真实 host 的外层盒子放到真实 DOM；这已足够检验空白背景能否截获点击。
const browser = await chromium.launch({ executablePath: process.env.WEBIN_TEST_CHROME ?? resolve('scripts/chrome-test-launcher.sh'), headless: true });
try {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  await page.route('**/*', route => route.abort());
  await page.setContent('<style>.overlay{position:absolute;inset:0;z-index:20;pointer-events:none}.overlay>*{pointer-events:auto}button{position:absolute;top:100px;left:20px;width:120px;height:40px}</style><button id="under">新会话</button><div class="overlay"></div>');
  await page.addStyleTag({ content: api.testCss });
  const result = await page.evaluate(tree => {
    window.clicks = 0;
    document.querySelector('#under').onclick = () => window.clicks++;
    if (tree) {
      const node = document.createElement(tree.type);
      node.className = tree.props.className;
      Object.assign(node.style, tree.props.style);
      document.querySelector('.overlay').append(node);
    }
    return { hit: document.elementFromPoint(60, 120)?.className || document.elementFromPoint(60, 120)?.id, hostCount: document.querySelectorAll('.webin-host').length };
  }, mobileTree ? { type: mobileTree.type, props: { className: mobileTree.props.className, style: mobileTree.props.style } } : null);
  await page.mouse.click(60, 120);
  const clicks = await page.evaluate(() => window.clicks);
  console.log(JSON.stringify({ ...result, clicks }));
  assert.equal(clicks, 1, '无桌面 bridge 时不应由不可用的 LDW host 吞掉底层点击');
  assert.equal(result.hostCount, 0, '无桌面 bridge 不应挂载 fixed host');
  // 缺字段或协议不兼容也不能挂载不可用的覆盖层。
  for (const bridge of [{}, { protocolVersion: 2, browser: { acquire: noop } }, { protocolVersion: 1, browser: {} }]) {
    sandbox.dshDesktop = bridge;
    assert.equal(api.LdwHostSlot(), null);
  }
  // 桌面保留原有组件，不要求在测试中启动真实 guest。
  sandbox.dshDesktop = { protocolVersion: 1, browser: { acquire: noop } };
  const desktopTree = (api.LdwHostSlot ?? api.LdwHost)();
  assert.equal(desktopTree.props.className, 'webin-host');
  console.log('PASS: 手机点击穿透，桌面 host 保留');
} finally { await browser.close(); }
