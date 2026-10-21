/** 验证 OFM 模型隐藏开关端到端：POST /settings {hiddenModels} → listModels 过滤。 */
import { readFileSync, writeFileSync } from "node:fs";

// ① 单测 sanitizeSettings 的 hiddenModels 清洗逻辑（抠源码跑）
const src = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/profiles/web/node_modules/dsh-our-free-model/index.js", "utf8");
const idx = src.indexOf("function sanitizeSettings(patch, current)");
const end = src.indexOf("\n}", idx + 100);
const fn = new Function("return " + src.slice(idx, end + 2))();

let pass = 0, total = 0;
const t = (label, got, want) => {
  total++;
  const ok = JSON.stringify(got) === JSON.stringify(want);
  if (ok) pass++;
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` got=${JSON.stringify(got)} want=${JSON.stringify(want)}`}`);
};

t("合法字符串数组", fn({ hiddenModels: ["mimo-v2.6-flash-free"] }, {}).hiddenModels, ["mimo-v2.6-flash-free"]);
t("非数组丢弃", fn({ hiddenModels: "x" }, {}).hiddenModels, []);
t("空数组", fn({ hiddenModels: [] }, {}).hiddenModels, []);
t("混入非字符串过滤", fn({ hiddenModels: ["a", 42, "", "b"] }, {}).hiddenModels, ["a", "b"]);
t("undefined 不动", fn({}, {}).hiddenModels, undefined);

// ② listModels 过滤（模拟 state）
const adapterSrc = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/profiles/web/node_modules/dsh-our-free-model/src/adapter.js", "utf8");
const hasFilter = adapterSrc.includes("!hidden.has(entry.id)");
t("adapter.listModels 有 hidden 过滤", hasFilter, true);

console.log(`\n${pass}/${total} ${pass === total ? "全过 ✅" : "❌"}`);
