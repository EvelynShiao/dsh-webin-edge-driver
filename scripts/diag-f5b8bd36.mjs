/** f5b8bd36 首条消息——看用户当时发的是什么（大文本还是小问题）。 */
import { readFileSync } from "node:fs";
const pc = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/storages/session_projcache/sessions/session-f5b8bd36-ea62-45a5-83f6-741f20d1c16b.json", "utf8");
const j = JSON.parse(pc);
const first = j.record.rows.titleInput?.val?.first;
console.log("首条 user 消息：");
console.log("  长度:", first?.text?.length, "字符");
console.log("  内容头 300 字:", String(first?.text ?? "").slice(0, 300));
