/** 令牌文件格式侦测：元宝/豆包的导出文件第 1 行是 cookie（token 为空、cookie 挪到 token 行）——
 *  老导入脚本把 lines[0] 当 token、[1:] 当 cookie——对 deepseek 对，对元宝/豆包全错位！
 *  修正：token 行为空 ⇒ 第 1 行就是 cookie 起点。
 */
import { readFileSync } from "node:fs";
const TOK_DIR = "C:/Users/Evelyn/Desktop/肖浩成/小程序/Toekn管理/tokens";
for (const f of ["deepseek#cai-deepseek", "yuanbao#cai-yuanbao", "doubao#cai-doubao"]) {
  const lines = readFileSync(`${TOK_DIR}/${f}.txt`, "utf8").split(/\r?\n/).filter(l => l.trim() !== "");
  const first = lines[0] ?? "";
  const isCookie = /[=;]/.test(first) && first.length > 200;
  console.log(`${f}: 首行长=${first.length} 像cookie=${isCookie} 总行=${lines.length}`);
  console.log('  首行头 120 字:', first.slice(0, 120));
}
