/** 验证 listModels 的 legacy 过滤（HTTP 端点返回的是 provider 表——listModels 是 adapter 接口看不到。
 *  直接用宿主的 llm 服务验证不行（要 ctx），改法：离线跑 listModels 同款过滤逻辑 + resolve 的完整版行为。 */
import { readFileSync } from "node:fs";
const src = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-webin-edge-driver/lib/index.js", "utf8");
/** 找 listModels 的过滤行——确认代码在 */
const filterLine = src.includes("m?.legacy !== true");
console.log("listModels 过滤 legacy 代码在:", filterLine ? "✅" : "❌");
/** 旧会话解析兜底（resolve 回退 models[0]）也在 */
const fallback = src.includes("?? provider.models[0]");
console.log("resolve 旧 id 回退 models[0] 在:", fallback ? "✅" : "❌");
/** nlToolProtocol 接线 */
const nlOn = src.includes("nlOn ? translateToolUtterance") || src.includes("translateToolUtterance(replyText0");
console.log("自然语言工具接线在:", nlOn ? "✅" : "❌");
/** titlePrefix 接线 */
const tp = src.includes("titleOn ? withLdwTitlePrefix");
console.log("标题前缀开关接线在:", tp ? "✅" : "❌");
