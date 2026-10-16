/**
 * 渲染冒烟测试 —— 在 Node 里把 client.js 的组件**真的渲染一遍**。
 *
 * ## 为什么需要它（2026-10-16 的教训）
 *
 * 用户报「LDW 的 UI 完全打不开」：`node --check` 全过、`verify-package.mjs` 全过、
 * host 半 `/status` 在线 —— 但设置页一片空白。
 *
 * 根因：`LdwAccountsSection` 的**渲染体**引用了 `apiDiag`，而
 * `const [apiDiag, setApiDiag] = useState("")` 被改文件的脚本插进了**隔壁**
 * 的 `LdwEngineSection`（两个函数开头都有 `busy`/`note` 状态，锚点撞车）。
 * 语法完全没问题 —— 是**运行时 ReferenceError**，只有真的渲染一次才会炸。
 *
 * ## 它怎么做的
 *
 * 1. 造一个假的 `window.__ModuleLoader__.load`，把 factory 接住；
 * 2. 给 factory 一个**假 react**：useState/useMemo/useRef/useEffect 都有实现，
 *    而 `createElement(type)` 遇到**函数组件会立刻递归调用** —— 于是每个组件的
 *    渲染体都被真正执行了一次；
 * 3. 把模块导出的所有 `Ldw*` 组件各渲染一遍（两种模式，见下）；
 * 4. 任何 ReferenceError / TypeError 都会被抓住，**打印 client.js 的真实行号**，
 *    最后非零退出。
 *
 * ⚠️ 关键实现细节：模块内部那份 `react` **只有一份**（`require("react")` 返回同一个
 * 对象），模式/统计挂在它身上。否则「填充」模式作用不到组件内部 ——
 * 测试会**假装通过**（第一版就踩了这个坑）。
 *
 * ## 两种模式
 *
 * - **初始值**：useState 返回它自己的初始值 —— 最忠实（跟真浏览器一样）。
 *   但 `if (state === null) return 骨架屏` 这种早退会让后面的代码跑不到。
 * - **填充**：`useState(null)` 返回一个「自我返回代理」（任意属性返回它自己、
 *   `=== null` 为假、`.length` 为 0、可迭代但为空）—— 早退被绕开，
 *   **后面那大段渲染体也就被跑到了**，覆盖更广，代价是数据是假的。
 *
 * 还带一条**自检**：填充模式下 `LdwSettings` 必须真的渲染到
 * `LdwEngineSection` / `LdwAccountsSection` 两个区块，否则直接判 FAIL ——
 * 「测试没覆盖到东西」比「测试失败」更危险。
 *
 * ## 覆盖边界（重要）
 *
 * 只跑**渲染体**。`useEffect` 里的异步逻辑（fetch 等）不执行；真实 DOM 交互、
 * CSS、slot 注册顺序也不在范围内。它守的是「白屏」这一大类 ——
 * 也正是这次真正出事的那一类。
 *
 * 用法：
 *   node scripts/render-smoke.mjs                # 测 lib/client.js
 *   node scripts/render-smoke.mjs 别的文件.js    # 测指定文件（回归/对照用）
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = process.argv[2] === undefined
	? path.join(here, "..", "lib", "client.js")
	: path.resolve(process.argv[2]);

const source = readFileSync(target, "utf8");

/** 递归深度上限：防「组件渲染自己」这类真死循环。 */
const MAX_DEPTH = 60;
/** 填充模式下必须被渲染到的区块（自检用，防「测试假装通过」）。 */
const MUST_REACH = ["LdwEngineSection", "LdwAccountsSection"];

const noop = () => {};
const fakeNode = () => ({
	style: {},
	dataset: {},
	classList: { add: noop, remove: noop, toggle: noop, contains: () => false },
	children: [],
	childNodes: [],
	appendChild: noop,
	removeChild: noop,
	insertBefore: noop,
	remove: noop,
	setAttribute: noop,
	getAttribute: () => null,
	hasAttribute: () => false,
	addEventListener: noop,
	removeEventListener: noop,
	querySelector: () => null,
	querySelectorAll: () => [],
	getBoundingClientRect: () => ({ width: 0, height: 0, top: 0, left: 0, bottom: 0, right: 0 }),
	contains: () => false,
	click: noop,
	focus: noop,
	blur: noop,
	innerHTML: "",
	textContent: "",
	className: ""
});

