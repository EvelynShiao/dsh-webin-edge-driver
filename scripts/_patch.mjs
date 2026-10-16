/**
 * 按锚点精确改文件（**自动处理 CRLF**）。
 *
 * ## 为什么要它
 *
 * 本仓库的源码是 **CRLF**（见交接文档的硬约束第 3 条）。直接用字符串替换改文件时，
 * 只要锚点里带换行，`\n` 和 `\r\n` 就对不上 —— 表现是「锚点没命中」，改文件的脚本
 * 静默失败（甚至只提交了版本号，代码没改，e14978b 那次就是这么来的）。
 *
 * 这个脚本的做法：
 *   1. 读文件 → 记下 EOL（优先 `\r\n`）→ 统一转成 `\n` 再做替换 → 写完还原 EOL；
 *   2. **每个锚点必须命中恰好 `count` 次**（默认 1）。命中 0 次（锚点写错）
 *      或命中多次（锚点撞车 —— 正是这次把 `apiDiag` 插进隔壁函数的元凶）
 *      都会**整体放弃写入**并报错；
 *   3. 全部锚点都命中才落盘 —— 原子性，不留半改状态。
 *
 * ## 用法
 *
 *   node scripts/_patch.mjs patch.json
 *
 * patch.json 形状（`old`/`new` 里的换行写 `\n` 就行，脚本负责 EOL）：
 *   {
 *     "file": "lib/client.js",
 *     "edits": [
 *       { "old": "锚点原文", "new": "替换后的原文", "count": 1 }
 *     ]
 *   }
 *
 * 先干跑看看命中情况：`node scripts/_patch.mjs patch.json --dry-run`
 */
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const patchPath = args.find((a) => a !== "--dry-run");

if (patchPath === void 0) {
	console.error("用法：node scripts/_patch.mjs <patch.json> [--dry-run]");
	process.exit(2);
}

const patch = JSON.parse(readFileSync(path.resolve(patchPath), "utf8"));
const file = path.resolve(here, "..", patch.file);
const raw = readFileSync(file, "utf8");
const eol = raw.includes("\r\n") ? "\r\n" : "\n";
const original = raw.split("\r\n").join("\n");

const countOf = (haystack, needle) => haystack.split(needle).length - 1;

/** 第一遍：**只检查**，一个不对就全部放弃。 */
const problems = [];
const planned = [];
for (const [index, edit] of (patch.edits ?? []).entries()) {
	const want = edit.count ?? 1;
	const found = countOf(original, edit.old);
	if (found !== want) {
		problems.push(`第 ${index + 1} 处：期望命中 ${want} 次，实际 ${found} 次 —— ${JSON.stringify(edit.old.slice(0, 60))}…`);
		continue;
	}
	planned.push({ index, edit });
}

if (problems.length > 0) {
	console.error(`✗ 锚点不匹配，未写入任何改动（${patch.file}）：`);
	for (const p of problems) console.error(`  · ${p}`);
	console.error("\n提示：锚点撞车（命中多次）说明你选的那段文字在文件里不唯一 ——");
	console.error("      这正是把 apiDiag 插进隔壁函数的元凶，请把锚点写得更长/更独特。");
	process.exit(1);
}

/** 第二遍：真的替换。 */
let out = original;
for (const { edit } of planned) out = out.replace(edit.old, edit.new);

const next = out.split("\n").join(eol);
const changed = next !== raw;

if (dryRun) {
	console.log(`（干跑）${patch.file}：${planned.length} 处锚点全部命中，EOL=${eol === "\r\n" ? "CRLF" : "LF"}` +
		`${changed ? "" : "，但内容没变化"}`);
	process.exit(0);
}

if (!changed) {
	console.log(`＝ ${patch.file}：锚点命中，但内容与原来一样，没写。`);
	process.exit(0);
}

writeFileSync(file, next, "utf8");
console.log(`✓ ${patch.file}：应用 ${planned.length} 处改动` +
	`（${raw.length} → ${next.length} 字符，EOL=${eol === "\r\n" ? "CRLF" : "LF"}）`);
