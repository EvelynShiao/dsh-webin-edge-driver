/** 数学 6c8b8162 深挖：找 OpenCode 闪退的现场（工具调用/错误/环境段）。 */
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
// 找 OpenCode / 闪退 / crash / local-opencode 相关
for (const l of lines) {
  if (/opencode|OpenCode|闪退|crash|ECONNREFUSED|exit code|spawn/i.test(l)) {
    try {
      const j = JSON.parse(l); const d = j.data ?? {};
      const kind = d.kind ?? j.type;
      let snip = "";
      const c = d.message?.content;
      if (Array.isArray(c)) snip = c.map(b => String(b.text ?? b.arguments ?? "").slice(0, 120)).join(" | ");
      else if (d.text) snip = String(d.text).slice(0, 150);
      else snip = JSON.stringify(d).slice(0, 150);
      console.log(`[${kind}] ${snip.replace(/\n/g, " ⏎ ")}`);
    } catch {}
  }
}