/**
 * 「填充」模式用的自我返回代理。
 *
 * 目的：让 `if (x === null) return 骨架屏` 这类早退**不被触发**，
 * 从而把组件后半段的渲染体也跑到。
 * 刻意做了几处特判，免得它变成「假的 TypeError 制造机」：
 * 可调用（`.map()` 不炸）、可迭代但为空（`...x` / `for..of` 不炸）、
 * `length` 为 0、`Symbol.toPrimitive` 给空串、`then` 为 undefined（不当 thenable）。
 */
function makeFillProxy(label) {
	const proxy = new Proxy(function smokeFill() {}, {
		get(_t, key) {
			if (typeof key === "symbol") {
				switch (key.description) {
					case "Symbol.toPrimitive": return () => "";
					case "Symbol.iterator": return function* empty() {};
					case "Symbol.toStringTag": return "SmokeFill";
					case "nodejs.util.inspect.custom": return () => label;
					default: return proxy;
				}
			}
			if (key === "then") return void 0;
			if (key === "length") return 0;
			if (key === "toString" || key === "valueOf") return () => "";
			return proxy;
		},
		apply() { return proxy; },
		has() { return true; },
		set() { return true; }
	});
	return proxy;
}

/**
 * 假 react（**一份**，模式与统计挂在 runtime 上）。
 *
 * 关键点：`createElement` 遇到**函数组件就直接调用它** —— 这就是「渲染」。
 * 类组件（错误边界那种）走 `new` + `render()`。
 * hooks 全是无状态的（每次返回新值）—— 冒烟测试不需要跨渲染保持状态，
 * 只要「渲染体跑得通」。
 */
function makeFakeReact(runtime) {
	let depth = 0;
	const createElement = (type, props, ...children) => {
		const p = { ...(props ?? {}) };
		if (children.length === 1) p.children = children[0];
		else if (children.length > 1) p.children = children;
		if (typeof type !== "function") return { type, props: p };
		if (type.prototype !== void 0 && typeof type.prototype.render === "function") {
			const inst = new type(p);
			inst.props = p;
			inst.state = inst.state ?? {};
			inst.setState = (s) => {
				Object.assign(inst.state, typeof s === "function" ? s(inst.state) : s);
			};
			runtime.report.classes.push(type.name || "(匿名类组件)");
			return inst.render();
		}
		const label = type.name || "(匿名组件)";
		if (depth >= MAX_DEPTH) throw new Error(`组件递归超过 ${MAX_DEPTH} 层（疑似组件渲染自己）`);
		runtime.report.components.push(label);
		depth++;
		try { return type(p); } finally { depth--; }
	};
	const fromState = (init) => {
		const value = typeof init === "function" ? init() : init;
		if (runtime.mode === "fill" && value === null) return makeFillProxy("(fill)");
		return value;
	};
	return {
		createElement,
		Fragment: Symbol("Fragment"),
		StrictMode: ({ children }) => children ?? null,
		memo: (c) => c,
		forwardRef: (c) => c,
		useState: (init) => [fromState(init), noop],
		useReducer: (_reducer, init) => [fromState(init), noop],
		useRef: (init) => ({ current: runtime.mode === "fill" && init === null ? makeFillProxy("(fill-ref)") : init }),
		useMemo: (fn) => fn(),
		useCallback: (fn) => fn,
		useEffect: () => { runtime.report.effects++; },
		useLayoutEffect: () => { runtime.report.effects++; },
		useImperativeHandle: noop,
		useId: () => "smoke-id",
		useContext: (ctx) => (ctx !== null && typeof ctx === "object" && "__smokeDefault" in ctx ? ctx.__smokeDefault : {}),
		createContext: (d) => ({ __smokeDefault: d, Provider: ({ children }) => children ?? null, Consumer: () => null }),
		useSyncExternalStore: (_sub, get) => get(),
		useTransition: () => [false, noop],
		useDeferredValue: (v) => v,
		startTransition: (fn) => fn(),
		cloneElement: (elm) => elm,
		isValidElement: () => true,
		Children: { map: (c, f) => (Array.isArray(c) ? c.map(f) : []), toArray: (c) => (Array.isArray(c) ? c : []) }
	};
}

