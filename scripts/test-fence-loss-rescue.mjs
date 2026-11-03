/**
 * 围栏丢失兜底回归测试（跑**真函数** parseToolCalls，不是抄的逻辑）。
 *
 *   node scripts/test-fence-loss-rescue.mjs
 *
 * 背景（2026-11-02 第五窗口 C 实测缺口 + 第六窗口修复）：
 * 元宝 hy4 输出了工具调用代码体但围栏丢失 ⇒ 无 tool-call。修复 = 两个兜底：
 *   A. 孤儿 ldw 开栏重组 —— ldw 标记夹在正文中间 / 有无关围栏挡路（旧兜底只认
 *      「整条回复无 ``` 且 ldw 在最开头」）
 *   B. 裸 await 工具名({对象字面量}) 直捕 —— 连 ldw 标记都丢了
 * 两道误伤防护：散文示例（非对象字面量）不触发；有完整 ```ldw 围栏时保持旧行为。
 */
import assert from "node:assert/strict";
import { parseToolCalls } from "../lib/index.js";

const TOOLS = [
  { name: "pwsh", description: "执行 PowerShell", parameters: { type: "object", properties: { command: { type: "string" } } } },
  { name: "read", description: "读文件", parameters: { type: "object", properties: { file_path: { type: "string" } } } },
];

let pass = 0;
const fails = [];
function check(label, fn) {
  try { fn(); pass++; console.log("  ✓ " + label); }
  catch (error) { fails.push(label + " → " + (error?.message ?? error)); console.log("  ✗ " + label); }
}

console.log("围栏丢失兜底测试\n" + "─".repeat(56));

// ⑥ 第五窗口实锤形态：ldw 夹在正文中间（前面有寒暄），无围栏
check("兜底A：ldw 夹在正文中间（第五窗口实锤形态）", () => {
  const reply = '好的，我来读取文件。\n\nldw\nconst r = await read({"file_path": "README.md"});\nlog(r);';
  const r = parseToolCalls(reply, TOOLS);
  assert.equal(r.calls.length, 1, "应该解析出 1 个调用");
  assert.equal(r.calls[0].name, "read");
  assert.equal(JSON.parse(r.calls[0].arguments).file_path, "README.md");
  assert.equal(r.text.trim(), "好的，我来读取文件。", "寒暄保留为正文，代码体不漏");
  assert.equal(r.rescued, 1, "rescued 通道要记 1");
});

// ⑦ 无关围栏挡路（```js 示例块）+ 孤儿 ldw
check("兜底A：无关 ```js 围栏挡路时仍重组", () => {
  const reply = '先看说明：\n\n```js\nconsole.log("hi");\n```\n\nldw\nconst r = await pwsh({"command": "dir"});';
  const r = parseToolCalls(reply, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "pwsh");
  assert.equal(JSON.parse(r.calls[0].arguments).command, "dir");
  assert.ok(r.text.includes('console.log("hi")'), "js 示例块保留为正文");
  assert.ok(!r.text.includes("await pwsh"), "工具调用代码体不漏进正文");
});

// ⑧ 连 ldw 标记都丢了：裸 await 直捕
check("兜底B：裸 await read({...}) 直捕（无任何 ldw 痕迹）", () => {
  const reply = 'const r = await read({"file_path": "notes.txt"});\nconsole.log(r);';
  const r = parseToolCalls(reply, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "read");
  assert.equal(JSON.parse(r.calls[0].arguments).file_path, "notes.txt");
  assert.ok(!r.text.includes("await read"), "调用 span 从正文删除");
  assert.ok(r.text.includes("console.log(r)"), "周边正文保留");
  assert.equal(r.rescued, 1);
});

// ⑨ 误伤防护：散文里的非对象字面量示例不触发
check("防护：散文示例 await read(文件路径) 不触发", () => {
  const reply = "你可以这样用：await read(文件路径) —— 这只是示例。";
  const r = parseToolCalls(reply, TOOLS);
  assert.equal(r.calls.length, 0, "非对象字面量不执行");
  assert.ok(r.text.includes("await read(文件路径)"), "原文保留");
  assert.equal(r.rescued, 0);
});

// ⑩ 误伤防护：有完整 ```ldw 围栏时保持旧行为（围栏外的裸 await 不抓）
check("防护：有完整 ldw 围栏时不做兜底（旧行为）", () => {
  const reply = '```ldw\nconst r = await pwsh({"command": "Get-Date"});\n```\n\n另外你也可以 await read({"file_path":"x"}) 手动试试。';
  const r = parseToolCalls(reply, TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "pwsh", "只执行围栏里的那个");
  assert.ok(r.text.includes("await read"), "围栏外的示例文字保持为正文");
  assert.equal(r.rescued, 0);
});

console.log("\n" + (fails.length === 0
  ? `全部通过（${pass} 项）`
  : `${pass} 通过 / ${fails.length} 失败：\n  - ` + fails.join("\n  - ")));
if (fails.length > 0) process.exitCode = 1;
