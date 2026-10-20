/** txt-chunk 纯函数单测：切割边界/换行优先/单片直通/命名/UTF-8 安全。 */
import test from "node:test";
import assert from "node:assert/strict";
import { chunkFileBytes, partFileName, DEFAULT_TXT_CHUNK_BYTES } from "../lib/txt-chunk.js";

test("小于阈值：单片直通", () => {
  const buf = Buffer.from("hello");
  const parts = chunkFileBytes(buf, 100);
  assert.equal(parts.length, 1);
  assert.equal(parts[0].toString(), "hello");
});

test("超阈值：切多片且内容无损", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `line-${i} 内容内容内容`).join("\n");
  const buf = Buffer.from(lines);
  const parts = chunkFileBytes(buf, 1024);
  assert.ok(parts.length >= 2, `应切多片，实际 ${parts.length}`);
  assert.equal(Buffer.concat(parts).toString(), lines, "拼接后必须与原文一致");
});

test("切点在换行处（每片以完整行结尾）", () => {
  const lines = Array.from({ length: 100 }, (_, i) => `row${i}`).join("\n");
  const buf = Buffer.from(lines);
  const parts = chunkFileBytes(buf, 300);
  for (let i = 0; i < parts.length - 1; i++) {
    assert.equal(parts[i][parts[i].length - 1], 0x0a, `片 ${i} 应以换行结尾`);
  }
});

test("不拆 UTF-8：切割后每片 toString 无替换符", () => {
  const text = "雪❄光阳📅".repeat(2000);
  const buf = Buffer.from(text);
  const parts = chunkFileBytes(buf, 2048);
  const joined = parts.map((p) => p.toString("utf8")).join("");
  assert.equal(joined.includes("\uFFFD"), false, "不应出现 U+FFFD 替换符");
  assert.equal(joined, text);
});

test("命名：partN-ofM", () => {
  assert.equal(partFileName("input-123.txt", 0, 3), "input-123-part1-of3.txt");
  assert.equal(partFileName("noext", 2, 5), "noext-part3-of5.txt");
});

test("默认阈值 400KB", () => {
  assert.equal(DEFAULT_TXT_CHUNK_BYTES, 400 * 1024);
});
