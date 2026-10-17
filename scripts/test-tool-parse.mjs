/**
 * 工具调用解析的回归测试（跑**真函数**，不是抄的逻辑）。
 *
 *   node scripts/test-tool-parse.mjs
 *
 * 覆盖三种真机见过的形态：
 *   1. 标准 ```ldw 围栏（协议要求的写法）
 *   2. `ldw` + 换行 + 代码（2026-10-17 豆包/元宝实测，**没写围栏**）
 *   3. 只有 DSML 标记（网页版原生语法，插件无法执行 → 必须给出可读提示，
 *      而不是空回复）
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

console.log("工具调用解析测试\n" + "─".repeat(56));

// ① 标准围栏
check("标准 ```ldw 围栏", () => {
  const r = parseToolCalls('```ldw\nconst r = await pwsh({"command": "Get-Date"});\nlog(r);\n```', TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "pwsh");
  assert.deepEqual(JSON.parse(r.calls[0].arguments), { command: "Get-Date" });
  assert.equal(r.text.trim(), "", "代码块不应漏进正文");
});

// ② 真机形态：ldw + 换行，没有围栏
check("ldw + 换行（无围栏，真机实测）", () => {
  const reply = 'ldw\nconst r = await pwsh({"command": "Get-ChildItem C:\\\\Users"});\nlog(r);';
  const r = parseToolCalls(reply, TOOLS);
  assert.equal(r.calls.length, 1, "应该解析出 1 个调用");
  assert.equal(r.calls[0].name, "pwsh");
  assert.equal(JSON.parse(r.calls[0].arguments).command, "Get-ChildItem C:\\Users");
  assert.equal(r.text.trim(), "");
});

// ③ ldw + 空格（同一行）
check("ldw + 空格（同一行）", () => {
  const r = parseToolCalls('ldw const r = await read({"file_path": "README.md"}); log(r);', TOOLS);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0].name, "read");
  assert.equal(JSON.parse(r.calls[0].arguments).file_path, "README.md");
});

// ④ 普通文字：不能误判成工具调用
check("普通回答不误判", () => {
  const r = parseToolCalls("文件夹里有 18 个子目录和一些视频文件。", TOOLS);
  assert.equal(r.calls.length, 0);
  assert.ok(r.text.includes("18 个子目录"));
});

// ⑤ 只有 DSML：不能返回空回复
check("DSML 形态给出可读提示（不是空回复）", () => {
  const r = parseToolCalls("<|tool_calls|><|tool_call|>pwsh<|/tool_call|><|/tool_calls|>", TOOLS);
  assert.equal(r.calls.length, 0);
  assert.ok(r.text.trim() !== "", "正文不能为空，必须给用户一句说明");
  assert.ok(/工具调用/.test(r.text), "提示里要说明是工具调用没执行");
});

console.log("\n" + (fails.length === 0
  ? `全部通过（${pass} 项）`
  : `${pass} 通过 / ${fails.length} 失败：\n  - ` + fails.join("\n  - ")));
if (fails.length > 0) process.exitCode = 1;
