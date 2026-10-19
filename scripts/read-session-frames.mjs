/** 手动多帧 zstd 解码：按帧魔数切（0x28B52FFD），逐帧 decompressSync。 */
import { zstdDecompressSync } from "node:zlib";
import { readFileSync } from "node:fs";

const buf = readFileSync(process.argv[2]);
const MAGIC = 0xfd2fb528;
let offset = 0;
const chunks = [];
let frames = 0;
while (offset + 4 <= buf.length) {
  const magic = buf.readUInt32LE(offset);
  if (magic !== MAGIC) { offset += 1; continue; }
  try {
    const out = zstdDecompressSync(buf.subarray(offset));
    chunks.push(out);
    frames += 1;
    /** 压缩帧长度没有直接字段（要解析帧头），用另一个法子：consumed。node 不给——那就扫下一个魔数。 */
    let next = offset + 4;
    while (next + 4 <= buf.length) {
      const m2 = buf.readUInt32LE(next);
      if (m2 === MAGIC) break;
      next += 1;
    }
    offset = next;
  } catch (e) {
    offset += 1;
  }
}
console.log(`帧数: ${frames}，解出 ${Buffer.byteLength(Buffer.concat(chunks))} 字节`);
const text = Buffer.concat(chunks).toString("utf8");
const lines = text.trim().split("\n");
console.log("事件数:", lines.length);
const tailN = Number(process.argv[3] ?? 14);
for (const l of lines.slice(-tailN)) {
  try {
    const j = JSON.parse(l);
    const d = j.data ?? {};
    const kind = d.kind ?? j.type;
    let snip = "";
    if (d.message?.content) { const c = d.message.content; snip = (typeof c === "string" ? c : JSON.stringify(c)); }
    else if (d.text) snip = "DELTA: " + String(d.text);
    else if (d.block?.text) snip = "BLOCK: " + String(d.block.text);
    else snip = JSON.stringify(d);
    console.log(`[${kind}]`, snip.replace(/\n/g, " ⏎ ").slice(0, 260));
  } catch { console.log("?", l.slice(0, 100)); }
}
