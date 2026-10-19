/** translateToolUtterance 离线单测（从 index.js 抠函数 eval）。 */
import { readFileSync } from "node:fs";
const src = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-webin-edge-driver/lib/index.js", "utf8");
const m = src.match(/function translateToolUtterance[\s\S]*?\n\t}/);
if (!m) { console.log("没抠到函数"); process.exit(1); }
const fn = new Function("return " + m[0].replace("function translateToolUtterance", "function"))();
const tools = [
  { name: "read", parameters: { required: ["path"], properties: { path: {} } } },
  { name: "web_search", parameters: { required: ["queries"], properties: {} } },
  { name: "knowledge_search", parameters: { required: ["query"], properties: {} } },
];
const cases = [
  ["T1 参数对象", '我要用工具 read，参数 {"path": "C:/test.txt"}'],
  ["T2 裸参数单参", "我要调用 read，C:/test.txt"],
  ["T3 工具不存在", "我要用工具 hack，参数 {}"],
  ["T4 聊天不误翻", "我要用工具的时候再告诉你"],
  ["T5 空文本", ""],
  ["T6 坏 JSON", "我要用工具 read，参数 {path: 没引号}"],
  ["T7 长文不翻", "我要用工具 read，参数 {} ——" + "很长的解释 ".repeat(80)],
];
for (const [label, input] of cases) {
  const r = fn(input, tools);
  console.log(`${label}: ${r === null ? "null（不翻）" : r.split("\n")[1]?.slice(0, 60)}`);
}
