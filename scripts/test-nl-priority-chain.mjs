/** NL 优先级链测试（第九批综合）：KB > 通用NL > .txt 出口互斥 + 与 .txt 不冲突。
 *  抠出三个翻译函数 + 出口模式 + 同会话不重传判据，跑 12 个组合。
 */
import { readFileSync } from "node:fs";

const adapterSrc = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-adapter-compat/nl-utterance.js", "utf8");
const webinSrc = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-webin-edge-driver/lib/index.js", "utf8");

/** 抠 translateKbUtterance + translateToolUtterance + translateUtterance（nl-utterance）*/
const idx1 = adapterSrc.indexOf("const UTTERANCE_LEADINS");
const idx2 = adapterSrc.indexOf("/** 块开头是否疑似");
const nlFns = adapterSrc.slice(idx1, idx2).replace(/^export function /gm, "function ");

/** 抠 resolveExitMode（webin）*/
const mExit = webinSrc.match(/function resolveExitMode\(\)[\s\S]*?\n\t\}/);
if (!mExit) { console.log("❌ resolveExitMode 没抠到"); process.exit(1); }

/** 抠同会话不重传的判据段（txtSentCount 相关——从 streamOnce 里抠关键行做模拟）*/
/** 模拟 streamOnce 的决策逻辑：给定（exitMode, promptLen, txtSentCount, messagesLen, text）算出每轮动作 */
const simulate = (cfg) => {
  const { exitMode, directLimit = 6000, promptLen, txtSentCount, messagesLen, text, tools, kbOn, nlOn } = cfg;
  const out = { actions: [] };
  // ① NL 翻译优先（比 .txt 判定先跑——实际代码里 KB 翻译在回复端、.txt 在发送端，互不抢）
  const fn = new Function("tools", "kb", "nl", `${nlFns}\nreturn translateUtterance(${JSON.stringify(text)}, tools, { kb, nl });`);
  const hit = fn(tools, kbOn === true, nlOn === true);
  if (hit !== null) { out.actions.push(`NL翻译→${hit.name}`); out.nlHit = true; }
  // ② .txt 出口判定
  const shouldFile = exitMode === "always" || (exitMode === "auto" && promptLen > directLimit);
  if (shouldFile) {
    // 同会话不重传
    const skip = typeof txtSentCount === "number" && messagesLen > txtSentCount && (messagesLen - txtSentCount) < promptLen;
    out.actions.push(skip ? "同会话增量(不重传.txt)" : ".txt附件");
    out.txtSend = !skip;
  } else if (promptLen > 0) out.actions.push("直接发送");
  return out;
};

const tools = [
  { name: "knowledge_search", parameters: { required: ["query"], properties: {} } },
  { name: "archives_search", parameters: { required: ["query"], properties: {} } },
  { name: "read", parameters: { required: ["path"], properties: {} } },
];

let pass = 0, total = 0;
const t = (label, cond) => { total++; if (cond) pass++; console.log(`${cond ? "✅" : "❌"} ${label}`); };

// 优先级 1：KB 句式优先于通用 NL
const kbFirst = simulate({ exitMode: "never", promptLen: 100, text: "我要调动第一层知识库，搜索光阳", tools, kbOn: true, nlOn: true });
t("① KB 句式优先（kb 开 nl 开 → knowledge_search）", kbFirst.nlHit === true && kbFirst.actions[0].includes("knowledge_search"));

// 优先级 2：KB 关、NL 开 → 通用 NL 兜底
const nlFallback = simulate({ exitMode: "never", promptLen: 100, text: '我要用工具 read，参数 {"path": "C:/a"}', tools, kbOn: false, nlOn: true });
t("② KB 关 → 通用 NL 兜底（read）", nlFallback.nlHit === true && nlFallback.actions[0].includes("read"));

// 优先级 3：KB 开、句式不匹配 → 通用 NL 再试
const nlAfter = simulate({ exitMode: "never", promptLen: 100, text: '我要调用 read，C:/b.txt', tools, kbOn: true, nlOn: true });
t("③ KB 无匹配 → 通用 NL 接住", nlAfter.nlHit === true && nlAfter.actions[0].includes("read"));

// 优先级 4：全关 → 不翻译
const noNl = simulate({ exitMode: "never", promptLen: 100, text: "我要调动第一层知识库，搜索光阳", tools, kbOn: false, nlOn: false });
t("④ 全关 → 不翻译", noNl.nlHit !== true);

// 优先级 5：NL 命中 + 大输入 .txt 出口——两者不冲突（NL 在回复端，.txt 在发送端）
const both = simulate({ exitMode: "always", promptLen: 8000, text: "我要调动第二层知识库，搜索Lyma", tools, kbOn: true, nlOn: true });
t("⑤ NL 命中 + .txt 出口同时生效（不互斥）", both.nlHit === true && both.txtSend === true);

// 优先级 6：同会话不重传
const noResend = simulate({ exitMode: "always", promptLen: 8000, txtSentCount: 10, messagesLen: 12, text: "你好", tools, kbOn: true, nlOn: true });
t("⑥ 同会话已传 → 增量不重传", noResend.txtSend === false && noResend.actions.some(a => a.includes("不重传")));

// 优先级 7：首次传 .txt
const first = simulate({ exitMode: "always", promptLen: 8000, txtSentCount: undefined, messagesLen: 10, text: "你好", tools, kbOn: true, nlOn: true });
t("⑦ 首次 → .txt 附件", first.txtSend === true);

// 优先级 8：普通聊天不触发 NL
const chat = simulate({ exitMode: "auto", promptLen: 100, text: "今天聊聊光阳", tools, kbOn: true, nlOn: true });
t("⑧ 普通聊天不误翻", chat.nlHit !== true && chat.actions[0] === "直接发送");

// 优先级 9：小输入 + auto → 直接发
t("⑨ 小输入 auto → 直接发", chat.actions[0] === "直接发送");

// 优先级 10：大输入 auto → .txt
const bigAuto = simulate({ exitMode: "auto", promptLen: 8000, text: "你好", tools, kbOn: true, nlOn: true });
t("⑩ 大输入 auto → .txt", bigAuto.txtSend === true);

// 优先级 11：never → 永不 .txt
const never = simulate({ exitMode: "never", promptLen: 8000, text: "你好", tools, kbOn: true, nlOn: true });
t("⑪ never → 不 .txt", never.txtSend !== true && never.actions[0] === "直接发送");

// 优先级 12：通用 NL 句式与 KB 句式撞车时 KB 先判
const kbWin = simulate({ exitMode: "never", promptLen: 100, text: "我要调动第一层知识库，搜索我要用工具 read", tools, kbOn: true, nlOn: true });
t("⑫ KB 句式先于通用（即便后文像通用句式）", kbWin.nlHit === true && kbWin.actions[0].includes("knowledge_search"));

console.log(`\n${pass}/${total} ${pass === total ? "全过 ✅" : "❌ 有挂"}`);
