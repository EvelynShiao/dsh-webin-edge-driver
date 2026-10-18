/**
 * 区域替换：把 edge-driver.js 里「页面档位/模型」那一整块换成新的两层实现。
 * 用标记定位，避免大段 literal 匹配。
 *   起点：# ── 页面档位
 *   终点：# ── 富文本编辑器的「真输入」兜底
 */
import { readFileSync, writeFileSync } from "node:fs";

const target = process.argv[2];
const blockFile = process.argv[3];
const text = readFileSync(target, "utf8");
const block = readFileSync(blockFile, "utf8");

const START = "  // ── 页面档位";
const END = "  // ── 富文本编辑器的「真输入」兜底";
const start = text.indexOf(START);
const end = text.indexOf(END);
if (start < 0) throw new Error("找不到起点标记：" + START);
if (end < 0) throw new Error("找不到终点标记：" + END);
if (end < start) throw new Error("终点在起点之前");

const before = text.slice(0, start);
const after = text.slice(end);
const next = before + block + after;
writeFileSync(target, next, "utf8");
console.log(`✅ 已替换：${start}..${end}（${end - start} 字符 → ${block.length} 字符）`);
