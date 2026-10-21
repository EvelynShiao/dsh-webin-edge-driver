/** 无依赖 YAML 结构校验（只验证 title-llm 块的存在和形状——完整 YAML 由宿主重启时校验）。 */
import { readFileSync } from "node:fs";
const raw = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/profiles/web/cordis.patch.yml", "utf8");
const lines = raw.split(/\r?\n/);

let pass = 0, total = 0;
const t = (label, cond) => { total++; if (cond) pass++; console.log(`${cond ? "✅" : "❌"} ${label}`); };

const blockStart = lines.findIndex(l => l.trim() === "- id: session-title-llm");
t("找到 session-title-llm 条目", blockStart >= 0);
if (blockStart >= 0) {
  const block = lines.slice(blockStart, blockStart + 12);
  t("name 指向 first-prompt-llm", block.some(l => l.includes("dsh-session-title-first-prompt-llm")));
  t("provider=inai-deepseek", block.some(l => /provider:\s*inai-deepseek/.test(l)));
  t("model=deepseek-v4.1-flash-1017", block.some(l => /model:\s*deepseek-v4\.1-flash-1017/.test(l)));
  t("targetWords 在", block.some(l => /targetWords:\s*\d/.test(l)));
  t("timeoutMs 在", block.some(l => /timeoutMs:\s*\d/.test(l)));
  // 无 tab 缩进（YAML 大忌）
  t("无 tab 缩进", !block.some(l => l.includes("\t")));
}
console.log(`\n${pass}/${total} ${pass === total ? "全过 ✅" : "❌"}`);
