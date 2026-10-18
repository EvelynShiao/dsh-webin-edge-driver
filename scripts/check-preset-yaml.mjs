/** 校验 dsh-preset-lite 的 cordis.patch.yml 能否被 YAML 解析、标记是否完好。 */
import { readFileSync } from "node:fs";
const path = process.argv[2];
const text = readFileSync(path, "utf8");
/** 与 cordis loader 同款：@deepseek-ai 的 yaml 包在主程序里，这里用 js-yaml 兜底。 */
let YAML;
try { YAML = (await import("yaml")).default; } catch { YAML = (await import("js-yaml")).default; }
const doc = YAML.parseDocument ? YAML.parseDocument(text) : YAML.load(text);
const root = YAML.parseDocument ? doc.toJS(true) : doc;
const inserts = root?.insert ?? root;
if (!Array.isArray(inserts)) throw new Error("顶层不是数组/insert");
const ids = inserts.map((e) => e?.id).join(", ");
const markers = {
  dafeyu: [">>> workshop:dafeyu >>>", "<<< workshop:dafeyu <<<"],
  extra: [">>> workshop:extra >>>", "<<< workshop:extra <<<"],
  chat: [">>> workshop:chat >>>", "<<< workshop:chat <<<"],
};
for (const [k, [open, close]] of Object.entries(markers)) {
  const hasOpen = text.includes(open);
  const hasClose = text.includes(close);
  console.log(`标记 ${k}: open=${hasOpen} close=${hasClose}`);
  if (hasOpen !== hasClose) throw new Error(`标记 ${k} 不配对`);
}
console.log("✅ YAML 解析成功，insert 条目:", JSON.stringify(ids));
