/** 32574b9c 会话的关键问题排查：它走的哪条通道（provider）+ 有没有走 .txt 出口 + 工具面是什么。
 *  会话标题是「没有。在这段对话中，我没有收到任何 .txt 附件」——标题生成跑题 + 模型说没收到 .txt。
 */
import { zstdDecompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
const buf = readFileSync(process.argv[2]);
const MAGIC = 0xfd2fb528;
let offset = 0; const chunks = [];
while (offset + 4 <= buf.length) {
  if (buf.readUInt32LE(offset) !== MAGIC) { offset += 1; continue; }
  try { const out = zstdDecompressSync(buf.subarray(offset)); chunks.push(out); let next = offset + 4; while (next + 4 <= buf.length) { if (buf.readUInt32LE(next) === MAGIC) break; next += 1; } offset = next; } catch { offset += 1; }
}
const lines = Buffer.concat(chunks).toString("utf8").trim().split("\n");
console.log("总事件:", lines.length);
for (const l of lines) {
  try {
    const j = JSON.parse(l); const d = j.data ?? {};
    const kind = d.kind ?? j.type;
    if (kind === "session/title-llm-request") console.log(`[title-req] route=${JSON.stringify(d.route)}`);
    if (kind === "session/title") console.log(`[title] "${String(d.title ?? "").slice(0, 50)}" source=${d.source?.kind ?? "?"}`);
    if (j.type === "model/selection") console.log(`[selection] ${d.provider} / ${d.model}`);
    if (j.type === "request/header") { const c = d.header?.config ?? {}; console.log(`[header] ${c.provider} / ${c.model} tools=${d.header?.tools?.length ?? 0} purpose=${c.purpose ?? "normal"}`); }
    if (j.type === "user/message" || j.type === "user/message") {
      const c2 = d.message?.content; const text = Array.isArray(c2) ? c2.map(b => b.text ?? "").join("") : String(c2 ?? "");
      if (text.length > 0) console.log(`[user t${d.turn ?? "?"}] ${text.length} 字: ${text.slice(0, 60).replace(/\n/g, " ⏎ ")}`);
    }
  } catch {}
}
