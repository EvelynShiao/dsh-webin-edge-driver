/** stripLeadingThinkLeak 单测：思考残留剥离的边界。 */
import { readFileSync } from "node:fs";
const src = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-webin-edge-driver/lib/index.js", "utf8");
const m = src.match(/function stripLeadingThinkLeak[\s\S]*?\n\t\}/);
if (!m) { console.log("没抠到"); process.exit(1); }
const fn = new Function("return " + m[0].replace("function stripLeadingThinkLeak", "function"))();

let pass = 0, total = 0;
const t = (label, input, wantMoved, wantText) => {
  total++;
  const r = fn(input);
  const ok = (wantMoved === null ? r.moved === "" : r.moved.startsWith(wantMoved)) && (wantText === null ? true : r.text.startsWith(wantText));
  if (ok) pass++;
  console.log(`${ok ? "✅" : "❌"} ${label}${ok ? "" : ` → moved="${r.moved.slice(0, 30)}" text="${r.text.slice(0, 30)}"`}`);
};

// 命中
t("The user 开头", "The user asks: hello.\n\n这是真正回答。", "The user", "这是真正回答。");
t("Let me 开头", "Let me check the files.\n\n实际答案在这里。", "Let me", "实际答案在这里。");
t("用户 asks", "用户 asks 什么。\n\n答：是这样的。", "用户 asks", "答：是这样的。");
t("让我 开头", "让我想想。\n\n答案：42。", "让我", "答案：42。");
// 不命中
t("正常回答不误伤", "今天天气很好。\n\n适合出门。", null, null);
t("无第二段", "Let me think about this problem with no body.", null, null);
t("第一段太长", "The user " + "x".repeat(450) + "\n\n正文。", null, null);
t("空文本", "", null, null);
console.log(`\n${pass}/${total} ${pass === total ? "全过 ✅" : "❌"}`);
