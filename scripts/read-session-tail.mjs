/** 用宿主真解码器读会话尾部（多帧 zstd 正确解法）。 */
import { pathToFileURL } from "node:url";
import { readFileSync } from "node:fs";

const target = process.argv[2];
const base = "C:/Users/Evelyn/AppData/Local/Programs/DeepSeekHarness/dsh/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai";
try {
  const mod = await import(pathToFileURL(base + "/dsh-session-persistence-jsonl/lib/worker.cjs").href);
  console.log("exports:", Object.keys(mod).join(","));
} catch (e) {
  console.log("worker import 失败:", e.message);
}
// 兜底：自己按帧解（zstd 帧头 magic 0x28B52FFD）
try {
  const mod2 = await import(pathToFileURL(base + "/dsh-session/lib/index.js").href);
  console.log("dsh-session exports:", Object.keys(mod2).slice(0, 20).join(","));
} catch (e) {
  console.log("dsh-session import 失败:", e.message);
}