const documentStub = {
	createElement: fakeNode,
	createElementNS: fakeNode,
	createTextNode: () => ({ textContent: "" }),
	head: fakeNode(),
	body: fakeNode(),
	documentElement: fakeNode(),
	addEventListener: noop,
	removeEventListener: noop,
	querySelector: () => null,
	querySelectorAll: () => [],
	getElementById: () => null,
	getElementsByClassName: () => [],
	getElementsByTagName: () => [],
	title: "",
	readyState: "complete",
	visibilityState: "visible",
	cookie: "",
	hidden: false
};

const windowStub = {
	document: documentStub,
	location: { protocol: "http:", host: "127.0.0.1:3080", origin: "http://127.0.0.1:3080", href: "http://127.0.0.1:3080/", pathname: "/", search: "", hash: "" },
	navigator: { userAgent: "render-smoke", language: "zh-CN", languages: ["zh-CN"], platform: "Win32", cookieEnabled: true, clipboard: { writeText: async () => {} } },
	addEventListener: noop,
	removeEventListener: noop,
	dispatchEvent: () => true,
	open: () => null,
	close: noop,
	focus: noop,
	blur: noop,
	scrollTo: noop,
	innerWidth: 1280,
	innerHeight: 800,
	devicePixelRatio: 1,
	setTimeout: () => 0,
	clearTimeout: noop,
	setInterval: () => 0,
	clearInterval: noop,
	requestAnimationFrame: () => 0,
	cancelAnimationFrame: noop,
	matchMedia: () => ({ matches: false, addEventListener: noop, removeEventListener: noop, addListener: noop, removeListener: noop }),
	getComputedStyle: () => ({ getPropertyValue: () => "" }),
	localStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 },
	sessionStorage: { getItem: () => null, setItem: noop, removeItem: noop, clear: noop, key: () => null, length: 0 },
	fetch: () => Promise.reject(new Error("render-smoke：不发真请求")),
	console
};

/** 接住 `window.__ModuleLoader__.load({ id, factory })`。 */
let registered = null;
windowStub.__ModuleLoader__ = { load: (mod) => { registered = mod; } };

const sandbox = {
	window: windowStub,
	document: documentStub,
	navigator: windowStub.navigator,
	location: windowStub.location,
	localStorage: windowStub.localStorage,
	sessionStorage: windowStub.sessionStorage,
	fetch: windowStub.fetch,
	console,
	setTimeout: windowStub.setTimeout,
	clearTimeout: noop,
	setInterval: windowStub.setInterval,
	clearInterval: noop,
	requestAnimationFrame: noop,
	cancelAnimationFrame: noop,
	matchMedia: windowStub.matchMedia,
	getComputedStyle: windowStub.getComputedStyle,
	performance: { now: () => 0 },
	WebSocket: function WebSocketStub() {},
	MutationObserver: function MutationObserverStub() { return { observe: noop, disconnect: noop }; },
	ResizeObserver: function ResizeObserverStub() { return { observe: noop, disconnect: noop }; },
	IntersectionObserver: function IntersectionObserverStub() { return { observe: noop, disconnect: noop, unobserve: noop }; },
	URL: globalThis.URL,
	Blob: function BlobStub() {},
	CustomEvent: function CustomEventStub() {},
	Event: function EventStub() {}
};
sandbox.globalThis = sandbox;

/** 模块内部那份 react 只有一份 —— 模式与统计挂在 runtime 上，逐次切换。 */
const runtime = { mode: "init", report: { components: [], classes: [], effects: 0 } };
const fakeReact = makeFakeReact(runtime);

const failures = [];
const line = (s) => `  ${s}`;
const rel = path.relative(path.join(here, ".."), target);

console.log(`=== 渲染冒烟：${rel} ===`);

