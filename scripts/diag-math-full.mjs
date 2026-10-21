/** 数学 6c8b8162 全事件 dump——找你最新那次 OpenCode 尝试（22:14 后）的报错原文。 */
import { zstdDecompressSync } from "node:zlib";
import { readFileSync } from "node:fs";
const buf = readFileSync("C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/sessions/--C-Users-Evelyn-AppData-Local-DeepSeekHarness-.dsh-work-~5B66~4E60--/session-6c8b8162-d5a3-4bdf-9c17-eda2fc649079/session.v4.jsonl.zstd");
const MAGIC = 0xfd2fb528;
let offset = 0; const chunks = [];
while (offset + 4 <= buf.length) {
  if (buf.readUInt32LE(offset) !== MAGIC) { offset += 1; continue; }
  try { const out = zstdDecompressSync(buf.subarray(offset)); chunks.push(out); let next = offset + 4; while (next + 4 <= buf.length) { if (buf.readUInt32LE(next) === MAGIC) break; next += 1; } offset = next; } catch { offset += 1; }
}
const lines = Buffer.concat(chunks).toString("utf8").trim().split("\n");
console.log("总事件:", lines.length);
// 尾部 25 条全 dump
for (const l of lines.slice(-25)) {
  try {
    const j = JSON.parse(l); const d = j.data ?? {};
    const kind = d.kind ?? j.type;
    let snip = "";
    const c = d.message?.content;
    if (Array.isArray(c)) snip = c.map(b => String(b.text ?? b.arguments ?? "").slice(0, 100)).join(" | ");
    else if (d.error?.message) snip = "ERR: " + d.error.message.slice(0, 150);
    else if (d.reason?.error?.message) snip = "TURN-ERR: " + d.reason.error.message.slice(0, 150);
    else snip = JSON.stringify(d).slice(0, 130);
    console.log(`[${kind}] ${snip.replace(/\n/g, " ⏎ ")}`);
  } catch {}
}
