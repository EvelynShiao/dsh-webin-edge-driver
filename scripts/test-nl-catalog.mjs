/** 自然语言工具目录验证：新格式输出 + parseToolCalls 仍认 ```ldw 调用。 */
import { readFileSync } from "node:fs";
const src = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-webin-edge-driver/lib/index.js", "utf8");

/** 抠 buildToolCatalog（新版）+ firstSentence。 */
const idx = src.indexOf("function buildToolCatalog");
const end = src.indexOf("\nfunction", idx + 10);
const catalogFn = src.slice(idx, end > 0 ? end : undefined);
const fsIdx = src.indexOf("function firstSentence");
const fsEnd = src.indexOf("\nfunction", fsIdx + 10);
const firstSentenceFn = src.slice(fsIdx, fsEnd > 0 ? fsEnd : undefined);

const tools = [
  { name: "read", description: "读取一个 UTF-8 文本文件并返回带行号的内容。", parameters: { required: ["path"], properties: { path: { type: "string" }, limit: { type: "number" } } } },
  { name: "web_search", description: "联网搜索，返回来源链接列表。", parameters: { required: ["queries"], properties: { queries: { type: "array" } } } },
  { name: "memory_add", description: "新增一条长期记忆。", parameters: {} },
];

const fn = new Function("tools", `${firstSentenceFn}
${catalogFn}
return buildToolCatalog(tools);`);
const out = fn(tools);
console.log("=== 新目录格式 ===");
console.log(out);
console.log("");

let pass = 0, total = 0;
const t = (label, cond) => { total++; if (cond) pass++; console.log(`${cond ? "✅" : "❌"} ${label}`); };

t("无反引号签名", !out.includes("`read"));
t("无括号类型签名", !/\{.*type.*\}/.test(out));
t("描述打头（中文）", out.startsWith("1. 读取"));
t("工具名在行尾", out.includes("调用时写 read") && out.includes("调用时写 web_search"));
t("参数自然语言", out.includes("参数path必填") && out.includes("参数limit可选"));
t("无参数工具无参数段", out.split("\n")[2].includes("调用时写 memory_add") && !out.split("\n")[2].includes("参数"));
console.log(`\n${pass}/${total} ${pass === total ? "全过 ✅" : "❌"}`);