/** ① 装载模块（这一步就能抓「factory 里 import 的东西没解析到」）。 */
try {
	vm.runInContext(source, vm.createContext(sandbox), { filename: target, displayErrors: true });
} catch (error) {
	failures.push({ where: "装载模块（factory 执行）", error });
}
if (failures.length === 0 && registered === null) {
	failures.push({ where: "装载模块", error: new Error("没有调用 window.__ModuleLoader__.load —— 客户端模块不会注册") });
}

/** ② 造 exports。 */
let exportsObj = null;
if (failures.length === 0) {
	try {
		exportsObj = registered.factory((name) => {
			if (name === "react") return fakeReact;
			throw new Error(`render-smoke 没有为 "${name}" 准备假模块`);
		});
	} catch (error) {
		failures.push({ where: "factory(require) 执行", error });
	}
}

/** ③ 挑出所有导出的组件（`Ldw*` 且是函数）—— 自动发现，别硬编码。 */
const componentNames = exportsObj === null
	? []
	: Object.keys(exportsObj).filter((k) => /^Ldw[A-Z]/.test(k) && typeof exportsObj[k] === "function").sort();

if (failures.length === 0 && componentNames.length === 0) {
	failures.push({ where: "找组件", error: new Error("一个 Ldw* 组件都没导出（是不是忘了 exports.xxx = xxx？）") });
}

/** ④ 两种模式各渲染一遍。 */
const results = [];
if (failures.length === 0) {
	for (const mode of ["init", "fill"]) {
		for (const name of componentNames) {
			runtime.mode = mode;
			runtime.report = { components: [], classes: [], effects: 0 };
			try {
				fakeReact.createElement(exportsObj[name], {});
				results.push({ mode, name, ok: true, rendered: runtime.report.components });
			} catch (error) {
				results.push({ mode, name, ok: false, error, rendered: runtime.report.components });
				failures.push({ where: `${mode === "init" ? "初始值" : "填充"}模式 · ${name}`, error });
			}
		}
	}
}

for (const mode of ["init", "fill"]) {
	const rows = results.filter((r) => r.mode === mode);
	if (rows.length === 0) continue;
	console.log(`\n[${mode === "init" ? "模式 A · 初始值（忠实）" : "模式 B · 填充（覆盖广）"}]`);
	for (const r of rows) {
		if (!r.ok) {
			console.log(line(`✗ ${r.name} → ${r.error.name}: ${r.error.message}`));
			continue;
		}
		const nested = [...new Set(r.rendered.slice(1))];
		console.log(line(`✓ ${r.name}（渲染体 ${r.rendered.length} 次` +
			`${nested.length > 0 ? `：${nested.slice(0, 6).join(" → ")}${nested.length > 6 ? " …" : ""}` : ""}）`));
	}
}

/** ⑤ 自检：填充模式必须真的渲染到那两个区块，否则这个测试等于没测。 */
const fillSettings = results.find((r) => r.mode === "fill" && r.name === "LdwSettings");
if (failures.length === 0 && fillSettings !== void 0 && fillSettings.ok) {
	for (const must of MUST_REACH) {
		if (!fillSettings.rendered.includes(must)) {
			failures.push({
				where: "自检（覆盖率）",
				error: new Error(`填充模式下 LdwSettings 没有渲染到 ${must} —— 测试没覆盖到区块，等于没测`)
			});
		}
	}
}

console.log(`\n组件清单：${componentNames.join("、") || "（无）"}`);

if (failures.length > 0) {
	console.log("\n=== 失败详情 ===");
	for (const f of failures) {
		console.log(`\n✗ ${f.where}`);
		console.log(`  ${f.error.name}: ${f.error.message}`);
		/** 只挑 client.js 里的栈帧 —— 行号是最有用的信息。 */
		const frames = String(f.error.stack ?? "").split("\n").filter((l) => l.includes(path.basename(target)));
		for (const frame of frames.slice(0, 4)) console.log(`  ↳${frame.trim().replace(/^at\s*/, " at ")}`);
	}
	console.log(`\n结果：FAIL（${failures.length} 处）—— 这个客户端模块会让页面白屏。`);
	process.exitCode = 1;
} else {
	console.log(`\n结果：PASS —— ${componentNames.length} 个组件 × 2 种模式，渲染体都跑通了。`);
}
