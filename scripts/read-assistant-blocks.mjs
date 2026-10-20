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
const want = Number(process.argv[3] ?? 3);
const msgs = [];
for (const l of lines) { try { const j = JSON.parse(l); const d = j.data ?? {}; if (j.type === "assistant/message" && Array.isArray(d.message?.content)) msgs.push(d); } catch {} }
console.log(`assistant/message 共 ${msgs.length} 条，显示最后 ${Math.min(want, msgs.length)} 条：`);
for (const d of msgs.slice(-want)) {
  console.log(`\n=== turn ${d.turn} step ${d.step} ===`);
  for (const b of d.message.content) console.log(`[${b.type}] ${String(b.text ?? "").slice(0, 220).replace(/\n/g, " ⏎ ")}`);
}
