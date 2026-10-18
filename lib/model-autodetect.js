/**
 * 模型清单自动识别（2026-10-18，用户点名）
 * ==========================================
 *
 * ## 用户的需求
 *
 * 「元宝其实有 hy3,hy4,deepseek 三个模型，你应该做出这三个模型的选项，
 *  有对应思考强度；豆包则有工作/聊天两个模式。建议代码能够自动识别
 *  而不是死的。」
 *
 * 写死的清单跟不上页面改版（元宝从 Instant/Thinking/Expert 改成
 * hy3/hy4/deepseek 就是活例子）。所以这里做**探测 + 按需建模**：
 *
 *   1. `detectPageModels()` —— 用 CDP 打开平台页面，把「模型选择器」
 *      弹层里的选项全部读出来（可见的、有文字的、像模型名的）。
 *   2. 读出来的清单与内置 models 合并：探测到的选项各生成一个模型条目，
 *      id 用探测到的稳定字（hy3/hy4/DeepSeek/聊天/工作），pageModel
 *      用**页面上的原文**（点击时按原文匹配，见 applyPageModel）。
 *   3. 思考强度：DeepSeek 系（含元宝里的 deepseek 档）给「思考」，
 *      hunyuan 系给「思考」，其余只给「快速」——但都以探测结果为准：
 *      页面档位名带 think/reason/R1 的视为可思考。
 *
 * ## 为什么放 lib/ 而不是 scripts/
 *
 * scripts/ 是一次性探测脚本（人跑的）；这个要被 host 的 HTTP 路由调用
 * （`POST /providers/:id/detect-models`），是运行时能力。
 *
 * ## 稳定性原则（与 applyPageModel 一致）
 *
 * - 探测失败不报错，返回空清单 —— 清单仍是内置那份，行为不变。
 * - 探测结果**持久化**到 `webin/detected-models/<平台>.json`，
 *   带 `detectedAt` 时间戳；listModels 合并时优先用**较新**的那份。
 * - 合并是**叠加**不是替换：内置条目保留（万一探测漏了还有兜底）。
 */

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/** 探测结果的存储目录（在 stateRoot 下）。 */
export function detectedModelsPath(stateRoot, platformId) {
	return join(stateRoot, "detected-models", `${platformId}.json`);
}

/** 读某平台的探测结果（坏文件/不存在 → null）。 */
export function loadDetected(stateRoot, platformId) {
	const p = detectedModelsPath(stateRoot, platformId);
	if (!existsSync(p)) return null;
	try {
		const parsed = JSON.parse(readFileSync(p, "utf8"));
		if (parsed === null || typeof parsed !== "object" || !Array.isArray(parsed.models)) return null;
		return parsed;
	} catch {
		return null;
	}
}

/** 原子写探测结果（2026-10-18 起含 modes：两层菜单）。存不下不影响主流程。 */
export function saveDetected(stateRoot, platformId, models, modes, raw) {
	try {
		const p = detectedModelsPath(stateRoot, platformId);
		mkdirSync(dirname(p), { recursive: true });
		const tmp = `${p}.tmp`;
		writeFileSync(tmp, `${JSON.stringify({ detectedAt: Date.now(), models, modes: Array.isArray(modes) ? modes : [], raw }, null, 2)}\n`, "utf8");
		renameSync(tmp, p);
		return true;
	} catch {
		return false;
	}
}

/**
 * 把页面选项文本规范成模型 id 的小写字（hy3 / hy4 / deepseek / 聊天 / 工作）。
 *
 * 页面原文可能是「Hunyuan T1」「混元 hy4」「DeepSeek-R1」「聊天模式」——
 * 提取字母数字段，取最像模型代号的那个。
 */
export function slugFromText(text) {
	const t = String(text ?? "").trim();
	if (t === "") return "";
	/** 直接命中已知代号（大小写不敏感，允许中英混排）。 */
	const KNOWN = [
		["hy3", /hy[\s-]?3|hunyuan[\s-]?3/i],
		["hy4", /hy[\s-]?4|hunyuan[\s-]?4/i],
		["deepseek", /deepseek|ds[\s-]?\d/i],
		["t1", /\bt1\b/i],
		["r1", /\br1\b/i],
	];
	for (const [id, re] of KNOWN) if (re.test(t)) return id;
	/** 中文模式名：聊天/工作/写作等直接当 id 用。 */
	const zh = t.match(/(聊天|工作|写作|绘图|搜索|联网)/);
	if (zh) return zh[1];
	/** 兜底：字母数字段，最长的那段。 */
	const latin = t.match(/[A-Za-z0-9][A-Za-z0-9\-]{1,30}/);
	return latin ? latin[0].toLowerCase() : "";
}

/** 这个页面选项像不像「思考型」档位（决定 efforts 与 thinking 标记）。 */
export function looksThinking(text) {
	return /think|思考|深思|reason|推理|R1|T1|深度/i.test(String(text ?? ""));
}

/**
 * 探测到的原始选项 → 模型条目（与内置 models 同形）。
 *
 * @param {Array<{text:string}>} items - 页面读到的选项文本
 * @param {string} platformId - 平台 id（决定命名前缀与 thinking 判定）
 */
export function modelsFromItems(items, platformId) {
	const out = [];
	const seen = new Set();
	for (const raw of items) {
		const text = String(raw?.text ?? "").trim();
		if (text === "" || text.length > 60) continue;
		const slug = slugFromText(text);
		if (slug === "" || seen.has(slug)) continue;
		seen.add(slug);
		const thinking = looksThinking(text);
		out.push({
			id: `${platformId}-${slug}`,
			name: `LDW · ${text.split(/\n| {2,}/)[0].slice(0, 30)}`,
			description: `自动识别的页面档位：${text.slice(0, 50)}`,
			thinking,
			pageModel: text.split(/\n/)[0].trim(),
			auto: true,
		});
	}
	/** 探测到的思考档排前（用户主要用思考型）。 */
	out.sort((a, b) => Number(b.thinking) - Number(a.thinking));
	return out;
}

/**
 * 探测到的「模式层」文本 → 思考强度档位（2026-10-18 第三批：两层菜单）。
 *
 * 元宝模式层：Instant / Thinking / Expert；豆包：聊天 / 工作。
 * 页面原文 → effort id 的映射，未知原文保留原文当 id（自动识别的本意）。
 */
export function modesFromItems(items) {
	const out = [];
	const seen = new Set();
	for (const raw of items) {
		const text = String(raw?.text ?? "").trim();
		if (text === "" || text.length > 40) continue;
		const lower = text.toLowerCase();
		let id = "";
		if (/instant|快答|快速/.test(lower)) id = "instant";
		else if (/think|深思|思考/.test(lower)) id = "thinking";
		else if (/expert|工具/.test(lower)) id = "expert";
		else if (/off|关闭|关/.test(lower)) id = "off";
		else if (/medium|中/.test(lower)) id = "medium";
		else id = lower.replace(/\s+/g, "-").slice(0, 24);
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({ id, name: text.slice(0, 40) });
	}
	return out;
}

/**
 * 内置 models 与探测 models 合并（叠加不替换）。
 *
 * 规则：
 *   - 探测结果太旧（> 14 天）或为空 → 只用内置；
 *   - 探测到的 pageModel 与内置重复（同 slug）→ 保留探测的（页面为准）；
 *   - 内置独有的保留（兜底）。
 */
export function mergeModels(builtin, detected, { maxDetected = 8 } = {}) {
	const base = Array.isArray(builtin) ? builtin : [];
	if (!Array.isArray(detected) || detected.length === 0) return base;
	/** 内置条目的 slug（去掉平台前缀后比对）。 */
	const builtinSlugs = new Set(base.map((m) => String(m?.id ?? "").split("-").slice(1).join("-")));
	const merged = [...base];
	for (const m of detected.slice(0, maxDetected)) {
		const slug = String(m?.id ?? "").split("-").slice(1).join("-");
		if (builtinSlugs.has(slug)) {
			/** 同名档位：用探测到的覆盖内置的（页面现状优先）。 */
			const idx = merged.findIndex((x) => String(x?.id ?? "") === m.id);
			if (idx >= 0) merged[idx] = { ...merged[idx], ...m, name: m.name ?? merged[idx].name };
			continue;
		}
		merged.push(m);
	}
	return merged;
}
