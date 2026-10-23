import { createRequire } from "node:module";
import { createServer } from "node:http";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { EdgeDriver, EDGE_DRIVER_DEFAULTS } from "./edge-driver.js";
import { createLaunchBackoff } from "./launch-backoff.js";
import { waitForCookieProbe, peekCookieProbe } from "./login-cookie-probe.js";
import { SESSION_DELETE_MODES } from "./session-gc.js";
import { loadDetected, saveDetected, modelsFromItems, modesFromItems, mergeModels, detectedModelsPath } from "./model-autodetect.js";
import {
	isSafeSlotName,
	isSafeSnapshotName,
	safePathSegment,
	slotRuleText,
} from "./slot-names.js";
import {
	deleteCredential,
	describeRotation,
	getCredential,
	listCredentials,
	loadCredentials,
	saveCredentials,
	setCredential,
	storePath,
} from "./credential-store.js";
//#region src/shared/providers.ts
/**
* DeepSeek 网页版。
*
* 所有选择器与评分规则都来自**真浏览器实测**（`npm run probe:dom` /
* `npm run probe:send`），不是猜的。改版后先跑探测脚本再改这里。
*/
const DEEPSEEK = {
	id: "deepseek",
	name: "LDW · DeepSeek 网页版",
	homeUrl: "https://chat.deepseek.com/",
	urlPattern: "chat\\.deepseek\\.com",
	input: { selectors: [
		"textarea[placeholder*=\"给 DeepSeek\"]",
		"textarea[placeholder*=\"DeepSeek\"]",
		"textarea[placeholder*=\"输入\"]",
		"textarea[placeholder*=\"发送\"]",
		"textarea[placeholder*=\"message\" i]",
		"textarea[placeholder*=\"ask\" i]",
		"textarea.chat-input",
		"textarea",
		"div[contenteditable=\"true\"]",
		"[role=\"textbox\"]"
	] },
	send: {
		selectors: [
			"button[type=\"submit\"]",
			"button[aria-label*=\"send\" i]",
			"button[aria-label*=\"发送\"]",
			"[role=\"button\"][aria-label*=\"send\" i]",
			"[role=\"button\"][aria-label*=\"发送\"]",
			"[data-testid=\"send\"]",
			".send-btn"
		],
		signatures: [
			["ds-button--primary", 60],
			["ds-button--filled", 40],
			["ds-button--circle", 50]
		],
		vetoes: ["ds-toggle-button", "ds-button--capsule"]
	},
	completionPath: "/api/v0/chat/completion",
	stopPath: "/api/v0/chat/stop_stream",
	/**
	 * ## 单模型 + 思考强度档位（2026-10-18，用户点名）
	 *
	 * 「DeepSeek 的那个 LDW 模型选择里，快速和思考这两个不要列成两个模型，
	 *  而是放在思考强度里。」
	 *
	 * 于是一个模型 + reasoning.efforts：
	 *   - off     → 页面思考开关 = 关（旧行为 = ldw-fast）
	 *   - medium  → 页面思考开关 = 开（旧行为 = ldw-think）
	 *
	 * 兼容：旧会话里存的 `ldw-fast` / `ldw-think`（无前缀）仍能解析：
	 * resolve() 落不到任何模型时取 models[0]，effort 则由
	 * effortFromModelId() 从旧 id 里挖出来（见下）。
	 */
	models: [{
		id: "ldw",
		name: "LDW · DeepSeek 网页版",
		description: "真实浏览器驱动，思考强度控制页面「深度思考」开关",
		thinking: true
	},
	/**
	* 旧 id 别名（2026-10-19「模型选择失败」同案）：旧会话存 ldw-fast/ldw-think，
	* 新清单只有 ldw ⇒ model-unavailable 不让选。effortFromLegacyId 已把
	* 语义挖回来，这里再补清单条目让旧会话直接可选。
	*/
	{
		id: "ldw-fast",
		name: "LDW · 快速模式（旧 id）",
		description: "旧会话兼容别名 → LDW · 关思考",
		thinking: true,
		legacy: true,
		efforts: [{ id: "off", name: "快速" }],
		defaultReasoningEffort: "off"
	}, {
		id: "ldw-think",
		name: "LDW · 深度思考（旧 id）",
		description: "旧会话兼容别名 → LDW · 开思考",
		thinking: true,
		legacy: true,
		efforts: [{ id: "medium", name: "思考" }],
		defaultReasoningEffort: "medium"
	}],
	contextWindow: 1048576,
	maxOutputTokens: 32768,
	/**
	* ## 凭据注入参数（2026-10-16，供 `/credentials/inject` 用）
	*
	* DeepSeek 的登录态由**两半**组成，缺一不可（真机实验验证）：
	*
	*   1. cookie：`smidV2` / `.thumbcache_*` / `HWWAFSESID` / `HWWAFSESTIME`
	*      / `ds_session_id` —— 从 `document.cookie` 抄得到的那部分
	*   2. **localStorage `userToken`** —— 值是 appKit 信封
	*      `{"value":"<56 字符随机串>","__version":"0"}`，**整个信封原样写进去**
	*
	* ⚠️ 光有 cookie 不够（真正的 httpOnly 凭据抄不出来）、光有 token 也不够，
	* 实测**两者一起**才能在一个全新 profile 里直接登进去。
	*
	* ⚠️ `cookieUrl` 必须显式给出：cookie 是**依附域**的，不写就没有域可挂。
	*/
	credentialInjection: {
		localStorageKeys: ["userToken"],
		cookieUrl: "https://chat.deepseek.com/",
	},
	/**
	* ## 会话管理接口（2026-10-18 第三批，前缀识别回收的地基）
	*
	* 全部来自实测（edge-driver.js 顶部注释）：
	*   - 列表：GET /api/v0/chat_session/fetch_page?count=50&page=N
	*     → {data:{biz_data:{chat_sessions:[{id,title,updated_at,pinned}],has_more}}}
	*   - 删除：POST /api/v0/chat_session/delete，body {chat_session_id}，
	*     返回 {code:0,biz_code:0}
	*
	* ⚠️ 列表行的 id 字段是 `id`，删除 body 的键是 `chat_session_id`——
	* 所以 **idField 不设**（列表回落 'id'，删除回落 'chat_session_id'），别手贱。
	*
	* 重命名（renamePath）：**端点待实测**——真实页面上手动改一次名、抓包确认
	* 后再填进来；没填时 renameSession 直接返回 false（前缀改名退化为纯账本模式）。
	*/
	sessionApi: {
		verified: "deepseek-v1",
		list: true,
		listPath: "/api/v0/chat_session/fetch_page?count=50&page={page}",
		rowsPath: "data.biz_data.chat_sessions",
		morePath: "data.biz_data.has_more",
		delete: true,
		deletePath: "/api/v0/chat_session/delete",
		/** 实测（2026-10-20 抓包）：body 是 {"chat_session_ids":["<uuid>"]}——复数数组。 */
		deleteBodyShape: "ids-array",
		deleteIdsField: "chat_session_ids",
		method: "POST",
		rename: true,
		/** 实测（2026-10-20 抓包）：POST /api/v0/chat_session/update_title，body {"chat_session_id","title"}。 */
		renamePath: "/api/v0/chat_session/update_title",
		renameTitleField: "title"
	},
	reasoningEfforts: [{
		id: "off",
		name: "快速"
	}, {
		id: "medium",
		name: "思考"
	}],
	defaultReasoningEffort: "medium"
};
/** 内置 provider 表。新增站点在这里加一项即可。 */
const BUILTIN_PROVIDERS = [DEEPSEEK,
  {
    id: "yuanbao",
    name: "LDW · 元宝",
    homeUrl: "https://yuanbao.tencent.com/",
    urlPattern: "yuanbao\\.tencent\\.com",
    /**
     * 输入框（2026-10-16 CDP 实测）：Quill 编辑器 `div.ql-editor`，
     * placeholder 走 `data-placeholder="发送消息"`。
     */
    input: { selectors: ["div.ql-editor[contenteditable=\"true\"]", "div.ql-editor", "[contenteditable=\"true\"]"] },
    /**
     * ## ⚠️ 发送键：强制 Enter（enterOnly）
     *
     * CDP 实测（2026-10-16）：元宝的发送键**不在输入框附近的 6 层 DOM 里**，
     * 那个范围里全是陷阱按钮 —— 「添加」「切换模型」「AI 生图」「写作」
     * 「解题」「深度研究」「PPT 生成」「数据分析」「更多」。
     *
     * 几何打分在这种页面上**必然误点**：点「PPT 生成」会切模式，
     * 点「添加」会弹文件选择器，两个都是事故。
     *
     * 元宝是「Enter 发送」的交互，所以直接按 Enter —— 不收集任何按钮候选。
     */
    send: { selectors: [], signatures: [], vetoes: [], enterOnly: true },
    credentialInjection: { cookieUrl: "https://yuanbao.tencent.com/" },
    authProbe: { type: "dom", loggedOutSelectors: ["button.agent-dialogue__tool__login", ".hyc-phone-login__btn"], loggedInSelectors: ["div.ql-editor[contenteditable=\"true\"]"] },
    /**
     * ## 回复抓取（2026-10-16 CDP 实测补上）
     *
     * 之前是空数组 ⇒ `runJob` 的守卫直接拒绝发送
     * （「发出去也读不到回复，因此暂不发送」）—— 登录修好后这就是最后一道墙。
     *
     * 实测（两轮对话，发「你好」+「1+1等于几」）：
     *
     *   - 助手回复的稳定容器是 `div.hyc-common-markdown`
     *     （完整类名 `hyc-common-markdown hyc-common-markdown-style
     *     hyc-common-markdown--hyperlink-underline ...`，后缀会变，所以只锚前缀）
     *   - 节点数**随回复条数递增**：第 1 轮 1 个 → 第 2 轮 3 个 ✅
     *   - 用户的提问**不在**这个容器里（第 1 轮只有 1 个节点，就是助手那条），
     *     所以选择器天然只命中助手消息，不会把提问当成回复
     *
     * ⚠️ 元宝会**多答案并排**（第 2 轮实测出现两个 markdown：
     * 「1+1 等于 2。」和「1+1 等于 2～ 😊」，还夹着
     * `agent-chat__speech-text--multiple-answer-btn` 的「I prefer this answer」）。
     * 抓取逻辑取 `unique.at(-1)`（最后一个），拿到的是最后一条答案 —— 可接受。
     *
     * ⚠️ `stopSelectors` 留空是**有意的**：元宝没有稳定的「停止生成」按钮，
     * 硬填一个错的会让 `finished` 永远 false 而超时。空数组时 `finished`
     * 退化为 `text !== ''`，配合「文本稳定 3 次」判定 —— 元宝是整段吐出的，
     * 够用。
     */
    replyCapture: { type: "dom", replySelectors: ["div.hyc-common-markdown"], stopSelectors: [] },
    adapterStatus: "pending-validation",
    completionPath: "/",
    /**
    * ## 元宝双层菜单（2026-10-18 用户截图定案，第三批重做）
    *
    * 页面真实结构（截图实测）：
    *   - **模式层**（思考强度）：Instant（日常快答）/ Thinking（深度推理）/
    *     Expert（用工具跑任务）——右侧还有子层
    *   - **模型层**（Models 子菜单）：Hy4 preview（仅 Expert 模式）/
    *     Hy3（推荐日常）/ DeepSeek（适合深度思考）
    *
    * 所以：**模型条目 = Hy3/Hy4/DeepSeek**（pageModel = 模型子菜单项），
    * **思考强度 = Instant/Thinking/Expert**（pageMode = 模式层菜单项）。
    * 旧三件套（yuanbao-fast/think/expert）退役——它们把两层混在一层了。
    *
    * ⚠️ Hy4 约束（页面明示「Expert mode only」）：efforts 只有 expert 一档，
    * resolvedModelInfo 会按 spec.efforts 覆盖 provider 级档位。
    */
    models: [{
      id: "yuanbao-hy3",
      name: "LDW · 元宝 Hy3",
      description: "元宝模型 Hy3 —— 推荐日常使用",
      /** true 才会露出「思考强度」菜单（= 页面模式层）。行为由 pageModeFor 决定。 */
      thinking: true,
      pageModel: "Hy3"
    }, {
      id: "yuanbao-hy4",
      name: "LDW · 元宝 Hy4",
      description: "元宝模型 Hy4 preview —— 复杂任务（仅 Expert 模式）",
      thinking: true,
      pageModel: "Hy4",
      /** 页面限制：Hy4 只能配 Expert 模式。 */
      efforts: [{ id: "expert", name: "Expert" }],
      defaultReasoningEffort: "expert"
    }, {
      id: "yuanbao-deepseek",
      name: "LDW · 元宝 DeepSeek",
      description: "元宝模型 DeepSeek —— 适合深度思考（模式层：立即/思考）",
      thinking: true,
      pageModel: "DeepSeek",
      /**
      * 用户实测（2026-10-19）：元宝的 DeepSeek 档**只有「思考」和「立即」
      * 两个模式**——不是 Hy3 的三件套。模型级 efforts 覆盖平台级，
      * 菜单里就只有这两项。altNames 供页面英文时匹配。
      */
      efforts: [{
        id: "instant",
        name: "立即",
        altNames: ["Instant"]
      }, {
        id: "thinking",
        name: "思考",
        altNames: ["Thinking"]
      }],
      defaultReasoningEffort: "thinking"
    },
    /**
    * ## 旧 id 别名（2026-10-19「模型选择失败」事故）
    *
    * 用户会话里存着三代旧 id：yuanbao-fast/think/expert（第二批前）和
    * yuanbao-thinking/instant 等（探测缓存时代）。新清单只有 hy3/hy4/deepseek，
    * 旧 id 对不上 ⇒ DSH 报 `session/model-unavailable`，**不让他选**。
    * 别名条目让旧会话直接复通（pageModel 指向等价新档位）。
    */
    {
      id: "yuanbao-fast",
      name: "LDW · 元宝（旧·快速→Hy3）",
      description: "旧会话兼容别名：Hy3 + 快速回答",
      thinking: true,
      pageModel: "Hy3",
      legacy: true,
      efforts: [{ id: "instant", name: "快速回答", altNames: ["Instant"] }],
      defaultReasoningEffort: "instant"
    }, {
      id: "yuanbao-think",
      name: "LDW · 元宝（旧·深思→Hy3）",
      description: "旧会话兼容别名：Hy3 + 深度思考",
      thinking: true,
      pageModel: "Hy3",
      legacy: true
    }, {
      id: "yuanbao-expert",
      name: "LDW · 元宝（旧·专家→Hy3）",
      description: "旧会话兼容别名：Hy3 + 专家模式",
      thinking: true,
      pageModel: "Hy3",
      legacy: true,
      efforts: [{ id: "expert", name: "专家模式", altNames: ["Expert"] }],
      defaultReasoningEffort: "expert"
    }, {
      id: "yuanbao-thinking",
      name: "LDW · 元宝（旧·探测时代→Hy3）",
      description: "探测缓存时代残留 id：Hy3 + 深度思考",
      thinking: true,
      pageModel: "Hy3",
      legacy: true
    }],
    /**
    * 模式层 = 思考强度（与 DSH 的 effort 下拉同形）。
    * 2026-10-19 实测：元宝页面语言中英会变——名字带 altNames（另一语言名），
    * pageModeFor 返回「name|alt」串，_pickPanelItem 拨动时按任一语言前缀匹配。
    */
    reasoningEfforts: [{
      id: "instant",
      name: "快速回答",
      altNames: ["Instant"]
    }, {
      id: "thinking",
      name: "深度思考",
      altNames: ["Thinking"]
    }, {
      id: "expert",
      name: "专家模式",
      altNames: ["Expert"]
    }],
    defaultReasoningEffort: "thinking",
    contextWindow: 32768,
    maxOutputTokens: 8192,
  },
  {
    id: "doubao",
    name: "LDW · 豆包",
    homeUrl: "https://www.doubao.com/chat/",
    urlPattern: "(^|\\.)doubao\\.com$",
    /**
     * 输入框（2026-10-16 CDP 实测，**已改版**）。
     *
     * 旧配置写的 `textarea[data-testid="chat_input_input"]` **在现网已不存在**
     * （实测 `querySelector` 返回 null，直接导致发不出去）。
     * 现在真正的输入框是 **tiptap / ProseMirror 富文本层**：
     *
     *   `div.tiptap.ProseMirror[contenteditable="true"]`（实测 740×24、可见）
     *
     * 所以把 tiptap 放到**第一位**（首选），旧的 textarea 选择器降级保留作兜底
     * —— 万一豆包回滚版本，还能接住。
     */
    input: { selectors: ["div.tiptap.ProseMirror[contenteditable=\"true\"]", "div.ProseMirror[contenteditable=\"true\"]", "textarea[data-testid=\"chat_input_input\"]", "div.tiptap[contenteditable=\"true\"]"] },
    /**
     * ## ⚠️ 发送键：强制 Enter（enterOnly）
     *
     * CDP 实测：豆包输入框附近 6 层内**没有发送键**，全是陷阱 ——
     * `upload_file_button`（上传）、`skill_bar_button_*`（PPT 生成 / 图像生成 /
     * 帮我写作 / 视频生成 / 录音转写 / 音乐生成）、`chat_input_action_mode`（对话）、
     * `chat_input_action_model`（豆包 快速）。
     *
     * 几何打分点中 `录音转写` 会开始录音、点 `upload_file_button` 会弹文件框，
     * 所以直接按 Enter，不碰按钮。
     */
    send: { selectors: [], signatures: [], vetoes: [], enterOnly: true },
    /**
     * 登录探针（2026-10-16 实测修正）。
     *
     * `loggedInSelectors` 原来写的是 `textarea[data-testid="chat_input_input"]`
     * —— 那个元素**已随改版消失**，于是**登录着也会被判成未登录**。
     * 换成实测存在的 tiptap 输入层。
     */
    credentialInjection: { cookieUrl: "https://www.doubao.com/" },
    authProbe: { type: "dom", loggedOutSelectors: ["button[class*=\"login\"]"], loggedInSelectors: ["div.tiptap.ProseMirror[contenteditable=\"true\"]", "div.ProseMirror[contenteditable=\"true\"]", "textarea[data-testid=\"chat_input_input\"]"] },
    /**
     * ## 回复抓取（2026-10-16 CDP 实测补上）
     *
     * 之前是空数组 ⇒ `runJob` 守卫直接拒发。
     *
     * 实测（发「斑马为什么有条纹」「企鹅会飞吗」两轮）：
     *
     *   - 助手回复容器是 `div.md-box-root`（**类名带哈希后缀**，
     *     完整是 `container-qX9Csx md-box-root`，哈希每次构建都变，
     *     所以只锚**稳定前缀** `md-box`）
     *   - 计数实测 = 2：用户消息 1 个 + 助手回复 1 个
     *   - 取 `at(-1)`（最后一个）正好是助手回复，实测文本
     *     「企鹅不会飞。它们的翅膀已经演化成短而硬的鳍状肢…」✅
     *
     * ⚠️ 为什么不用 `v_list_row`（也是 4 个可见节点）：那个类名下面
     * 「最后一个」实测**取到空文本**（滚动容器的虚拟行），不可靠。
     *
     * ⚠️ `stopSelectors` 留空是有意的 —— 豆包没有稳定的「停止生成」按钮，
     * 乱填会让 `finished` 永远 false。空数组时退化为「文本稳定 3 次」判定，
     * 实测豆包是整段吐出的，够用。
     */
    /**
     * ⚠️ 豆包的**用户气泡和 AI 气泡共用 `md-box-root`**（2026-10-17 真机）：
     * 只按 `[class*=md-box]` 取最后一个，会把用户自己发的那条当成回复。
     * 用户气泡的祖先带 `flex justify-end`（右对齐），据此排除。
     */
    replyCapture: {
      type: "dom",
      replySelectors: ["[class*=\"md-box\"]"],
      replyExcludeSelectors: ["[class*=\"justify-end\"]"],
      stopSelectors: [],
    },
    adapterStatus: "pending-validation",
    completionPath: "/",
    /**
    * ## 豆包双模式（2026-10-18，用户点名「豆包有工作模式和聊天模式」）
    *
    * 豆包页面有「聊天 / 工作」两个模式入口。这里内置两个模型条目，
    * pageModel 按页面原文匹配（applyPageModel 里 startsWith 匹配）。
    * 页面若改版/加档位，用设置页「识别模型清单」重新探测即可——
    * 探测结果会叠在这两个内置条目之上（mergeModels）。
    */
    models: [{
      id: "doubao-chat",
      name: "LDW · 豆包（聊天模式）",
      description: "豆包页面「聊天」模式 —— 日常问答（可选思考强度）",
      /** 用户点名：聊天模式也能选思考强度 ⇒ thinking:true 才露出强度菜单。 */
      thinking: true,
      pageMode: "聊天"
    }, {
      id: "doubao-work",
      name: "LDW · 豆包（工作模式）",
      description: "豆包页面「工作」模式 —— 任务、工具、长文档（可选思考强度）",
      thinking: true,
      pageMode: "工作"
    }, {
      /** 旧 id 别名（2026-10-19 同案）：第一批时代的 doubao-fast。 */
      id: "doubao-fast",
      name: "LDW · 豆包（旧·快速→聊天）",
      description: "旧会话兼容别名 → 聊天模式",
      thinking: true,
      pageMode: "聊天",
      legacy: true
    }],
    /**
    * 思考强度（2026-10-18）：豆包的思考是输入框旁的开关，
    * buildThinkingScript 的关键词（思考/think/reason）能命中它。
    * 与 DeepSeek 同形：off = 快，medium = 开思考。
    */
    reasoningEfforts: [{
      id: "off",
      name: "快速"
    }, {
      id: "medium",
      name: "思考"
    }],
    defaultReasoningEffort: "medium",
    contextWindow: 32768,
    maxOutputTokens: 8192,
  },
];
/** 默认 provider（首个内置项）。 */
const DEFAULT_PROVIDER_ID = DEEPSEEK.id;
/**
* Provider 运行时校验。
*
* TS 类型运行时被擦除，"必须实现接口"的真正强制靠这个函数
* （cuckoo 的 `validate.ts` 做同样的事）。用户自定义 provider 也必须过。
*/
function validateProvider(p) {
	if (p === null || typeof p !== "object") return "必须是对象";
	const o = p;
	if (typeof o.id !== "string" || o.id === "") return "缺少 id";
	if (!/^[A-Za-z0-9_-]{1,64}$/.test(o.id)) return "id 只允许字母数字下划线连字符（它会用作 workspace 名）";
	if (typeof o.name !== "string" || o.name === "") return "缺少 name";
	if (typeof o.homeUrl !== "string" || !/^https?:\/\//.test(o.homeUrl)) return "homeUrl 必须是 http(s) URL";
	if (typeof o.urlPattern !== "string" || o.urlPattern === "") return "缺少 urlPattern";
	try {
		new RegExp(o.urlPattern);
	} catch {
		return "urlPattern 不是合法正则";
	}
	const input = o.input;
	if (input === void 0 || !Array.isArray(input.selectors) || input.selectors.length === 0) return "input.selectors 必须是非空数组";
	const send = o.send;
	/**
	* 发送选择器允许为空 —— **仅限未验证的 provider**（2026-10-16）。
	*
	* 为什么放行：`buildTriggerScript` 本来就有两层兜底（输入框往上 6 层找
	* 按钮 + 几何/标签打分 + Enter 兜底），所以「没有语义选择器」≠「发不出去」，
	* 只是**还没验证过**。旧规则一律拒空数组，导致元宝/豆包这两个刚加进来的
	* 平台**被校验器直接跳过、根本没注册成 provider** —— 用户在设置页里
	* 完全看不到它们（真实 bug，加载冒烟测试抓到的）。
	*
	* 已验证的 provider 仍然必须给选择器：那是「实测过能用」的标志，
	* 空着就说明配置没写完，宁可报错也别上线。
	*/
	const pendingValidation = o.adapterStatus === "pending-validation";
	if (send === void 0 || !Array.isArray(send.selectors)) return "send.selectors 必须是数组";
	if (send.selectors.length === 0 && !pendingValidation) return "send.selectors 必须是非空数组（未验证 provider 可标记 adapterStatus=pending-validation）";
	if (typeof o.completionPath !== "string" || o.completionPath === "") return "缺少 completionPath";
	if (!Array.isArray(o.models)) return "models 必须是数组";
	if (o.models.length === 0 && o.adapterStatus !== "pending-validation") return "models 必须是非空数组（未验证 provider 可标记 adapterStatus=pending-validation）";
	for (const m of o.models) {
		if (typeof m.id !== "string" || m.id === "") return "models[].id 必须是非空字符串";
		if (typeof m.name !== "string" || m.name === "") return "models[].name 必须是非空字符串";
	}
	if (typeof o.contextWindow !== "number" || o.contextWindow <= 0) return "contextWindow 必须是正数";
	if (typeof o.maxOutputTokens !== "number" || o.maxOutputTokens <= 0) return "maxOutputTokens 必须是正数";
	for (const [src] of send.signatures ?? []) try {
		new RegExp(src);
	} catch {
		return `send.signatures 里有非法正则：${src}`;
	}
	for (const src of send.vetoes ?? []) try {
		new RegExp(src);
	} catch {
		return `send.vetoes 里有非法正则：${src}`;
	}
	return null;
}
/**
* Provider 注册表。
*
* 语义：**内置打底，自定义覆盖**（按 id 匹配）。用户改坏了某个 provider 时
* 只跳过那一条，不影响其它 —— 内置的仍然可用。
*/
var ProviderRegistry = class {
	builtins;
	customs = /* @__PURE__ */ new Map();
	constructor(builtins = BUILTIN_PROVIDERS) {
		this.builtins = builtins.filter((p) => {
			const err = validateProvider(p);
			if (err !== null) {
				console.warn("[dsh-webin] 内置 provider 校验失败，跳过:", p?.id ?? "?", err);
				return false;
			}
			return true;
		});
	}
	/**
	* 装入用户自定义 provider（覆盖同 id 的内置项）。
	*
	* @returns 被接受的 id 与拒绝原因
	*/
	loadCustom(raw) {
		const accepted = [];
		const rejected = [];
		raw.forEach((item, index) => {
			const err = validateProvider(item);
			if (err !== null) {
				rejected.push({
					index,
					reason: err
				});
				return;
			}
			const p = item;
			this.customs.set(p.id, p);
			accepted.push(p.id);
		});
		return {
			accepted,
			rejected
		};
	}
	/** 全部 provider：自定义优先（同 id 覆盖内置）。 */
	all() {
		const out = [];
		const seen = /* @__PURE__ */ new Set();
		for (const p of this.customs.values()) {
			out.push(p);
			seen.add(p.id);
		}
		for (const p of this.builtins) {
			if (seen.has(p.id)) continue;
			out.push(p);
		}
		return out;
	}
	/** 按 id 取；找不到回退到默认 provider。 */
	get(id) {
		const list = this.all();
		const hit = list.find((p) => p.id === id);
		if (hit !== void 0) return hit;
		const fallback = list.find((p) => p.id === DEFAULT_PROVIDER_ID) ?? list[0];
		if (fallback === void 0) throw new Error("dsh-webin: 没有任何可用 provider");
		return fallback;
	}
	/** 按 URL 识别所属 provider（页面导航后用）。 */
	byUrl(url) {
		if (url === "") return void 0;
		for (const p of this.all()) try {
			if (new RegExp(p.urlPattern).test(url)) return p;
		} catch {}
	}
	/** 自定义覆盖了哪些内置 id（设置页显示用）。 */
	overriddenIds() {
		const builtinIds = new Set(this.builtins.map((p) => p.id));
		return [...this.customs.keys()].filter((id) => builtinIds.has(id));
	}
};
//#endregion
//#region src/host/tool-protocol.ts
/**
* 平台信息（抄 cuckoo 的 `buildPlatformInfo()`）。
*
* ## 为什么要自己补（实测确认 DSH 没给）
*
* 解压 `~/.dsh/sessions/*.jsonl.zstd` 读 `role:'system'` 消息（5943 字符），
* 里面**只提到一次 Windows**，而且是讲 exit code 语义：
*
* > On Windows a killed process settles as `[exit code: 1]` …
*
* **没有** cuckoo 那种「命令差异」说明。而模型最容易犯的错就是
* 在 Windows 上写 Unix 命令（`ls` / `cat` / `pwd`），或在 pwsh 里用 bash 语法。
*
* cuckoo 的原文（`prompt-builder.ts:76`）：
*
* > - 操作系统：Windows（x64）
* >   - bash 使用 cmd.exe（Windows 命令：cd / dir / echo %cd% / type / findstr）
* >   - pwsh 使用 PowerShell（Get-Location / $env:VAR / Get-ChildItem）
* >   - 路径分隔符为反斜杠 \，传给工具的相对路径统一用正斜杠 /
*
* ⚠️ 只在**首轮**带（与工具目录同一个段），后续轮不重复。
*/
function buildPlatformInfo(platform, arch) {
	if (platform === "win32") return [
		"- 操作系统：Windows（" + arch + "）",
		"  - bash 用 cmd.exe 语法：cd / dir / echo %cd% / type / findstr",
		"  - pwsh 用 PowerShell 语法：Get-Location / $env:VAR / Get-ChildItem",
		"- 路径分隔符是反斜杠 \\，传给工具的相对路径统一用正斜杠 /"
	].join("\n");
	if (platform === "darwin") return [
		"- 操作系统：macOS（" + arch + "）",
		"  - bash 用 zsh/bash：pwd / ls / cat / grep",
		"- 路径分隔符是正斜杠 /"
	].join("\n");
	return [
		"- 操作系统：Linux（" + arch + "）",
		"  - bash 用 bash：pwd / ls / cat / grep",
		"- 路径分隔符是正斜杠 /"
	].join("\n");
}
/**
* 工具调用协议指令。
*
* 刻意**只讲怎么调**，不讲身份/原则 —— 本插件在 adapter 位置，
* system 由 DSH 提供（实测会话里有 3 条 `role:'system'` 消息，5943 字符）。
* cuckoo 的模板是完整系统提示词（含身份、核心原则、项目信息），
* 那部分在这里是**重复且冲突**的（详见 `docs/project-init-compare.md`）。
*/
const TOOL_PROTOCOL = [
	"# 工具调用协议",
	"",
	"你可以调用工具来完成任务。需要调用时，把 JavaScript 代码放进以 ```ldw 开头、以 ``` 结尾的代码块，**代码块外不要有任何文字**：",
	"",
	"```ldw",
	"const r = await read({\"path\": \"src/index.ts\"});",
	"log(r);",
	"```",
	"",
	"规则：",
	"1. 参数写成 **JSON 对象**：`await 工具名({\"参数名\": 值})`。",
	"2. **多行文本用反引号模板字符串，直接换行，不要做任何转义**（不要写 \\n）。",
	"3. **只用上面这一种格式**。不要输出 DSML 标记、XML/HTML 标签、或 JSON 形式的工具调用",
	"   —— 那些形式**不会被识别**，只会原样显示给用户（看起来像乱码）。",
	"   也不要对字符串做 JSON 转义。**不要用 [调用工具 …] 或 const r = await 之类的伪代码当正文**——那不会被识别。",
	"4. 一次只调一个工具；等结果回来再决定下一步。",
	"5. 不要编造工具名或参数名；不确定就先用 `read` 或 `pwsh` 查。",
	"6. 不需要工具时，直接用普通文字回答，**不要**输出代码块。",
	"7. 工具结果是真实的，直接基于结果继续，不要自己模拟输出。",
	"8. **查记忆/知识库时例外**：需要检索跨会话记忆（知识库、对话档案）时，",
	"   不要写代码块——**直接用自然语言说出这句话**：",
	"   「我要调动第一层知识库，搜索XX」（结论卡片）",
	"   「我要调动第二层知识库，搜索XX」（原始对话原文）",
	"   宿主会自动把它翻译成真正的检索调用。整条回复**只有这一句**，不要加别的。"
].join("\n");
/**
* 从 JSON Schema 生成可读签名（抄 cuckoo 的「`name(签名)`」形态）。
*
* 例：`pwsh({command: string, timeout?: number})`
*/
function buildToolSignature(tool) {
	const params = tool.parameters;
	const props = params?.properties ?? {};
	const required = new Set(Array.isArray(params?.required) ? params.required : []);
	const names = Object.keys(props);
	if (names.length === 0) return `${tool.name}()`;
	const parts = names.map((n) => {
		const spec = props[n];
		const type = typeof spec?.type === "string" ? spec.type : "any";
		return `${n}${required.has(n) ? "" : "?"}: ${type}`;
	});
	return `${tool.name}({${parts.join(", ")}})`;
}
/** 取描述首句（到第一个句末点），再按上限截断。 */
function firstSentence(text, limit) {
	const flat = text.replace(/\s+/g, " ").trim();
	const stop = flat.search(/[.。](\s|$)/);
	const s = stop >= 0 ? flat.slice(0, stop + 1) : flat;
	return s.length > limit ? `${s.slice(0, limit)}…` : s;
}
/** 单条工具目录条目的描述上限（抄 cuckoo 的「一行」形态）。 */
const TAIL_DESC_CHARS = 160;
/**
* 工具目录（**抄 cuckoo 的格式**）。
*
* cuckoo 的 `ToolRegistry.getFormattedJsApiForPrompt()`：
*
* ```ts
* return descriptions.map((t, i) => {
*   const sig = '`' + t.jsApi + '`';
*   return (i + 1) + '. ' + sig + ' — ' + t.description;
* }).join('\n');
* ```
*
* 即「`1. \`read(path)\` — 读取文件`」一行一个工具。
*
* ⚠️ **cuckoo 对所有工具都是这个粒度**，没有核心/长尾之分 ——
* 所以本插件也不分级（用户明确要求只参考 cuckoo）。
* 实测体量：60 个工具 × 约 80 字符 ≈ 5,000 字符（对比 web-login 的 5 万）。
*/
function buildToolCatalog(tools) {
	if (tools.length === 0) return "";
	/**
	* ## 自然语言化目录（2026-10-21 用户点名）
	*
	* 用户原话：「工具介绍里都不该出现英文原文工具名字，调用工具也该少用括号等等标点符号」
	* ——降低机器特征。
	*
	* 变化：
	*   - 旧格式：`1. \`read({path: string})\` — 读取文件`
	*   - 新格式：`1. 读取文件 —— 调用时说：read 参数 path`（签名行内少括号）
	*
	* ⚠️ 工具名本身不能删（调用时 ```ldw 块里必须写对名字才识别），
	* 但把它从醒目的「反引号签名」降到行尾的普通词，去掉括号/冒号堆砌。
	*/
	return tools.map((t, i) => {
		const desc = firstSentence(t.description, TAIL_DESC_CHARS);
		const params = t.parameters;
		const props = params?.properties ?? {};
		const required = new Set(Array.isArray(params?.required) ? params.required : []);
		const names = Object.keys(props);
		/** 参数行：「参数 path 必填 / 参数 limit 可选」——无括号无冒号类型。 */
		const paramText = names.length === 0 ? "" : names.map((n) => `参数${n}${required.has(n) ? "必填" : "可选"}`).join("，");
		const line = `${i + 1}. ${desc}${paramText ? ` — ${paramText}` : ""} — 调用时写 ${t.name}`;
		return line;
	}).join("\n");
}
/**
* 拼出首轮要带的工具段（协议 + 目录 + 平台信息）。
*
* ⚠️ **只在首轮带**（与差分发送一致）：后续轮只发增量，
* 不重复这段 —— 否则每轮都多几千字符，直接推高单次请求体量。
*
* ## 为什么不带「项目目录」「项目介绍」
*
* 实测确认 DSH 已经给了（详见 `docs/project-init-compare.md`）：
*   - **项目目录**：system 末尾有 `Your working directory is …`
*   - **项目介绍**：`AGENTS.md` 由 `dsh-agent-instructions` 作为
*     **user 消息**注入（带 `<system-reminder>` 包裹），
*     会原样进入 `options.messages`，本插件自动带上
*
* 重复注入 = 白占体量，而体量是封号风险的主要嫌疑（参考实现实测记录）。
*
* @param tools - DSH 下发的工具清单
* @param platform - `process.platform` 的值（默认取宿主）
* @param arch - `process.arch` 的值
*/
function buildToolSection(tools, platform, arch) {
	if (tools.length === 0) return "";
	const catalog = buildToolCatalog(tools);
	const plat = buildPlatformInfo(platform ?? process.platform, arch ?? process.arch);
	return [
		TOOL_PROTOCOL,
		"",
		"# 运行环境",
		"",
		plat,
		"",
		"# 可用工具",
		"",
		catalog
	].join("\n");
}
/**
* 宽松修复一个「像 JSON 但不太标准」的对象字面量。
*
* 模型常见的四种走样（按出现频率）：
*   1. 键没加引号：`{path: "x"}` → `{"path": "x"}`
*   2. 单引号字符串：`{'path': 'x'}` → `{"path": "x"}`
*   3. **反引号模板字符串**：`` {"command": `Get-ChildItem\n…`} ``
*      —— 这是 cuckoo 协议**明确要求**的写法（「多行文本一律使用反引号
*      模板字符串，直接换行，不需要任何转义」），所以是主路径，必须支持
*   4. 尾逗号：`{"a": 1,}` → `{"a": 1}`
*
* 修复是**保守的**：只做上面四种，改不动就返回 null（交给位置参数兜底）。
*/
function repairJsonObject(raw) {
	let s = raw.trim();
	if (!s.startsWith("{") || !s.endsWith("}")) return null;
	s = s.replace(/([{,]\s*)([A-Za-z_$][\w$]*)(\s*:)/g, "$1\"$2\"$3");
	/**
	* 2) 单引号 → 双引号；3) 反引号模板字符串 → 双引号字符串。
	*
	* 逐个字符扫描，避免动到字符串内部的撇号。
	*
	* ⚠️ **模板字符串里的换行必须转成 `\n`** —— JSON 不允许字符串里有真实换行。
	* cuckoo 协议让模型「直接换行，不做转义」，所以这里必须替模型做这一步。
	* 双引号与反斜杠也要转义。
	*/
	let out = "";
	let inSingle = false;
	let inDouble = false;
	let inBacktick = false;
	for (let i = 0; i < s.length; i += 1) {
		const c = s[i];
		if (inBacktick) {
			if (c === "\\") {
				const next = s[i + 1] ?? "";
				out += next === "`" ? "`" : `\\${next}`;
				i += 1;
				continue;
			}
			if (c === "`") {
				inBacktick = false;
				out += "\"";
				continue;
			}
			if (c === "\"") {
				out += "\\\"";
				continue;
			}
			if (c === "\n") {
				out += "\\n";
				continue;
			}
			if (c === "\r") continue;
			if (c === "	") {
				out += "\\t";
				continue;
			}
			out += c;
			continue;
		}
		if (c === "\\") {
			out += c + (s[i + 1] ?? "");
			i += 1;
			continue;
		}
		if (c === "\"" && !inSingle) {
			inDouble = !inDouble;
			out += c;
			continue;
		}
		if (c === "'" && !inDouble) {
			inSingle = !inSingle;
			out += "\"";
			continue;
		}
		if (c === "`" && !inDouble && !inSingle) {
			inBacktick = true;
			out += "\"";
			continue;
		}
		out += c;
	}
	if (inSingle || inDouble || inBacktick) return null;
	s = out;
	s = s.replace(/,(\s*[}\]])/g, "$1");
	try {
		JSON.parse(s);
		return s;
	} catch {
		return null;
	}
}
/** 从 `start` 位置的 `(` 开始找配对的 `)`，返回括号内内容。 */
function balancedParens(text, openIndex) {
	let depth = 0;
	let inString = null;
	for (let i = openIndex; i < text.length; i += 1) {
		const c = text[i];
		if (inString !== null) {
			if (c === "\\") {
				i += 1;
				continue;
			}
			if (c === inString) inString = null;
			continue;
		}
		if (c === "\"" || c === "'" || c === "`") {
			inString = c;
			continue;
		}
		if (c === "(") depth += 1;
		else if (c === ")") {
			depth -= 1;
			if (depth === 0) return {
				body: text.slice(openIndex + 1, i),
				end: i + 1
			};
		}
	}
	return null;
}
/** 用 schema 的属性顺序，把位置参数映射成对象。 */
function positionalToObject(schema, body) {
	if (schema === void 0) return null;
	const params = schema.parameters;
	const names = Object.keys(params?.properties ?? {});
	if (names.length === 0) return null;
	const parts = [];
	let depth = 0;
	let cur = "";
	let inString = null;
	for (let i = 0; i < body.length; i += 1) {
		const c = body[i];
		if (inString !== null) {
			cur += c;
			if (c === "\\") {
				cur += body[i + 1] ?? "";
				i += 1;
				continue;
			}
			if (c === inString) inString = null;
			continue;
		}
		if (c === "\"" || c === "'" || c === "`") {
			inString = c;
			cur += c;
			continue;
		}
		if (c === "{" || c === "[") depth += 1;
		if (c === "}" || c === "]") depth -= 1;
		if (c === "," && depth === 0) {
			parts.push(cur.trim());
			cur = "";
			continue;
		}
		cur += c;
	}
	if (cur.trim() !== "") parts.push(cur.trim());
	if (parts.length === 0 || parts.length > names.length) return null;
	const obj = {};
	for (let i = 0; i < parts.length; i += 1) {
		let v = parts[i];
		if (!/^["'{[]/.test(v) && !/^(true|false|null|-?\d)/.test(v)) v = JSON.stringify(v);
		else if (v.startsWith("'")) v = `"${v.slice(1, -1)}"`;
		try {
			obj[names[i]] = JSON.parse(v);
		} catch {
			return null;
		}
	}
	return JSON.stringify(obj);
}
/**
* 从模型回复里解析工具调用。
*
* @param reply - 模型回复的**完整文本**（含可能的代码块）
* @param tools - 本轮下发的工具清单（用于校验名字、位置参数兜底）
*/
/**
* ## ⭐⭐⭐ 剥离 DSML 工具调用标记
*
* ## 用户实测
*
* 「DSML 怎么也出来了？」—— 回复里整段漏出了网页版的**原生工具调用语法**。
*
* ## 背景
*
* 网页版的模型自带一套工具调用标记（DSML），形如
*
*     <｜tool_calls｜> ... <｜/tool_calls｜>
*
* 标签名用全角竖线 ｜ (U+FF5C) 包裹。
*
* 插件用的是**自己的** ```ldw 围栏协议，但模型有时会改用网页版原生的 DSML ——
* 而插件此前完全不认识它 ⇒ 整段标记原样进入 text ⇒ 漏进 DSH 对话。
*
* ## 处理
*
* - 整块 DSML 调用**删掉**：它描述的是模型想调用的工具，插件执行不了
*   （工具由 DSH 执行，插件只负责把 ```ldw 围栏交给 DSH 解析）
* - 散落的单个 DSML 标签也删掉
* - 返回剥离计数，便于在诊断里观察出现频率
*/
function stripDsml(reply) {
	let stripped = 0;
	let out = reply;
	/**
	* 形态容错：`<` 之后允许「任意数量的竖线 / DSML 字样」，但**至少要有一个竖线**。
	*
	* 上一版写成「两组竖线夹一个可选 DSML」—— 那样只匹配双竖线形态，
	* **单竖线形态（`<|tool_calls|>`）匹配不上**（实测确认）。
	*
	* 同时「至少一个竖线」这个约束不能丢：否则 `<div>` 也会被当成 DSML 吃掉。
	*/
	const OPEN = "<(?:DSML|[｜|])*[｜|](?:DSML|[｜|])*";
	/** Whole tool-call block: from <..calls..> through <../..calls..>. */
	const block = new RegExp(OPEN + "[^>]*tool_calls[^>]*>[\\s\\S]*?" + OPEN + "\\/[^>]*tool_calls[^>]*>", "gi");
	out = out.replace(block, () => {
		stripped += 1;
		return "";
	});
	/** Stray single tags: <..anything..>. */
	const tag = new RegExp(OPEN + "[^>]{0,60}>", "g");
	out = out.replace(tag, () => {
		stripped += 1;
		return "";
	});
	return {
		text: out,
		stripped
	};
}
function parseToolCalls(reply, tools) {
	const byName = new Map(tools.map((t) => [t.name, t]));
	const calls = [];
	const failed = [];
	let text = "";
	/**
	* ⭐ 先剥离 DSML —— 模型有时会用网页版原生的工具调用语法而不是我们的
	* ```ldw 围栏。不剥的话整段标记会漏进可见回复（用户实测报过）。
	*/
	const dsml = stripDsml(reply);
	if (dsml.stripped > 0) failed.push(`（已剥离 ${dsml.stripped} 处 DSML 工具标记 —— 模型用了网页版原生语法，插件无法执行）`);
	let rest = dsml.text;
	/**
	 * ## ⭐ 兼容「忘了写围栏」的工具调用（2026-10-17 真机实测）
	 *
	 * 模型有时只写一行：
	 *
	 *     ldw const r = await read({"file_path":"README.md"}); log(r);
	 *
	 * 既没有 ``` 围栏、也没有换行。而下面只认 ```ldw + 换行，
	 * 于是这段被当**普通文字**返回 —— 工具不执行，用户看到的是
	 * 「调用没生效」，甚至整轮空回复。
	 *
	 * 这里补一次归一化：整段以 `ldw ` 开头、且全文没有任何围栏时，
	 * 直接包成标准块再走原解析器。有围栏的一律不动，避免二次包裹。
	 */
	if (!rest.includes("```")) {
		/**
		 * ⚠️ 真机实测（2026-10-17，session-96a8ffe8）模型回的是：
		 *
		 *     ldw
		 *     const r = await pwsh({...});
		 *     log(r);
		 *
		 * 也就是 `ldw` 后面跟的是**换行**，不是空格。
		 * 上一版只允许 `[ \t]+`，因此完全没匹配上 —— 这就是「改了还是不行」的原因。
		 * 现在空格、制表符、换行都接受。
		 */
		const bare = rest.match(/^\s*ldw\b[ \t]*\r?\n?([\s\S]+?)\s*$/i);
		if (bare !== null) rest = "```ldw\n" + bare[1] + "\n```";
	}
	for (;;) {
		const open = (/* @__PURE__ */ new RegExp("```[ \\t]*ldw[ \\t]*\\r?\\n", "i")).exec(rest);
		if (open === null) {
			text += rest;
			break;
		}
		text += rest.slice(0, open.index);
		const afterOpen = rest.slice(open.index + open[0].length);
		const closeIdx = afterOpen.search(/\r?\n[ \t]*```/);
		const block = closeIdx < 0 ? afterOpen : afterOpen.slice(0, closeIdx);
		rest = closeIdx < 0 ? "" : afterOpen.slice(closeIdx).replace(/^\r?\n[ \t]*```[ \t]*\r?\n?/, "");
		let found = 0;
		const callRe = /(?:await\s+)?([A-Za-z_$][\w$]*)\s*\(/g;
		let m;
		while ((m = callRe.exec(block)) !== null) {
			const name = m[1];
			const schema = byName.get(name);
			if (schema === void 0) continue;
			const paren = balancedParens(block, m.index + m[0].length - 1);
			if (paren === null) {
				failed.push(`${name}( … 括号不配对`);
				continue;
			}
			const body = paren.body.trim();
			let args = null;
			if (body === "") args = "{}";
			else if (body.startsWith("{")) args = repairJsonObject(body) ?? (() => {
				try {
					JSON.parse(body);
					return body;
				} catch {
					return null;
				}
			})();
			if (args === null) args = positionalToObject(schema, body);
			if (args === null) {
				failed.push(`${name}( ${body.slice(0, 60)} … 参数解析失败`);
				continue;
			}
			calls.push({
				name,
				arguments: args
			});
			found += 1;
			callRe.lastIndex = paren.end;
		}
		if (found === 0 && block.trim() !== "") {
			failed.push(block.trim().slice(0, 120));
			text += block;
		}
	}
	/**
	 * ## 别让「协议没对上」变成空回复
	 *
	 * 模型用网页版原生语法（DSML）时会被剥离，剥完正文可能是空的；
	 * 这时如果也不返回提示，用户就看到一条**什么都没有**的回复，
	 * 完全不知道发生了什么（真机实测 4 轮全空）。
	 */
	if (text.trim() === "" && calls.length === 0 && failed.length > 0) {
		return {
			text: `⚠️ 这一轮没能执行工具调用：${failed[0]}\n\n` +
				"网页版模型这次没有按 ```ldw 围栏协议输出（它可能用了网页版自带的工具语法）。" +
				"请重发一次，或在设置里把「允许调用工具」关掉只用它聊天。",
			calls: [],
			failed
		};
	}
	return {
		text: text.trim(),
		calls,
		failed
	};
}
//#region src/host/serialize.ts
/**
* 消息序列化：DSH 的消息词汇 → 网页端能吃的文本。
*
* ## 实测的 DSH 消息形状（从 `~/.dsh/sessions/*.jsonl.zstd` 解压得到）
*
* 会话文件是**分帧 zstd**（每行一个 zstd 帧），解压后实测统计：
* `tool/result` 932 条、`tool/call` 916 条、`assistant/message` 828 条。
*
* content block 类型：`text` 1357 / `tool-call` 916 / `reasoning` 371 / `image` 1。
*
* **关键结论：`tool-result` 不是 content block**，而是 `role: 'tool'` 的独立消息：
*
* ```json
* { "role": "tool",
*   "toolCallId": "call_00_…",
*   "content": [{ "type": "text", "text": "…" }],
*   "isError": false }
* ```
*
* 而 `tool-call` 是 assistant 消息 content 里的块：
*
* ```json
* { "type": "tool-call", "id": "call_00_…", "name": "read_image",
*   "arguments": "{\"file_path\":\"C:\\\\…\"}" }
* ```
*
* ⚠️ `arguments` 是 **JSON 字符串**，不是对象。
*
* ## 为什么 reasoning 不回灌
*
* cuckoo 是 harness，每轮只发新消息，不重发历史。
* 本插件虽在 adapter 位置，但差分发送的效果一样：**只发增量**。
* 思考内容回灌到网页端有两个坏处（参考实现实测记录）：
*   1. 思考区出现转义标记/协议残留，用户一眼看出不是人；
*   2. 那团垃圾留在转写里，每轮重发 —— 真正让对话不像人的地方。
* 所以 reasoning 只给 DSH 侧展示，**不进网页 prompt**。
*/
/** 单条工具结果的文本上限（防止一次读大文件把 prompt 顶爆）。 */
const TOOL_RESULT_LIMIT = 4e3;
/** 从 content 里抽出纯文本（text 块拼接）。 */
function contentToText(content) {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const parts = [];
	for (const b of content) {
		if (b === null || typeof b !== "object") continue;
		const block = b;
		if (block.type === "text" && typeof block.text === "string") parts.push(block.text);
	}
	return parts.join("\n");
}
/** 把 `arguments`（JSON 字符串）转成人类可读的参数文本。 */
function formatArguments(raw) {
	try {
		const obj = JSON.parse(raw);
		if (obj !== null && typeof obj === "object") return JSON.stringify(obj);
		return String(obj);
	} catch {
		return raw;
	}
}
/**
* 把 CRLF / CR 归一化成 LF。
*
* ## 为什么必须在**序列化**时就做（实测踩过的坑）
*
* 用户的报错：
*
*     fill-failed: 输入框类型不支持: native-setter-noop
*
* 「那一轮根本没发出去」。根因是 HTML 规范要求 `<textarea>` 的 value
* **必须把 `\r\n` 归一化成 `\n`**（HTML Standard, textarea value
* normalization）。而客户端填充后是**逐字符全等比较**来确认写入成功：
*
*     if (el.value !== value) return { ok: false, how: 'native-setter-noop' }
*
* 于是只要 prompt 里有一个 `\r\n`，写进去的值就和原始值不等 ——
* 明明写成功了却判定失败，整轮直接放弃。
*
* Windows 上 `pwsh` 的输出**全是 CRLF**，所以这个 bug 是**间歇性**的：
*   - 没跑过工具 ⇒ 正常
*   - 跑过一次工具（结果进了历史）⇒ 之后每一轮都失败
*
* 这正好解释「有时能用，用着用着就不行了」。
*
* 在**发出去之前**统一成 LF：网页版自己也是按 LF 处理的，
* 归一化不会丢信息，还让两边的比较口径一致。
*/
function normalizeNewlines(text) {
	return text.replace(/\r\n?/g, "\n");
}
/**
* 把一条 DSH 消息序列化成文本。
*
* @param msg - DSH 消息
* @param toolResultLimit - 工具结果截断上限（用户可在设置页调）
* @returns 要发出去的文本；空串表示这条不发。
*/
function serializeMessage(msg, toolResultLimit = TOOL_RESULT_LIMIT) {
	if (msg.role === "tool") {
		const body = normalizeNewlines(contentToText(msg.content)).trim();
		if (body === "") return "";
		const limit = Math.max(200, Math.round(toolResultLimit));
		const clipped = body.length > limit ? `${body.slice(0, limit)}\n…（结果过长已截断，共 ${body.length} 字符）` : body;
		return `【工具结果${msg.isError === true ? "（失败）" : ""}】\n${clipped}`;
	}
	const content = msg.content;
	const parts = [];
	if (Array.isArray(content)) {
		const calls = [];
		for (const b of content) {
			if (b === null || typeof b !== "object") continue;
			const block = b;
			if (block.type !== "tool-call") continue;
			const name = String(block.name ?? "");
			if (name === "") continue;
			const args = typeof block.arguments === "string" ? formatArguments(block.arguments) : "{}";
			calls.push(`${name}(${args})`);
		}
		if (calls.length > 0)
 /**
		* 把历史里的工具调用**文本化**成它当时的样子。
		*
		* 为什么要还原成 ```ldw 块而不是别的：模型在**下一轮**会看到
		* 「自己上次是怎么调的」，保持同一种形态能强化协议一致性。
		*/
		parts.push([
			"```ldw",
			...calls.map((c) => `await ${c};`),
			"```"
		].join("\n"));
	}
	const text = contentToText(content).trim();
	if (text !== "") parts.push(text);
	if (parts.length === 0) return "";
	/**
	* ## ⚠️⚠️ 不加 `## User` / `## Assistant` 角色标记（实测泄漏进页面）
	*
	* 真实事故（用户截图）：网页会话里出现「## User
	* 你能调用写工具吗？」—— 角色标记被当成**消息正文**渲染出来，
	* 用户在页面上看得清清楚楚。
	*
	* ## cuckoo 怎么做（照抄）
	*
	* cuckoo 的 `serializeMessages` **不加任何角色标记** —— 网页版的
	* 对话本身已经区分了角色（用户消息在输入框那侧、模型回复在页面流里），
	* 模型看得到完整上下文，不需要文本标记。加了反而：
	*   1. 泄漏进页面（用户看到的每条历史都带 ## 前缀）
	*   2. 浪费 token
	*   3. 模型可能模仿输出 `## Assistant` 开头
	*
	* tool 消息仍保留标记（工具结果需要标识来源），user/assistant 不加。
	*/
	if (msg.role === "tool") return `## Tool\n${parts.join("\n\n")}`;
	return parts.join("\n\n");
}
/**
* 把一批消息序列化成一段文本。
*
* 出口处**再归一化一次** —— 这样无论各分支出什么，发出去的一定是纯 LF。
* 单点收口比在每个分支里各写一遍可靠（漏一处就复发同一个 bug）。
*
* @param messages - DSH 的 messages（已按调用方要求切片）
*/
function serializeMessages(messages, toolResultLimit) {
	const out = [];
	for (const m of messages) {
		const s = serializeMessage(m, toolResultLimit);
		if (s !== "") out.push(s);
	}
	return normalizeNewlines(out.join("\n\n"));
}
//#endregion
//#region src/shared/config.ts
/** 每个数值字段的边界。超出即拒绝并说明原因。 */
const LIMITS = {
	sendDelayMinMs: {
		min: 0,
		max: 12e4,
		unit: "ms",
		label: "发送间隔下限"
	},
	sendDelayMaxMs: {
		min: 0,
		max: 3e5,
		unit: "ms",
		label: "发送间隔上限"
	},
	longBreakAfter: {
		min: 0,
		max: 500,
		unit: "次",
		label: "长休触发次数"
	},
	longBreakMinMs: {
		min: 0,
		max: 36e5,
		unit: "ms",
		label: "长休时长下限"
	},
	longBreakMaxMs: {
		min: 0,
		max: 72e5,
		unit: "ms",
		label: "长休时长上限"
	},
	maxRequestsPerTurn: {
		min: 0,
		max: 500,
		unit: "次",
		label: "单轮请求上限"
	},
	replyTimeoutMs: {
		min: 1e4,
		max: 36e5,
		unit: "ms",
		label: "等回复超时"
	},
	claimGraceMs: {
		min: 1e3,
		max: 6e5,
		unit: "ms",
		label: "无人领活宽限"
	},
	toolResultLimit: {
		min: 200,
		max: 2e5,
		unit: "字符",
		label: "工具结果截断"
	},
	snapshotIntervalMs: {
		min: 5e3,
		max: 36e5,
		unit: "ms",
		label: "快照保存间隔"
	}
};
/**
* 默认值。
*
* ⚠️ 这些数字**都有实测依据**，改之前先看注释：
*   - `sendDelay*`：参考实现实测「固定间隔 = 定时器特征」，用 2000~4000 随机
*   - `longBreakAfter: 0`（默认关）：参考对象没有长休机制，默认跟随
*   - `replyTimeoutMs: 600_000`：实测最慢一次网页回复 6 分 12 秒（压缩路径）
*   - `claimGraceMs: 20_000`：浏览器没打开时快速失败，不让用户干等 10 分钟
*   - `toolResultLimit: 4_000`：防止一次 `read` 大文件把 prompt 顶爆
*/
const DEFAULT_CONFIG = {
	sendDelayMinMs: 2e3,
	sendDelayMaxMs: 4e3,
	longBreakAfter: 0,
	longBreakMinMs: 6e4,
	longBreakMaxMs: 18e4,
	maxRequestsPerTurn: 0,
	replyTimeoutMs: 6e5,
	claimGraceMs: 2e4,
	toolResultLimit: 4e3,
	/**
	* ⚠️ 默认**开**（v3 定论）—— 一度错误地默认关，用户的实测推翻了它：
	*
	* 用户让模型「调用写工具写文件」，模型**明确按协议准备输出工具调用**
	* （"produce the tool call. Final content — here goes."）——
	* 是服务端把生成停了，**不是模型不支持**。
	*
	* 之前「网页版自有工具截胡」的结论也错了：模型说 "Let me write the
	* file with the write tool" 是在**描述 DSH 的工具**（write 是 DSH 的
	* 工具名），它确实打算输出协议 —— 循环能否跑通取决于协议有没有下发。
	*
	* 协议进页面会「可见」是真的，但那是模型输入的一部分（与 cuckoo 一致
	* —— cuckoo 也把工具目录发进网页），不是缺陷。
	*/
	enableTools: true,
	snapshotIntervalMs: 3e4,
	verboseLog: false,
	/**
	 * 压缩摘要的 .txt 出口模式。
	 *
	 * 网页输入框装不下大输入（>10 万字符就卡死/截断），但网页端可以上传
	 * .txt 附件 —— 压缩时把整段对话落盘成文件、塞进上传控件、发一条
	 * 「读取文件并摘要」的短指令，网页模型照样能完成全量压缩。
	 *
	 *   - "never"  ：保持旧行为，压缩请求直接拒绝（推荐配 HTTP provider）
	 *   - "auto"   ：序列化后 ≤ compactionFileThresholdChars 直接发，
	 *                 超过就走 .txt 上传（默认，两全）
	 *   - "always" ：压缩一律走 .txt 上传（用户手动勾选强制）
	 */
	compactionFileMode: "auto",
	/** auto 模式的直接发送阈值（字符）。超过即转 .txt 上传。 */
	compactionFileThresholdChars: 1e5,
	/**
	* LDW 网页端的压缩出口覆盖（2026-10-18 第三批）：
	* 空串 = 跟随全局 compactionFileMode；never/auto/always = LDW 专用，
	* 全局开关改不动它（分层：LDW 高于全局、不作用于全局）。
	*/
	ldwCompactionOverride: "",
	/**
	* 知识库自然语言协议全局开关（2026-10-19）：
	* 「我要调动第一层/第二层知识库，搜索xx」⇒ 翻译成真正的工具调用。
	* adapter-compat 的「压缩出口/知识库协议」折叠区写的就是这个键。
	* 默认开。
	*/
	kbProtocol: true,
	/**
	* 标题 LDW 前缀全局开关（2026-10-19 用户提醒「全局开关不要忘了」）：
	* 关掉后标题请求不再强制「LDW 」前缀（走 LDW 通道时）。默认开。
	*/
	titlePrefix: true,
	/**
	* 自然语言工具调用协议全局开关（2026-10-19 用户提出，见 translateToolUtterance）：
	* 「我要用工具XX，参数…」这类自然语言句式 ⇒ 翻译成 ```ldw 调用。
	* 默认关（保守）；开启后与 kbProtocol 同一拦截层工作。
	*/
	nlToolProtocol: false,
	/**
	* 大输入直接发送阈值（2026-10-19）：普通发送在 auto 出口模式下，
	* prompt 超过这个字符数就打包 .txt 附件上传（与压缩出口同阈值语义、
	* 独立可调）。默认 6000——再大就快顶到网页输入框的软上限了。
	*/
	directSendThresholdChars: 6000,
	/**
	* .txt 分段上传阈值（2026-10-19 用户点名）：附件超过这个字节数就切片逐段传（partN-ofM），
	* 每段传完点停（分段不需要 AI 回答）。默认 400KB；0 = 不分段。
	*/
	txtChunkBytes: 409600,
	/**
	* 纯聊天模式·全局开关（2026-10-21 用户定案「分段出口的、.txt出口、纯聊天模式
	* 都要全局弄上，不管实际用不用」）：API 通道的实际工具面由会话预设控制
	* （lite-chat），这个键是全局侧统一入口的存储位（adapter-compat 折叠区
	* 读写的就是它）。LDW 侧仍走 lite-chat 预设本体。默认关。
	*/
	chatOnly: false,
	/**
	* ## 开机自动唤醒指定账号（2026-10-18，用户点名）
	*
	* 「增加开机时是否自动启动某个账号的按钮。」
	*
	* 格式：`"平台#槽位"`（如 `"deepseek#主号"`、`"yuanbao#default"`）。
	* 留空 / 不在 ⇒ 不自动启动（保持旧行为）。
	*
	* 实现约束（都为了「不搞突然袭击」）：
	*   - **延迟启动**：插件起来后等 `autoWakeDelayMs`（默认 45s）再拉浏览器，
	*     避开 DSH 启动期的 CPU 高峰，也少一点「刚开机就自己开浏览器」的惊吓。
	*   - **失败静默**：起不来（没登录/没浏览器）只记日志，绝不重试轰炸。
	*   - **只在 edgeDriver 启用时工作**；桌面 webview 通道不受影响。
	*/
	autoWakeTarget: "",
	autoWakeDelayMs: 45e3
};
/** compactionFileMode 的合法值。 */
const COMPACT_MODES = ["never", "auto", "always"];
/**
* 校验并归一化一份配置。
*
* 规则：
*   - 未知字段**丢弃**（不写入，避免配置文件越长越乱）
*   - 数值超界 / 非数 ⇒ 回退默认并记一条 problem
*   - 布尔非真值 ⇒ 回退默认
*   - `min > max` 的成对字段 ⇒ 交换（用户填反了不必报错，纠正即可）
*/
function checkConfig(raw) {
	const problems = [];
	const out = { ...DEFAULT_CONFIG };
	if (raw === null || typeof raw !== "object") return {
		ok: false,
		config: out,
		problems: [{
			field: "(root)",
			reason: "不是对象",
			fellBackTo: "默认值"
		}]
	};
	const src = raw;
	for (const key of Object.keys(DEFAULT_CONFIG)) {
		const value = src[key];
		if (value === void 0) continue;
		const fallback = DEFAULT_CONFIG[key];
		/** 空串默认的字符串键（如 autoWakeTarget / ldwCompactionOverride）：原样收字符串。 */
		if (typeof fallback === "string" && fallback === "") {
			if (typeof value === "string") out[key] = value;
			else problems.push({
				field: key,
				reason: `应为字符串，收到 ${typeof value}`,
				fellBackTo: "（空）"
			});
			continue;
		}
		/** 枚举字符串字段（如 compactionFileMode）：合法值直接收，非法回退默认。 */
		if (typeof fallback === "string" && fallback !== "") {
			if (value === fallback || COMPACT_MODES.includes(value)) out[key] = value;
			else problems.push({
				field: key,
				reason: `不在可选值内（${JSON.stringify(value)}）`,
				fellBackTo: fallback
			});
			continue;
		}
		if (typeof fallback === "boolean") {
			if (typeof value === "boolean") out[key] = value;
			else problems.push({
				field: key,
				reason: `应为布尔，收到 ${typeof value}`,
				fellBackTo: fallback
			});
			continue;
		}
		const num = typeof value === "number" ? value : Number(value);
		const limit = LIMITS[key];
		if (!Number.isFinite(num)) {
			problems.push({
				field: key,
				reason: `不是有效数字（${String(value)}）`,
				fellBackTo: fallback
			});
			continue;
		}
		if (limit !== void 0 && (num < limit.min || num > limit.max)) {
			problems.push({
				field: key,
				reason: `${num} 超出范围 ${limit.min}~${limit.max}${limit.unit}`,
				fellBackTo: fallback
			});
			continue;
		}
		out[key] = Math.round(num);
	}
	/** compactionFileMode：枚举字符串，非法值回退 auto。 */
	{
		const v = src?.compactionFileMode;
		if (v !== void 0 && !["never", "auto", "always"].includes(v)) {
			problems.push({
				field: "compactionFileMode",
				reason: `应为 never/auto/always，收到 ${JSON.stringify(v)}`,
				fellBackTo: "auto"
			});
			out.compactionFileMode = "auto";
		}
	}
	/**
	* ## LDW 网页端压缩出口覆盖（2026-10-18 第三批，用户定案的分层）
	*
	* 「LDW 在自己的网页端的开关高于全局设置，但不作用于全局」
	*
	* `ldwCompactionOverride`（"never"/"auto"/"always"，空 = 跟随全局）：
	* 压缩请求走到 LDW 时，这个值**优先于** compactionFileMode ——
	* 全局（adapter-compat 写的）compactionFileMode 管 API 模型通道，
	* LDW 自己的出口由这个键独立控制、互不污染。
	*/
	{
		const v = src?.ldwCompactionOverride;
		if (v !== void 0 && v !== "" && !["never", "auto", "always"].includes(v)) {
			problems.push({
				field: "ldwCompactionOverride",
				reason: `应为 never/auto/always 或留空，收到 ${JSON.stringify(v)}`,
				fellBackTo: "（跟随全局）"
			});
			out.ldwCompactionOverride = "";
		}
	}
	/** 成对区间填反了就交换 —— 用户意图明确，不必报错。 */
	if (out.sendDelayMinMs > out.sendDelayMaxMs) {
		const t = out.sendDelayMinMs;
		out.sendDelayMinMs = out.sendDelayMaxMs;
		out.sendDelayMaxMs = t;
		problems.push({
			field: "sendDelayMinMs/Max",
			reason: "上下限填反了，已自动交换",
			fellBackTo: "交换后"
		});
	}
	if (out.longBreakMinMs > out.longBreakMaxMs) {
		const t = out.longBreakMinMs;
		out.longBreakMinMs = out.longBreakMaxMs;
		out.longBreakMaxMs = t;
		problems.push({
			field: "longBreakMinMs/Max",
			reason: "上下限填反了，已自动交换",
			fellBackTo: "交换后"
		});
	}
	/**
	* `edgeDriver` 是**嵌套对象**，不走上面那套「数字 / 布尔」的扁平校验。
	* 单独归一化：未知字段丢弃，类型不对回退默认。
	*
	* 默认值来自 `EDGE_DRIVER_DEFAULTS`（见 edge-driver.js），
	* 这样驱动器自己也能独立跑（不依赖 host 传全量配置）。
	*/
	out.edgeDriver = normalizeEdgeDriverConfig(src.edgeDriver, problems);
	/**
	* ## 多账号：`accounts` 嵌套对象（2026-10-16，用户点名要的）
	*
	* 形状：
	*
	*     accounts: {
	*       "deepseek": { slots: ["default", "work"], active: "default" },
	*       "qwen":     { slots: ["default"] }
	*     }
	*
	*   - `slots`：该平台的账号槽位名（安全字符，会成为 profile 子目录名
	*     与登录快照槽位名的一部分）。`"default"` 永远存在（首次使用前
	*     的默认身份）。
	*   - `active`：该平台**当前生效**的槽位 —— 派任务时带它，驱动器据此
	*     选 profile 目录，登录快照也按槽位隔离。没填就是 "default"。
	*
	* 存储策略与 edgeDriver 一致：坏形状**不报错**，回退空表（= 单账号），
	* 老配置文件没有这个字段 ⇒ 行为与旧版完全一致。
	*/
	out.accounts = normalizeAccountsConfig(src.accounts, problems);
	return {
		ok: problems.length === 0,
		config: out,
		problems
	};
}
/**
* 归一化 `edgeDriver` 配置块。
*
* 规则与主配置一致：未知字段丢弃、类型不对回退默认、数值超界回退默认。
* 但**不抛错** —— 配置坏了不能连累整个插件加载。
*/
function normalizeEdgeDriverConfig(raw, problems) {
	const out = { ...EDGE_DRIVER_DEFAULTS };
	if (raw === void 0 || raw === null) return out;
	if (typeof raw !== "object") {
		problems.push({
			field: "edgeDriver",
			reason: `应为对象，收到 ${typeof raw}`,
			fellBackTo: "默认值"
		});
		return out;
	}
	for (const key of Object.keys(EDGE_DRIVER_DEFAULTS)) {
		const value = raw[key];
		if (value === void 0) continue;
		const fallback = EDGE_DRIVER_DEFAULTS[key];
		if (typeof fallback === "boolean") {
			if (typeof value === "boolean") out[key] = value;
			else problems.push({ field: `edgeDriver.${key}`, reason: `应为布尔，收到 ${typeof value}`, fellBackTo: fallback });
			continue;
		}
		if (typeof fallback === "string") {
			if (typeof value === "string") out[key] = value;
			else problems.push({ field: `edgeDriver.${key}`, reason: `应为字符串，收到 ${typeof value}`, fellBackTo: fallback });
			continue;
		}
		const num = typeof value === "number" ? value : Number(value);
		if (!Number.isFinite(num) || num < 0) {
			problems.push({ field: `edgeDriver.${key}`, reason: `不是有效非负数字（${String(value)}）`, fellBackTo: fallback });
			continue;
		}
		out[key] = Math.round(num);
	}
	/** 端口必须是合法范围，否则 Edge 起不来。 */
	if (out.port < 1024 || out.port > 65535) {
		problems.push({ field: "edgeDriver.port", reason: `${out.port} 不是合法端口`, fellBackTo: EDGE_DRIVER_DEFAULTS.port });
		out.port = EDGE_DRIVER_DEFAULTS.port;
	}
	/**
	 * 会话回收模式必须是白名单值（或留空 = 跟随旧开关 `autoDeleteSessions`）。
	 *
	 * 为什么单独校验：上面按 `typeof fallback === "string"` 的分支只检查了
	 * **类型**，任意字符串都能过。而这里拼错一个字母（`dalay`）会导致
	 * `resolveMode` 回落到 `never` —— 用户以为开了延迟删除，实际一条都没删，
	 * 而且**悄无声息**。这种「静默失效」必须变成一条可见的 problem。
	 */
	if (out.sessionDeleteMode !== "" && !SESSION_DELETE_MODES.includes(out.sessionDeleteMode)) {
		problems.push({
			field: "edgeDriver.sessionDeleteMode",
			reason: `只允许 ${SESSION_DELETE_MODES.join(" / ")} 或留空，收到 "${out.sessionDeleteMode}"`,
			fellBackTo: "（空 = 跟随 autoDeleteSessions）"
		});
		out.sessionDeleteMode = "";
	}
	if (out.sendDelayMinMs > out.sendDelayMaxMs) {
		const t = out.sendDelayMinMs;
		out.sendDelayMinMs = out.sendDelayMaxMs;
		out.sendDelayMaxMs = t;
	}
	return out;
}
/**
* 归一化多账号配置块 `accounts`。
*
* 规则：
*   - 不是对象 ⇒ 空表（单账号行为），记一条 problem
*   - 每个平台条目必须是对象；`slots` 必须是字符串数组，元素过安全字符白名单
*     （`[A-Za-z0-9_-]`，因为会拼进文件路径）；空数组/非法元素丢弃
*   - `active` 必须是 slots 里的成员，否则回退 "default"
*   - "default" 槽位永远存在（隐式补全），active 缺省 "default"
*/
function normalizeAccountsConfig(raw, problems) {
	const out = {};
	if (raw === void 0 || raw === null) return out;
	if (typeof raw !== "object" || Array.isArray(raw)) {
		problems.push({
			field: "accounts",
			reason: `应为对象，收到 ${Array.isArray(raw) ? "array" : typeof raw}`,
			fellBackTo: "空表（单账号）"
		});
		return out;
	}
	for (const platformId of Object.keys(raw)) {
		if (!/^[A-Za-z0-9_-]{1,64}$/.test(platformId)) {
			problems.push({
				field: `accounts.${platformId}`,
				reason: "平台 id 含非法字符，忽略",
				fellBackTo: "跳过"
			});
			continue;
		}
		const entry = raw[platformId];
		if (entry === void 0 || entry === null || typeof entry !== "object") continue;
		/**
		 * 槽位白名单：会拼进 profile 目录与快照文件名，绝不允许路径逃逸。
		 *
		 * ⚠️ 被拒的槽位**必须报出来**（2026-10-16 修）。原来直接 `filter` 掉、
		 * 一点提示都没有 —— 用户写了个中文槽位名（如「奶奶」），保存后
		 * **静默消失**，只看到列表里没它，完全不知道为什么。
		 * 「静默失效」比报错难查十倍，所以这里必须留痕。
		 */
		const rawSlots = Array.isArray(entry.slots) ? entry.slots : [];
		/** ⚠️ 规则来自 slot-names.js（**支持中文**），不要内联正则。 */
		const dropped = rawSlots.filter((s) => !isSafeSlotName(s));
		if (dropped.length > 0) {
			problems.push({
				field: `accounts.${platformId}.slots`,
				reason: `${slotRuleText()}；已忽略：${dropped.map((s) => `「${String(s).slice(0, 32)}」`).join(" ")}`,
				fellBackTo: "跳过这些槽位"
			});
		}
		const slots = [...new Set(rawSlots.filter((s) => isSafeSlotName(s)))];
		/**
			 * ⚠️ 只在**没有任何槽位**时才补 default（2026-10-16 改）。
			 *
			 * 原来是无条件 unshift —— 用户把 default 从配置里删掉，
			 * 读配置时它又被塞回来，表现为「删不掉」。
			 * default 只是**空表时的兜底身份**；用户给平台起了自己的账号名之后，
			 * 不该再硬塞一个 default 进去。
			 */
			/**
			 * ⚠️ 空槽位**保持为空**（2026-10-17 用户要求：一来应该是 0 个账号）。
			 * 只有历史配置里本来就写了 default 的，才继续用 default。
			 */

		/** 兜底不是固定的 "default"，而是**槽位表里的第一个** —— 见上。 */
		/** 没槽位就没有 active（不再回落到虚构的 default）。 */
		let active = isSafeSlotName(entry.active) && slots.includes(entry.active) ? entry.active : (slots[0] ?? "");
		if (entry.active !== void 0 && active !== entry.active && slots.length > 0) {
			problems.push({
				field: `accounts.${platformId}.active`,
				reason: `active「${String(entry.active)}」不在 slots 里`,
				fellBackTo: active
			});
		}
		/**
		 * ⭐ 每个槽位可单独控制「是否出现在模型选择器里」（用户要求）。
		 * 缺省（无此字段）= 全部显示，与旧配置完全一致。
		 * 只保留**确实在 slots 里**的槽位名，免得留下了已经被删的槽位。
		 */
		const hidden = Array.isArray(entry.hiddenInModels)
			? [...new Set(entry.hiddenInModels.filter((s) => typeof s === "string" && slots.includes(s)))]
			: [];
		out[platformId] = hidden.length > 0 ? { slots, active, hiddenInModels: hidden } : { slots, active };
	}
	return out;
}
/**
 * 某平台的账号配置。
 *
 * ⚠️ **没配过就是「0 个账号」**，不再凭空造一个 default（2026-10-17 用户要求）。
 * 界面上应当是「还没有账号，去新增/登录」，而不是假装有个叫 default 的账号。
 *
 * 兼容：老配置里本来就有 default 槽位的，照旧工作（它就是用户自己的账号名）。
 */
function accountsForPlatform(accountsConfig, platformId) {
	const entry = accountsConfig?.[platformId];
	if (entry !== void 0) return entry;
	/**
	 * 没配置账号时：
	 *   - 若磁盘上**已经有**旧布局的档案（`edge-ldw/<平台>`），就如实报一个
	 *     「未命名账号」（名字是空串），让模型列表和历史登录继续可用，
	 *     并在设置页提示可以给它改名；
	 *   - 若连档案都没有 ⇒ **就是 0 个账号**，不凭空造一个。
	 */
	try {
		if (existsSync(edgeProfileDirFor(platformId, ""))) return { slots: [""], active: "" };
	} catch { /* 探不到就当没有 */ }
	return { slots: [], active: "" };
}
/**
* 某平台当前生效的账号槽位名。
*
* ⚠️ 每次现读配置 —— 用户在设置页切账号后要立刻生效，不能缓存。
* 派任务时用它决定 job.account。
*/
function activeAccountFor(platformId) {
	const entry = accountsForPlatform(readConfig().config.accounts, platformId);
	/**
	 * 没配置账号 → 返回 ""（**不是 "default"**）。
	 *
	 * 下游 `edgeProfileDirFor` / `slotNameFor` 对 "" 走「旧布局：平台目录」，
	 * 与历史数据兼容；同时队列/模型列表里不会再出现一个虚构的 default 账号。
	 */
	return typeof entry.active === "string" && entry.active !== "" ? entry.active : (entry.slots?.[0] ?? "");
}
/**
* 登录快照的槽位名：多账号时是 `平台#槽位`，单账号保持旧格式 `平台`
* （老快照文件不动，行为向后兼容）。
*/
function slotNameFor(platformId, account) {
	const slot = typeof account === "string" && account !== "" && account !== "default" ? account : "";
	return slot === "" ? platformId : `${platformId}#${slot}`;
}
/** 配置的中文摘要（设置页与日志共用，避免两处措辞不一致）。 */
function describeConfig(config) {
	return [
		`间隔 ${config.sendDelayMinMs}~${config.sendDelayMaxMs}ms`,
		config.longBreakAfter > 0 ? `长休 每${config.longBreakAfter}次休息 ${Math.round(config.longBreakMinMs / 1e3)}~${Math.round(config.longBreakMaxMs / 1e3)}s` : "长休 关",
		config.maxRequestsPerTurn > 0 ? `单轮上限 ${config.maxRequestsPerTurn}` : "单轮不限",
		`超时 ${Math.round(config.replyTimeoutMs / 1e3)}s`,
		config.enableTools ? "工具 开" : "工具 关"
	].join("，");
}
//#endregion
//#region src/host/adapter.ts
/** 路由名前缀：最终路由名 = `${ROUTE_PREFIX}-${provider.id}`。 */
const ROUTE_PREFIX = "webin";
/** 某个平台的 provider 路由名。 */
function routeFor(providerId) {
	return `${ROUTE_PREFIX}-${providerId}`;
}
var JobQueue = class {
	jobs = /* @__PURE__ */ new Map();
	seq = 0;
	/**
	* ⭐⭐ 任务看门狗：claimed 超时回收。
	*
	* ## 为什么需要（真实事故）
	*
	* 面板在生成中途死掉 ⇒ 结果永远不来 ⇒ 任务永远 claimed ⇒
	* DSH 只能干等到 adapter 超时（默认 10 分钟）。
	*
	* claim 后 3 分钟没结果 ⇒ 判定执行者死了 ⇒ 标 failed 让 DSH 立刻报错。
	* 3 分钟的依据：正常回复最慢 6 分钟（注释里有实测），但那是「已发送、
	* 在生成」的场景 —— 而生成中面板会持续心跳；面板死了心跳就断。
	* 这里用 claim 时刻算 3 分钟（比 replyTimeout 短），宁可早点报错
	* 让用户重试，也不让用户干等 10 分钟。
	*
	* @param now - 当前时刻（默认 Date.now()，测试可注入）。
	* @returns 被回收的任务数。
	*/
	reapStaleClaimed(now = Date.now(), timeoutMs = 18e4, alive) {
		let reaped = 0;
		for (const job of this.jobs.values()) {
			if (job.claimedAt === void 0) continue;
			if (job.done !== void 0 || job.failed !== void 0) continue;
			if (now - job.claimedAt < timeoutMs) continue;
			/** ⭐⭐ 面板还在心跳 ⇒ 它只是在慢慢生成，**不是失联**。 */
			if (alive !== void 0 && alive()) continue;
			job.failed = "执行面板中途失联（心跳停止）—— 任务没能完成，请重试";
			reaped += 1;
		}
		return reaped;
	}
	/** 派一个新任务。`account` 是该任务的账号槽位（多账号隔离用，可空 = default）。 */
	enqueue(prompt, thinking, platform, expectUrl, freshChat, sessionId, account) {
		const job = {
			id: `job-${Date.now()}-${++this.seq}`,
			prompt,
			thinking,
			platform,
			createdAt: Date.now(),
			...expectUrl === void 0 ? {} : { expectUrl },
			...freshChat === true ? { freshChat: true } : {},
			...sessionId === void 0 || sessionId === "" ? {} : { sessionId },
			...typeof account === "string" && account !== "" && account !== "default" ? { account } : {}
		};
		this.jobs.set(job.id, job);
		/**
		* 只保留最近 50 条，避免长会话内存堆积。
		*
		* ⚠️ **只能淘汰已了结的**（审计发现的隐患）。
		*
		* 早期写法是「按时间取最老的，如果它已了结就删」。但排序后取
		* `[0]` 拿到的是**最老的**（通常正是已完成的那条），于是能删掉 ——
		* 可如果最老的那条恰好**还没了结**（比如它卡住了），就一个都删不掉，
		* map 无限增长。
		*
		* 现在改成：只在超限时，**从已了结的里面**挑最老的删。
		* 一个都没了结就暂时留着（总比丢掉在跑的任务好）。
		*/
		if (this.jobs.size > 50) {
			let oldestDone;
			for (const j of this.jobs.values()) {
				if (j.done === void 0 && j.failed === void 0) continue;
				if (oldestDone === void 0 || j.createdAt < oldestDone.createdAt) oldestDone = j;
			}
			if (oldestDone !== void 0) this.jobs.delete(oldestDone.id);
		}
		return job;
	}
	/**
	* client 领一个待办任务（跳过已领走的）。
	*
	* ## ⭐ 按**平台 + 会话**过滤（用户报的「所有窗口都生效」）
	*
	* 早期只按 `platform` 过滤 —— 于是**任何 DSH 窗口都能领走任何任务**。
	* 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个会话窗口」、
	* 「所有窗口都生效」。
	*
	* ## ⚠️ 但过滤方向必须正确（我第一版写反了，造成更严重的事故）
	*
	* 第一版写的是：
	*
	*     if (job.sessionId !== undefined && job.sessionId !== sessionId) continue
	*
	* 看起来对，但漏了一个**用 Slots Inspect 才查到的事实**：
	*
	*   - `conversation.view` 的 standardProps **有** `sessionId`
	*   - **`shell.overlay` 的 standardProps 没有 `sessionId`**
	*
	* 而**跑发送循环的 `LdwHost` 挂在 `shell.overlay` 上**。
	* 能拿到 `sessionId` 的是 `LdwPlaceholder`（挂 `conversation.view`），
	* 但它**只在用户切到 LDW 标签时才挂载**。
	*
	* 后果链（用户实测到的）：
	*   1. 没切到 LDW 标签 ⇒ `sessionIdRef` 是空的
	*   2. 领活不带 `?session=` ⇒ `sessionId === undefined`
	*   3. 而 host 派发的任务**都带** sessionId（DSH 一定给）
	*   4. 上面的条件恒真 ⇒ **任务全被跳过** ⇒
	*      「**LDW 面板未连接 —— 没有任何客户端领取这个任务
	*      （20s 内无人领取）**」
	*
	* 比原来的「所有窗口都生效」更糟 —— 直接不能用。
	*
	* ## 正确的方向：以「**窗口是否上报**」为准，而不是「任务是否有归属」
	*
	*   - 窗口**上报了** sessionId ⇒ 严格只领同会话的任务（隔离生效）
	*   - 窗口**没上报** ⇒ **放行**（可能是老 client，也可能只是没切到
	*     LDW 标签 —— 这两种都不该让它领不到活）
	*
	* 隔离在「双方都知道身份」时生效；任一方缺信息时退化成原来的行为
	* （能用），不会把功能卡死。
	*
	* @param platform - 只领该平台的任务。面板可能同时挂着多个平台的 webview，
	*   各自只领自己平台的活，避免 DeepSeek 的面板去发 Qwen 的消息。
	* @param sessionId - 来领活的窗口是哪个 DSH 会话（拿不到时是 undefined）。
	*/
	claimNext(platform, sessionId, account) {
		/** 窗口上报了身份吗？没上报就不做会话过滤。 */
		const hasIdentity = sessionId !== void 0 && sessionId !== "";
		/**
		 * ⭐ 多账号过滤（2026-10-16）：任务带了 account 槽位时，驱动器只领
		 * 同槽位的活 —— 否则两个账号的任务会被同一个 profile 的浏览器串发。
		 * 任务没带（旧版/默认槽位）不过滤，保持兼容。
		 */
		const pending = [...this.jobs.values()].filter((j) => j.done === void 0 && j.failed === void 0 && j.claimedAt === void 0 && (platform === void 0 || j.platform === platform) && (typeof account !== "string" || account === "" || j.account === void 0 || j.account === account));
		if (pending.length === 0) return void 0;
		/**
		* ## ⭐⭐⭐ 两轮领活：先本会话，再回退到任意 —— 否则新会话的任务全失败
		*
		* ## 用户实测（新开会话连发两条都 `state: failed`）
		*
		*     job-4  session-8b3f72ef  claimedBy=(未领)  failed
		*     job-5  session-8b3f72ef  claimedBy=(未领)  failed
		*     job-6  session-8b3f72ef  claimedBy=已领     done   ← 这条才成功
		*
		* ## 根因：常驻宿主**全局只有一个**，但 sessionId 有多个
		*
		* 宿主挂 `shell.overlay`（`scope: 'root'` + 不传 `only` ⇒ 永不卸载），
		* 所以**整个窗口只有一个领活循环**。而 `sessionId` 来自每个 DSH 会话各自的
		* 占位符（`conversation.view`），它们写进**同一个模块级 ref** ——
		* **最后一个挂载的覆盖它**。
		*
		* 于是唯一那个循环只拿得到一个 sessionId，其余会话的任务**永远匹配不上**
		* ⇒ 20 秒无人领 ⇒ `WEBIN_FAILED`。上面那两条失败正是这么来的。
		*
		* ## 为什么回退是安全的
		*
		* client 拿到任务后会**按任务字段自己导航**：
		*   - `expectUrl` ⇒ 导航到该会话绑定的网页对话
		*   - `freshChat` ⇒ 显式开新对话
		*
		* 所以「领到了别的会话的任务」不会串台 —— 页面会被导航到正确的那条对话。
		* 这比「任务没人领、直接失败」好得多。
		*
		* ## 原过滤保留为**优先级**而不是硬门槛
		*
		* 「所有窗口都生效」那条老问题在**多窗口**（多个渲染进程、各自有宿主）
		* 场景下仍成立，所以本会话的任务依然**优先**被本窗口领走；只是不再死等。
		*/
		const mine = hasIdentity ? pending.find((j) => j.sessionId === sessionId) : void 0;
		const job = mine ?? pending[0];
		job.claimedAt = Date.now();
		job.claimedBy = hasIdentity ? sessionId : "(未上报)";
		/**
		* 记录领活方式 —— `/status` 直接可见。
		* 频繁出现 `fallback` 说明「会话身份」长期对不上，值得查。
		*/
		job.claimedVia = mine === void 0 && hasIdentity ? "fallback" : "session";
		return job;
	}
	/**
	* 诊断：当前队列里有哪些任务、被谁领走了。
	*
	* 用户报「所有窗口都生效」时，靠这个能一眼看出**哪个窗口领了哪个任务** ——
	* 不用再猜。
	*/
	inspect() {
		const now = Date.now();
		return [...this.jobs.values()].map((j) => ({
			id: j.id,
			platform: j.platform,
			/**
			 * ⚠️⚠️ **必须带 `account`**（2026-10-17 真机根因）。
			 *
			 * 领活循环用 `inspect()` 的结果决定「这个平台的活该用哪个账号档案」。
			 * 这里漏了 account ⇒ 循环永远看到 undefined ⇒ 当成 "default"
			 * ⇒ 与任务实际携带的 `evelyn-xxx` 对不上 ⇒ **一个任务都不领**，
			 * 20 秒后报「没有任何客户端领取这个任务」。
			 *
			 * 用户改名成自定义槽位之后，整个插件就是从这里开始全废的。
			 */
			...j.account === void 0 ? {} : { account: j.account },
			sessionId: j.sessionId ?? "(无)",
			claimedBy: j.claimedBy ?? "(未领)",
			claimedVia: j.claimedVia ?? "(未上报)",
			state: j.done !== void 0 ? "done" : j.failed !== void 0 ? j.cancelled === true ? "cancelled" : "failed" : j.claimedAt !== void 0 ? "claimed" : "pending",
			ageMs: now - j.createdAt
		}));
	}
	/**
	* client 交结果。
	*
	* ## ⚠️ 已取消 / 已了结的任务**不接受新结果**（审计发现的 bug）
	*
	* 早期实现直接覆盖 `job.done` / `job.failed`，于是：
	*
	*   1. 用户按停止 ⇒ `cancel()` 把 `failed` 设成「已取消」，调用方已经
	*      拿到错误退出了；
	*   2. 但 client 那边可能**还在等页面回复**，稍后 `done` 事件到了，
	*      它照样 PUT 一次结果 ⇒ `settle()` 把 `failed` **覆盖成 `done`**。
	*
	* 后果：一个已被取消的任务在队列里「复活」成成功状态。
	* 更糟的是那一轮的 token 会被计进统计，而调用方根本没收到。
	*
	* 所以：**已了结的任务一律拒绝**（返回 false，调用方会收到 404）。
	* 这也让「重复提交」变成幂等可见的失败，而不是静默覆盖。
	*
	* @returns 是否接受（false = 任务不存在 / 已了结）
	*/
	settle(id, result) {
		const job = this.jobs.get(id);
		if (job === void 0) return false;
		/**
		* 已取消的任务：**明确拒绝**。
		*
		* `cancel()` 已经把 `failed` 设成取消原因，调用方也已收到错误 ——
		* 这里再覆盖会让取消「看起来没生效」。
		*/
		if (job.cancelled === true) return false;
		/**
		* 已了结的（无论成功还是失败）：拒绝重复提交。
		*
		* 正常情况下不该发生；真发生了说明有竞态（比如 client 超时兜底
		* 和真实 `done` 同时到达），此时**保留先到的那个**更安全。
		*/
		if (job.done !== void 0 || job.failed !== void 0) return false;
		if ("error" in result) {
			job.failed = result.error;
			/**
			* ⭐ 一并存下 HTTP 状态码 —— adapter 交给 DSH 时要填进 LlmFailure.status。
			* 见 hook 里读 res.status 的那处说明。
			*/
			if (typeof result.httpStatus === "number") job.httpStatus = result.httpStatus;
		} else job.done = result;
		return true;
	}
	get(id) {
		return this.jobs.get(id);
	}
	/** 任务是否已经被领走（用于判断 client 是否在线）。 */
	hasClaimed() {
		for (const job of this.jobs.values()) if (job.claimedAt !== void 0 && job.done === void 0 && job.failed === void 0) return true;
		return false;
	}
	/**
	* 取消一个任务（用户按了停止 / 调用被 abort）。
	*
	* ⚠️ 早期版本在 abort 时**只是抛错退出**，任务仍留在队列里处于 `claimed` 状态：
	*   - `hasClaimed()` 永远返回 true ⇒ `/status` 误报「面板在干活」
	*   - 页面那头也不知道要停，会继续生成到自然结束（白烧配额）
	*   - 万一之后 `done` 事件回来了，还会被当成**下一个任务**的回复（串台）
	*
	* 所以这里标记为已取消，让 client 领活时能看到并去按页面的停止按钮。
	*/
	cancel(id, reason) {
		const job = this.jobs.get(id);
		if (job === void 0) return false;
		if (job.done !== void 0 || job.failed !== void 0) return false;
		job.failed = reason;
		job.cancelled = true;
		return true;
	}
};
/** 重试策略：网页版限流退避较长，必须显式声明（否则落到 10s 默认上限）。 */
const RETRY_POLICY = {
	mode: "normal",
	maxRetries: 8,
	retryableCodes: [
		"RATE_LIMIT",
		"TIMEOUT",
		"TRANSPORT",
		"SERVER"
	],
	initialDelayMs: 4e4,
	maxDelayMs: 117e3,
	jitterRatio: .15
};
/** 会话游标表（内存 + 可选磁盘持久化）。 */
var SessionCursors = class {
	limit;
	store;
	map = /* @__PURE__ */ new Map();
	constructor(limit = 32, store) {
		this.limit = limit;
		this.store = store;
	}
	/**
	* 启动时恢复某个平台的游标。
	*
	* ⚠️ 惰性恢复（首次访问该平台时才读盘）而不是构造时全读：
	* 平台是运行时才知道的（`registry.all()`），构造 `SessionCursors` 时
	* 还不知道有哪些平台。
	*/
	restored = /* @__PURE__ */ new Set();
	ensureRestored(platform) {
		if (this.store === void 0 || this.restored.has(platform)) return;
		this.restored.add(platform);
		try {
			for (const [k, v] of Object.entries(this.store.load(platform))) if (v !== null && typeof v === "object") this.map.set(`${platform}::${k}`, v);
		} catch {}
	}
	get(platform, key) {
		this.ensureRestored(platform);
		return this.map.get(`${platform}::${key}`);
	}
	set(platform, key, cursor) {
		this.ensureRestored(platform);
		this.map.set(`${platform}::${key}`, cursor);
		this.store?.save(platform, key, cursor);
		const mine = [...this.map.entries()].filter(([k]) => k.startsWith(`${platform}::`));
		if (mine.length > this.limit) {
			const oldest = mine.sort((a, b) => a[1].at - b[1].at)[0];
			if (oldest !== void 0) {
				this.map.delete(oldest[0]);
				this.store?.save(platform, oldest[0].slice(platform.length + 2), void 0);
			}
		}
	}
	/** 会话被压缩/重置时清掉进度。 */
	reset(platform, key) {
		this.map.delete(`${platform}::${key}`);
		this.store?.save(platform, key, void 0);
	}
	size() {
		return this.map.size;
	}
};
/** system 的短指纹（长度 + 头尾片段足够区分，不必上 hash）。 */
function fingerprint(text) {
	if (text === "") return "0";
	return `${text.length}:${text.slice(0, 48)}:${text.slice(-48)}`;
}
/**
* 算出本轮要发的内容（增量）。
*
* ## ⚠️ 这个函数**不改状态**
*
* 早期版本在这里直接 `cursors.set(...)` 推进游标，造成一个严重 bug：
* **发送失败时上下文永久丢失** —— 游标已经前进了，下一轮只发之后的消息，
* 中间那段内容再也不会被发出去（页面里没有，DSH 也认为发过了）。
*
* 所以现在拆成两步：
*   1. `diffPrompt()` —— **纯函数**，只算要发什么
*   2. 调用方在**确认投递成功后**调 `commit()`
*
* 失败时不 commit ⇒ 下次重试会重新算出同样的增量，内容不丢。
*
* 判定「需要重发 system」的条件：
*   - 没有游标（新会话）
*   - system 指纹变了（换了 agent / preset）
*   - **历史变短了**（会话被压缩或回退 ⇒ 之前的进度作废，从头发）
*/
function diffPrompt(options) {
	const { messages, cursors, sessionKey, platform } = options;
	const system = typeof options.system === "string" ? options.system.trim() : "";
	const fp = fingerprint(system);
	const prev = cursors.get(platform, sessionKey);
	const historyShrank = prev !== void 0 && messages.length < prev.sentCount;
	/**
	* ## 强制新对话（2026-10-18 第三批）
	*
	* 用户实测：**豆包的工作/聊天模式是锁在会话上的** —— 一个网页对话选定
	* 模式后，除非开新窗口，切不动（切换只在新建对话时生效）。
	*
	* 所以「模式/模型变了」时，本插件必须：
	*   ① 丢掉 `chatUrl` 绑定 ⇒ 驱动器新开一个对话（`freshChat`）；
	*   ② **按首轮处理** ⇒ 全量重发系统提示词与历史。
	*
	* ② 比 ① 更要紧：新对话里页面什么都没有，只发增量 = 模型失忆。
	* 两件事在这里一次做完（游标里同名状态 `pageSig` 由调用方维护）。
	*/
	const forceFresh = options.forceFresh === true;
	const isFirst = forceFresh || prev === void 0 || historyShrank;
	const needSystem = isFirst || prev.systemFingerprint !== fp;
	let start = isFirst ? 0 : prev.sentCount;
	/**
	* 跳过页面自己的回复。
	*
	* 只在**非首轮**做：首轮没有「上次发送」，不存在页面自己的回复。
	* 只跳**连续**的 assistant 消息（正常情况下就一条）；
	* 遇到 user/tool 消息就停 —— 那些是新的输入，必须发。
	*/
	let skippedOwnReply = 0;
	if (!isFirst) while (start < messages.length && messages[start].role === "assistant") {
		start += 1;
		skippedOwnReply += 1;
	}
	const parts = [];
	if (needSystem && system !== "") parts.push(system);
	/**
	* **工具段只在首轮带。**
	*
	* 与差分发送一致：后续轮只发增量。若每轮都带工具目录，
	* 单次请求体量会平白多几千字符 —— 而参考实现实测记录过
	* 「体量是账号被限制的主要嫌疑」。
	*/
	const withTools = isFirst && typeof options.toolSection === "string" && options.toolSection !== "";
	if (withTools) parts.push(options.toolSection);
	const body = serializeMessages(messages.slice(start), options.toolResultLimit);
	if (body !== "") parts.push(body);
	return {
		text: parts.join("\n\n"),
		isFirst,
		skippedOwnReply,
		/** forceFresh ⇒ 不带 chatUrl ⇒ 驱动器新开对话（模式锁定的落地方式）。 */
		chatUrl: forceFresh ? void 0 : prev?.chatUrl,
		commit: () => {
			cursors.set(platform, sessionKey, {
				sentCount: messages.length,
				systemFingerprint: fp,
				at: Date.now(),
				/** 页面签名（模式#模型）——下一轮用它判断「要不要再开新对话」。 */
				...options.pageSig === void 0 ? {} : { pageSig: options.pageSig },
				/** forceFresh 时**主动清掉**旧绑定：新对话的 URL 由结果回填。 */
				...forceFresh || prev?.chatUrl === void 0 ? {} : { chatUrl: prev.chatUrl }
			});
		},
		note: (isFirst ? `首轮（系统提示词 ${system.length} 字符 + ${messages.length} 条消息` : `增量（第 ${start + 1}..${messages.length} 条`) + (skippedOwnReply > 0 ? `，跳过页面自己的 ${skippedOwnReply} 条回复` : "") + (withTools ? `，带工具目录 ${options.toolSection.length} 字符` : "") + "）"
	};
}
/** 构造 adapter（鸭子类型对象；不继承 LlmAdapter 基类，所以方法要齐）。 */
/**
* ## ⭐⭐⭐ 把客户端失败映射到 DSH 的**官方失败码**（否则重试机制不会启动）
*
* ## 官方契约（从 DSH 的 app.asar 提取，dsh-llm/lib/typert.host.js）
*
*     export interface LlmFailure {
*         readonly message: string
*         readonly code: string
*         readonly status?: number
*         readonly providerRetryAfterMs?: number
*     }
*
* ## dsh-llm-retry 的 README（官方重试插件）
*
* > 省略 retryPolicy 时使用 normal mode：对 EMPTY_RESPONSE、RATE_LIMIT、SERVER、
* > TIMEOUT 与 TRANSPORT 最多重试五次，退避 500ms→10s 带抖动。
* > 提供方给出且符合策略边界的有效 Retry-After 会替换本地退避。
*
* ## 本插件原来的问题（用户实测：「服务器暂时不可用」从不重试）
*
* 所有失败都只发 `code: 'WEBIN_FAILED'` —— 一个**自定义码**，官方重试策略
* 认不出来 ⇒ **一次都不会重试**。
*
* ## 修法
*
* 把客户端上报的失败文案映射到官方码，并把页面给出的「稍后重试」提示转成
* `providerRetryAfterMs`（DSH 会用它替换本地退避）。
*
* ⚠️ 映射是**保守**的：认不出的一律回退 `WEBIN_FAILED`（自定义码），
* 不让一个没把握的判断触发五次自动重试（每次都是真实请求、真实计费）。
*/
function classifyFailure(message) {
	const m = message ?? "";
	/**
	* ⭐ 限流 / 服务端暂时不可用 —— 这是用户最常遇到、也最该自动重试的一类。
	* 网页版会插「服务器暂时不可用」「请求过于频繁」这类提示。
	*/
	if (/服务器暂时不可用|服务暂时不可用|服务器繁忙|服务繁忙|请求过于频繁|系统繁忙|Server is busy|Service Unavailable|Too Many Requests/i.test(m)) return {
		code: "RATE_LIMIT",
		providerRetryAfterMs: 12e4
	};
	/** 网页版明说「稍后重试 / N 秒后再试」⇒ 按它给的时长退避。 */
	const sec = /(\d+)\s*秒(?:后|再)/.exec(m);
	if (sec !== null) return {
		code: "RATE_LIMIT",
		providerRetryAfterMs: Math.min(6e5, Number(sec[1]) * 1e3)
	};
	/** 面板/页面失联、等不到结果 ⇒ 超时（可重试）。 */
	if (/心跳|失联|超时|timeout|面板未连接|无人领取/i.test(m)) return { code: "TIMEOUT" };
	/**
	* ⭐⭐ 未登录 ⇒ **不可重试**。
	*
	* 实测（端到端自测）：页面停在登录页时客户端报
	* `no-input: 找不到可见的输入框（页面结构可能已变，或还停在登录页）`。
	* 如果按传输类处理，DSH 会**白重试 5 次**（每次都要等退避），
	* 而重试对「未登录」毫无帮助 —— 必须由用户去登录。
	*
	* 所以含「登录」字样的失败一律归到不可重试的自定义码。
	*/
	if (/登录页|未登录|not logged in|sign[ _-]?in/i.test(m)) return { code: "WEBIN_NOT_LOGGED_IN" };
	/** 发送链路问题（没发出去、输入框丢了）⇒ 传输类（可重试）。 */
	if (/没发出去|send-failed|输入框|发送失败|触发发送/i.test(m)) return { code: "TRANSPORT" };
	/** 拿到空回复 ⇒ 官方有专门的 EMPTY_RESPONSE 码。 */
	if (/空回复|回复为空|EMPTY_RESPONSE/i.test(m)) return { code: "EMPTY_RESPONSE" };
	/** 认不出 ⇒ 保持自定义码，不冒险触发自动重试。 */
	return { code: "WEBIN_FAILED" };
}
/** 每块字符数（见 emit 处的说明）。 */
const CHUNK_CHARS = 200;
/** 把整段文本切成契约友好的增量块。 */
function chunkText(text) {
	if (text.length <= CHUNK_CHARS) return [text];
	const parts = [];
	for (let i = 0; i < text.length; i += CHUNK_CHARS) parts.push(text.slice(i, i + CHUNK_CHARS));
	return parts;
}
function createAdapter(deps) {
	const { queue } = deps;
	const registry = deps.registry ?? new ProviderRegistry();
	deps.timeoutMs;
	const pollMs = deps.pollMs ?? 250;
	/** 每会话的发送进度（差分发送的核心状态）。 */
	const cursors = new SessionCursors(32, deps.cursorStore);
	/**
	* 取当前配置。没有注入时用默认值 —— 测试与降级路径都靠这个。
	*/
	const config = () => deps.getConfig?.() ?? DEFAULT_CONFIG;
	/**
	* 该平台是否已登录。
	*
	* **未注入 `isLoggedIn` 时一律返回 true** —— 门禁是 host 的职责
	* （只有它知道快照文件在哪），adapter 不该在没被告知时自作主张挡人。
	*/
	const loggedIn = (platform) => deps.isLoggedIn?.(platform) ?? true;
	/**
	* 模型 id 的全局唯一化。
	*
	* 各平台的模型 id 可能撞名（比如都叫 `fast`），而 DSH 的模型选择器按
	* `provider/model` 定位，同一 provider 路由下重名会互相覆盖。
	* 这里给模型 id 加平台前缀，**但保持向后兼容**：
	* 旧会话里存的 `ldw-think`（无前缀）仍能解析到默认平台的同名模型。
	*/
	function qualifyModel(providerId, modelId) {
		return `${providerId}:${modelId}`;
	}
	/** 从 `平台:模型` 里拆出两段；无前缀时回退到默认平台。 */
	function parseModel(model) {
		const idx = model.indexOf(":");
		if (idx > 0) return {
			providerId: model.slice(0, idx),
			modelId: model.slice(idx + 1)
		};
		return {
			providerId: DEFAULT_PROVIDER_ID,
			modelId: model
		};
	}
	/**
	 * 从模型 id 里拆出**账号槽位后缀**（形如 deepseek:ldw-fast@工作号）。
	 *
	 * 为什么用「id 后缀」而不是另加字段：DSH 的模型选择器只认我们回给它的
	 * **字符串 id**，要让它区分「同平台不同账号」，能带出去的信息只有 id 本身。
	 * 用 @ 当分隔符 —— 它不在槽位白名单里（见 slot-names.js），所以不会歧义。
	 */
	function splitSlotSuffix(model) {
		const s = String(model ?? "");
		const i = s.lastIndexOf("@");
		if (i <= 0) return { base: s, slot: "" };
		return { base: s.slice(0, i), slot: s.slice(i + 1) };
	}
	/** 是否在模型名里显示账号（用户要「能设置」，默认显示）。 */
	function showAccountInModelName() {
		try { return readConfig().config.showAccountInModelName !== false; } catch { return true; }
	}
	/** 某槽位是否已登录（快照或 cookie 任一命中）。 */
	async function isSlotLoggedIn(platformId, slot) {
		try {
			const sp = snapshotPath(slotNameFor(platformId, slot));
			if (snapshotTextLooksLoggedIn(await readFile(sp, "utf8"))) return true;
		} catch { /* 接着看 cookie */ }
		try {
			const probe = await waitForCookieProbe(platformId, edgeProfileDirFor(platformId, slot));
			return probe.loggedIn === true || probe.reason === "no-rule";
		} catch { return false; }
	}
	/**
	 * 热路径版本：**同步、绝不等待**。
	 *
	 * 模型列表/状态接口都在前端轮询里，等待 worker 会让整个界面像死机
	 * （真机实测每次 0.4–3.9 秒）。这里只用快照 + 上次探测结果，
	 * 后台刷新由 peek 自己发起，下一次轮询自然就更新了。
	 */
	function isSlotLoggedInFast(platformId, slot) {
		try {
			const sp = snapshotPath(slotNameFor(platformId, slot));
			if (existsSync(sp) && snapshotTextLooksLoggedIn(readFileSync(sp, "utf8"))) return true;
		} catch { /* 接着看 cookie */ }
		try {
			const probe = peekCookieProbe(platformId, edgeProfileDirFor(platformId, slot));
			return probe.loggedIn === true || probe.reason === "no-rule";
		} catch { return false; }
	}
	/** 按「路由名 + 模型 id」找到平台、模型定义与**账号槽位**。 */
	function resolve(route, model) {
		const { base, slot } = splitSlotSuffix(model);
		const byRoute = registry.all().find((p) => routeFor(p.id) === route);
		const parsed = parseModel(base);
		const provider = byRoute ?? registry.get(parsed.providerId);
		/** 探测出来的模型也在这里解析（与 listModels 的合并口径一致）。 */
		const specs = effectiveModelsFor(provider);
		return {
			provider,
			spec: specs.find((m) => m.id === parsed.modelId) ?? specs[0],
			/** 空串 = 模型 id 没带槽位 ⇒ 调用方回退到「当前生效槽位」。 */
			account: slot
		};
	}
	/**
	* ## 旧模型 id → 思考强度（2026-10-18 合并双模型后的兼容层）
	*
	* 旧会话里存的是 `ldw-fast` / `ldw-think` 两个模型；合并后 resolve()
	* 落不到它们、会回退 models[0]。这个函数从**原始模型 id** 里把当年的
	* 语义挖回来：fast ⇒ 关思考，think ⇒ 开思考。
	*/
	function effortFromLegacyId(model) {
		const m = String(model ?? "");
		if (m.includes("ldw-fast")) return "off";
		if (m.includes("ldw-think")) return "medium";
		return void 0;
	}
	/**
	* 平台此刻**实际生效**的模型清单（2026-10-19 定案：内置为准）。
	*
	* 第一版把探测缓存并进来，结果元宝探测时侧栏历史污染了缓存，
	* 模型选择页冒出一堆垃圾档位（用户骂「一团糟」）。修正：
	* 清单 = 内置 models；探测结果仅供「识别」按钮展示与白名单接口写入，
	* 绝不自动进清单。resolve/resolveModel 与 listModels 同口径。
	*/
	function effectiveModelsFor(provider) {
		return Array.isArray(provider?.models) ? provider.models : [];
	}
	/**
	* 平台此刻**实际生效**的思考强度档位（内置 + 探测到的模式层）。
	* 「各个模型和思考强度最好都要有自动识别」——模式层探测结果在这里生效。
	*/
	function effectiveEffortsFor(provider) {
		const cached = typeof provider?.id === "string" ? loadDetected(stateRoot(), provider.id) : null;
		const fresh = cached !== null && Date.now() - (cached.detectedAt ?? 0) < 14 * 24 * 3600 * 1000 ? cached.modes : null;
		if (Array.isArray(fresh) && fresh.length > 0) {
			const mapped = fresh
				.map((m) => ({ id: String(m?.id ?? ""), name: String(m?.name ?? m?.text ?? "").slice(0, 40) }))
				.filter((m) => m.id !== "" && m.name !== "");
			if (mapped.length > 0) return mapped;
		}
		return Array.isArray(provider?.reasoningEfforts) ? provider.reasoningEfforts : [{ id: "medium", name: "思考" }];
	}
	/**
	* ## 本轮该拨到哪个**页面模式**（2026-10-18 第三批，元宝两层菜单）
	*
	*   - 元宝：effort（Instant/Thinking/Expert）→ 模式层菜单项名
	*     · Hy4 页面限制「Expert mode only」⇒ spec.efforts 只有一项时直接用那一项
	*   - 豆包：spec.pageMode 声明（聊天 / 工作），强度走思考开关
	*   - 其余平台：spec.pageMode（若有）
	*/
	const YUANBAO_MODE_BY_EFFORT = { instant: "Instant", thinking: "Thinking", expert: "Expert" };
	function pageModeFor(provider, spec, options) {
		if (provider?.id === "yuanbao") {
			/**
			* 模型级 efforts 优先（Hy4 锁 Expert；元宝 DeepSeek 只有 立即/思考）。
			* 2026-10-19：返回「name|alt」串（页面语言会中英切换，拨动时两种都试）。
			* 模型级表里 hit 的 altNames 若空，只回 name。
			*/
			const modelEfforts = Array.isArray(spec?.efforts) && spec.efforts.length > 0 ? spec.efforts : effectiveEffortsFor(provider);
			const want = String(options?.reasoningEffort ?? "").toLowerCase();
			const hit = modelEfforts.find((e) => String(e?.id ?? "").toLowerCase() === want);
			const target = hit !== undefined ? hit : modelEfforts.find((e) => e?.id === (spec?.defaultReasoningEffort ?? modelEfforts[0]?.id)) ?? modelEfforts[0];
			if (target !== undefined) {
				const names = [String(target?.name ?? ""), ...[...(target?.altNames ?? [])]];
				return names.filter((n) => n !== "").join("|");
			}
			const effort = String(options?.reasoningEffort ?? spec?.defaultReasoningEffort ?? provider.defaultReasoningEffort ?? "thinking").toLowerCase();
			return YUANBAO_MODE_BY_EFFORT[effort] ?? "Thinking";
		}
		return typeof spec?.pageMode === "string" ? spec.pageMode : "";
	}
	/** 取一条消息的纯文本（block 数组或字符串都行）。 */
	function blockText(message) {
		if (message === null || typeof message !== "object") return "";
		const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: String(message.content ?? "") }];
		return blocks.map((b) => b?.type === "text" ? String(b.text ?? "") : "").filter(Boolean).join("\n").trim();
	}
	/**
	* ## 出口模式统一解析（2026-10-19 深夜）
	*
	* 两条路径（压缩 / 普通）共用：LDW 自己的覆盖键优先（用户定案
	* 「LDW 网页端开关高于全局、不作用于全局」），空串回落全局
	* compactionFileMode，再回落 auto。
	*/
	function resolveExitMode() {
		const cfg = config();
		const o = String(cfg.ldwCompactionOverride ?? "").trim();
		if (o === "never" || o === "auto" || o === "always") return o;
		const g = String(cfg.compactionFileMode ?? "auto").trim();
		if (g === "never" || g === "auto" || g === "always") return g;
		return "auto";
	}
	/**
	* ## 思考残留剥离（2026-10-20 用户点名「思维链进了正文，很不好」）
	*
	* 实测（805efc82 会话）：网页模型把思考过程（"user asks: ... Let me
	* answer honestly ..."）直接写进回答正文——页面抓取如实带回。
	* 这里做**保守剥离**：text 第一段以典型思考开头（英文思考语气词）且
	* 后面还有正文 ⇒ 思考段挪进 reasoning 块，正文保留。
	*
	* 判据极严防误伤：
	*   - 只看**第一段**（\n\n 分隔）；
	*   - 必须命中思考开头白名单（Let me / The user / I should / Now / Actually /
	*     I'll / Let's / OK, let / Hmm / 用户 asks / the user）；
	*   - 且第二段存在（有真正的正文）；
	*   - 第一段 ≤400 字符（长的更像正文）。
	*/
	function stripLeadingThinkLeak(text) {
		const t = String(text ?? "");
		if (t === "") return { text: t, moved: "" };
		const sep = t.indexOf("\n\n");
		if (sep < 0) return { text: t, moved: "" };
		const first = t.slice(0, sep).trim();
		const rest = t.slice(sep + 2);
		if (first === "" || rest.trim() === "" || first.length > 400) return { text: t, moved: "" };
		if (!/^(Let me|The user|the user|I should|I'll|I will|Now|Actually|Let's|OK, let|Hmm|用户 asks|用户问|让我)/.test(first)) return { text: t, moved: "" };
		return { text: rest, moved: first };
	}
	/**
	* ## 知识库自然语言协议 → ```ldw 工具调用（2026-10-18 第三批）
	*
	* 「我要调动第一层知识库，搜索XX」→ knowledge_search
	* 「我要调动第二层知识库，搜索XX」→ archives_search
	*
	* 判据（严格）：
	*   - 整条回复**就是这一句**（± 少量前后白话），不是长文里碰巧含这几个字
	*   - 工具必须真的在本轮工具目录里（toolNames 有它）
	*   - 搜不到「搜索xx」的 xx（空查询）不翻
	*
	* 翻译后返回改写的回复（代码块替换自然语言句），否则返回 null（原文走）。
	*/
	function translateKbProtocol(text, toolNames) {
		const t = String(text ?? "").trim();
		if (t === "" || t.length > 400) return null;
		const m = t.match(/^[\s\S]*?我要调动(第一层|第二层)知识库[，,、\s]*(?:搜索|查|查查|找找?|检索)\s*(.+?)\s*$/u);
		if (m === null) return null;
		const layer = m[1];
		const query = m[2].replace(/[。.！!？?～~「」"'"']+\s*$/u, "").trim();
		if (query === "" || query.length > 200) return null;
		const tool = layer === "第一层" ? "knowledge_search" : "archives_search";
		if (!toolNames.has(tool)) return null;
		/** 前后允许有少量白话（「等下」「我想想」之类），全部丢弃只留调用。 */
		return "```ldw\nconst r = await " + tool + "(" + JSON.stringify({ query }) + ");\nlog(r);\n```";
	}
	/**
	* ## 自然语言工具调用（2026-10-19 用户提出：「自然语言调用工具的模式，
	* 我有很多工具，希望也能够有自然语言调动的模式，最好可以建立一个映射，
	* 因为工具数量可以增减」）
	*
	* 设计（动态映射——工具可增减的关键）：
	*   - **不预写映射表**：运行时从本轮 options.tools 现查工具名；
	*   - 句式：「我要用工具 <工具名>，<JSON 参数>」或「我要调用 <工具名>，参数 <JSON>」
	*     ——工具名必须**精确等于**目录里的某个名字（防误翻）；
	*   - 参数段是合法 JSON 对象才翻（防把聊天内容当参数）；
	*   - 只在整条回复就是这一句时翻（与 KB 协议同判据）；
	*   - 由全局开关 nlToolProtocol 控制（默认关，保守——避免普通聊天里的
	*     「我要用工具…」被误翻）。
	*
	* @returns 改写后的回复（```ldw 调用）或 null
	*/
	function translateToolUtterance(text, tools) {
		const t = String(text ?? "").trim();
		if (t === "" || t.length > 240) return null;
		const m = t.match(/^[\s\S]*?我要(?:用工具|调用|使用)\s*([A-Za-z_][A-Za-z0-9_-]*)\s*[，,、]?\s*(?:参数\s*)?(.+?)\s*$/u);
		if (m === null) return null;
		const toolName = m[1];
		const tool = [...tools ?? []].find((tl) => tl?.name === toolName);
		if (tool === undefined) return null;
		/** 参数段：{...} JSON 对象（宽松：允许尾逗号由 JSON.parse 自然报错）。 */
		let raw = m[2].trim();
		if (raw.startsWith("{")) {
			const last = raw.lastIndexOf("}");
			if (last > 0) raw = raw.slice(0, last + 1);
		} else {
			/** 单个裸值参数（如 read 的 path）：合成 {path: "..."} —— 只在工具只有一个必填参数时。 */
			const params = tool?.parameters ?? {};
			const required = Array.isArray(params.required) ? params.required : [];
			const props = Object.keys(params.properties ?? {});
			if (required.length !== 1 || props.length < 1) return null;
			raw = JSON.stringify({ [required[0]]: raw.replace(/^["']|["']$/g, "") });
		}
		let args;
		try { args = JSON.parse(raw); } catch { return null; }
		if (args === null || typeof args !== "object" || Array.isArray(args)) return null;
		return "```ldw\nconst r = await " + toolName + "(" + JSON.stringify(args) + ");\nlog(r);\n```";
	}
	/**
	* ## 历史切段（2026-10-18 第三批，分段回放）
	*
	* 按「消息边界」切：优先在【用户】/【助手】行前断开；
	* 单条消息超长时在段落边界硬切。每段 ≤ maxChars。
	*/
	function splitReplay(text, maxChars = 1200) {
		const src = String(text ?? "").trim();
		if (src === "") return [];
		const lines = src.split("\n");
		const out = [];
		let cur = [];
		let curLen = 0;
		const flush = () => {
			if (cur.length > 0) { out.push(cur.join("\n").trim()); cur = []; curLen = 0; }
		};
		for (const line of lines) {
			const isBoundary = /^\s*【(用户|助手|系统|工具)】/.test(line);
			if (isBoundary && curLen > 0) flush();
			if (curLen + line.length + 1 > maxChars && curLen > 0) flush();
			cur.push(line);
			curLen += line.length + 1;
		}
		flush();
		/** 空段（只有空白行造成的）剔除；单段仍超长（罕见：一条超长消息）也保留——页面能吃多少算多少。 */
		return out.filter((s) => s.trim() !== "");
	}
	/**
	* ## LDW 标题前缀（2026-10-18，用户点名）
	*
	* 「机器产生的标题前面请直接带上 LDW 三个字。」
	*
	* 幂等：已经有前缀的不再叠加（标题服务可能对同一段文本反复生成）。
	* normalizeSessionTitle 不清「L/D/W」这类普通字符，前缀能活到入库。
	*/
	const LDW_TITLE_PREFIX = "LDW ";
	function withLdwTitlePrefix(text) {
		const t = String(text ?? "").trim();
		if (t === "") return t;
		if (/^LDW\s/i.test(t)) return t;
		return `${LDW_TITLE_PREFIX}${t}`;
	}
	/**
	* ## effort → 思考开关（2026-10-18，用户点名「快速和思考放进思考强度里」）
	*
	* DSH 的 UI 会把 reasoning.efforts 渲染成「思考强度」下拉，用户选的档位
	* 经 agent-loop 的 buildRequest 原样摊进 stream options（`reasoningEffort`）。
	* 这里把它翻译成页面上「深度思考」开关的拨向：
	*
	*   - "off"     → 关（旧行为 = ldw-fast）
	*   - 其它任何档 → 开（旧行为 = ldw-think）
	*
	* 解析优先级：UI 传来的 effort > 旧模型 id 兜底 > 平台默认档。
	* DeepSeek 与豆包有页面思考开关（走 effort）；元宝靠档位切换
	*（applyPageModel），spec.thinking 只用于 reasoning 展示，不拨开关。
	*/
	function thinkingFor(provider, spec, options, fallbackEffort) {
		if (provider?.id === "deepseek" || provider?.id === "doubao") {
			const fromOptions = options?.reasoningEffort;
			const legacy = effortFromLegacyId(options?.model);
			const fallback = fallbackEffort ?? provider.defaultReasoningEffort ?? "medium";
			const effort = typeof fromOptions === "string" && fromOptions !== "" ? fromOptions : legacy !== void 0 ? legacy : fallback;
			return effort !== "off";
		}
		return spec.thinking === true;
	}
	function modelInfoFor(route, provider, spec, slot = "") {
		/** default 槽位不加后缀、不改名 —— 与单账号时的行为完全一致。 */
		const hasSlot = slot !== "" && slot !== "default";
		return {
			provider: route,
			id: qualifyModel(provider.id, spec.id) + (hasSlot ? "@" + slot : ""),
			name: hasSlot && showAccountInModelName() ? spec.name + "（" + slot + "）" : spec.name,
			description: spec.description ?? provider.name,
			inputModalities: ["text"]
		};
	}
	function resolvedModelInfo(route, provider, spec, requested) {
		const id = requested === "" ? qualifyModel(provider.id, spec.id) : requested;
		/** 名字里带上账号，让「选中的是哪个号」一眼可见（与 listModels 一致）。 */
		const reqSlot = splitSlotSuffix(id).slot;
		const showSlot = reqSlot !== "" && reqSlot !== "default" && showAccountInModelName();
		const thinking = spec.thinking === true;
		/** 模型级档位优先（Hy4 只有 Expert），其次平台级（含探测到的模式层）。 */
		const efforts = Array.isArray(spec.efforts) && spec.efforts.length > 0 ? spec.efforts : effectiveEffortsFor(provider);
		return {
			provider: route,
			id,
			name: spec.name,
			description: spec.description ?? provider.name,
			inputModalities: ["text"],
			/**
			* ⚠️ contextWindow 必须与网页端真实容量一致，否则会引发**会话压缩死锁**：
			* compaction-basic 用 `thresholdTokens = min(contextWindow × 0.8, contextWindow − maxTokens − headroom)`
			* 判定是否压缩。早期版本硬编码 128_000，阈值只有 54272，
			* 而真实会话轻松超过 30 万 token ⇒ 每一步 pre-step 都判定「超阈值」⇒ 反复触发压缩；
			* 而压缩的摘要调用又走 `routedTarget()`（= 最近一次路由的模型 = LDW 自己）
			* ⇒ 摘要必须经浏览器发送 ⇒ 浏览器一旦发不出去就整轮干等超时。
			* 实测后果：turn 21/22/23 连续三轮卡在 `compaction/start`，最久一次卡 6 分 12 秒。
			*/
			context: { contextWindow: provider.contextWindow },
			defaultMaxTokens: provider.maxOutputTokens,
			...thinking ? { reasoning: {
				efforts: efforts.map((e) => ({
					id: e.id,
					name: e.name
				})),
				defaultEffort: spec.defaultReasoningEffort ?? provider.defaultReasoningEffort ?? efforts[0]?.id ?? "medium"
			} } : {}
		};
	}
	/** 等 client 把结果交回来。 */
	async function waitForJob(job, signal) {
		/** 配置里的超时优先（用户可在设置页调），其次 deps，最后默认 10 分钟。 */
		const deadline = Date.now() + (deps.timeoutMs ?? config().replyTimeoutMs);
		/**
		* 「没人领活」的宽限窗口。
		*
		* LDW 面板没打开（或用户切到了别的标签、guest 被卸载）时，client 半根本不会
		* 来 `GET /job/next`。此时**必须快速失败**，否则一次模型调用会干等满
		* `timeoutMs`（默认 10 分钟）—— 而压缩摘要走的正是这条路，
		* 于是整轮对话被一个没人能完成的任务卡死（实测 turn 23 卡 6 分 12 秒）。
		*
		* 判定：超过宽限期仍未被任何 client 领走 ⇒ 判定面板不在线，立即报错。
		* 宽限期给得比 client 的轮询间隔（1.5s）宽裕得多，不会误杀正在启动的面板。
		*/
		/**
		 * ## ⭐ host 自己驱动时，宽限期不能用「20 秒没人领」那套
		 *
		 * 2026-10-17 真机事故（session-96a8ffe8, turn 13）：用户在**豆包**上有一条任务
		 * 正在跑，接着又发了一条 **deepseek** 任务。驱动是串行的，一条浏览器一次只
		 * 干一个平台；等它跑完豆包、关掉浏览器、再用 deepseek 档案重新启动，
		 * 早就超过 20 秒 —— 任务被判「LDW 面板未连接」，可面板明明是好的。
		 *
		 * 所以：host 驱动开着的时候，宽限期至少给到 3 分钟（真实上限仍是
		 * `replyTimeoutMs`，不会无限等）。
		 */
		const driverEnabled = deps.driverEnabled?.() === true;
		const claimGraceMs = deps.claimGraceMs
			?? (driverEnabled ? Math.max(config().claimGraceMs, 18e4) : config().claimGraceMs);
		let claimedOnce = false;
		for (;;) {
			if (signal?.aborted === true) {
				/**
				* 用户按了停止。
				*
				* **必须把任务标记掉**，否则它会一直挂在队列里处于 claimed 状态：
				*   - `hasClaimed()` 永远 true ⇒ `/status` 误报「面板在干活」
				*   - client 那头不知道要停，页面会继续生成到自然结束（白烧配额）
				*   - 之后回来的 `done` 还可能被算成下一个任务的回复（串台）
				*
				* 标记后 client 领活时能看到 `cancelled`，去按页面的停止按钮。
				*/
				queue.cancel(job.id, "已取消（用户停止）");
				throw new Error("aborted");
			}
			const current = queue.get(job.id);
			if (current === void 0) throw new Error("job disappeared");
			if (current.failed !== void 0) {
				const e = new Error(current.failed);
				e.httpStatus = current.httpStatus;
				throw e;
			}
			if (current.done !== void 0) return current.done;
			if (current.claimedAt !== void 0) claimedOnce = true;
			if (!claimedOnce && Date.now() > job.createdAt + claimGraceMs) {
				queue.settle(job.id, { error: "LDW 面板未连接：没有 client 领取这个任务。" });
				throw new Error(`LDW 面板未连接 —— 没有任何客户端领取这个任务（${Math.round(claimGraceMs / 1e3)}s 内无人领取）。\n原因通常是：LDW 标签没打开、面板被切走卸载了、或页面还没登录。
请切到 LDW 标签并确认显示「真实浏览器已就绪」。`);
			}
			if (Date.now() > deadline) {
				queue.settle(job.id, { error: "等待网页回复超时" });
				throw new Error("等待网页回复超时。可能原因：页面结构变了 / 未登录 / 网页版没吐回复。请打开 LDW 标签查看页面状态。");
			}
			await new Promise((r) => setTimeout(r, pollMs));
		}
	}
	/**
	* 把一次模型调用变成 StreamChunk 流。
	*
	* 注意：这里**不返回 async generator 之外的东西**，
	* `block-start` / `text-delta` / `block-end` / `finish` 的顺序是 dsh-llm 的契约。
	*/
	async function* streamOnce(options) {
		/**
		* **压缩摘要不能走真实浏览器。**
		*
		* `compaction-basic` 的 `summarizeWithLlm()` 用 `routedTarget(session)` 选摘要模型 ——
		* 也就是「最近一次实际路由的 provider」。一旦会话切到 LDW，压缩就变成
		* 「把整段对话历史打进网页输入框」，这有两个致命问题：
		*
		*   1. **体量**：摘要输入动辄几十万 token，塞进 textarea 会让页面直接卡死；
		*      网页版本身也有输入长度上限。
		*   2. **死锁**：摘要必须等浏览器回话，而浏览器一旦不可用（面板没开 / 未登录 /
		*      页面结构变了），整轮对话就卡在 `compaction/start` 上 —— 实测最久 6 分 12 秒。
		*
		* 所以这里按 `compactionFileMode` 三档处理（详见 DEFAULT_CONFIG 注释）：
		*
		*   - never  → 旧行为，拒绝并指引配 HTTP provider；
		*   - auto   → 输入 ≤ compactionFileThresholdChars 直接走普通发送，
		*              超过则落盘 .txt 走上传通道（client.js 收到 job.file 时执行）；
		*   - always → 一律 .txt 上传。
		*
		* .txt 通道的职责链：这里负责序列化+落盘+构造 job.file；
		* client.js 的 job 执行器负责 CDP 塞文件 + 发短指令 + 收摘要。
		*/
		if (options.purpose === "compaction") {
			const cfg = config();
			/** 统一走 resolveExitMode（LDW 覆盖键优先于全局）。 */
			const mode = resolveExitMode();
			const threshold = cfg.compactionFileThresholdChars ?? 1e5;
			const { provider: cProvider, spec: cSpec } = resolve(options.provider, options.model);
			/** 序列化全部消息（与 serializeMessages 同款，但不截断工具结果 —— 压缩要全文）。 */
			const fullText = [
				typeof options.system === "string" && options.system.trim() !== "" ? options.system.trim() : "",
				...(options.messages ?? []).map((m) => {
					const role = m.role === "assistant" ? "助手" : m.role === "user" ? "用户" : m.role;
					const blocks = Array.isArray(m.content) ? m.content : [{ type: "text", text: String(m.content ?? "") }];
					const body = blocks.map((b) => {
						if (b.type === "text") return b.text ?? "";
						if (b.type === "tool-call") return `[工具调用 ${b.name ?? ""}] ${b.arguments ?? ""}`;
						if (b.type === "tool-result") return `[工具结果] ${typeof b.content === "string" ? b.content : JSON.stringify(b.content ?? "")}`;
						if (b.type === "image") return "[图片略]";
						return "";
					}).filter(Boolean).join("\n");
					return `【${role}】\n${body}`;
				})
			].filter(Boolean).join("\n\n");
			const shouldFile = mode === "always" || (mode === "auto" && fullText.length > threshold);
			if (shouldFile) {
				/**
				 * .txt 上传通道：
				 * 1. 全文落盘（DSH_HOME/webin/compaction/）；
				 * 2. job.file = 绝对路径，prompt 换成短指令；
				 * 3. 跳过 diffPrompt 增量（压缩每次都要全文，不适用游标）。
				 */
				const stateRoot2 = stateRoot();
				const dir = join(stateRoot2, "compaction");
				await mkdir(dir, { recursive: true });
				const file = join(dir, `compaction-${Date.now()}.txt`);
				await writeFile(file, fullText, "utf8");
				/** 压缩指令：取 COMPACTION 语义的关键要求，网页模型按它输出摘要。 */
				const instruction = [
					"你将读到一份通过附件上传的完整对话记录（.txt 文件，消息以【用户】【助手】等角色标注）。",
					"请通读全文后输出一份详尽的对话压缩摘要，要求：",
					"- 保留：所有任务目标与结论、提到的文件路径/命令/版本号/报错原文、用户明确的偏好与决定、未完成事项与下一步；",
					"- 每一条结论都必须带具体事实（文件名、命令、数字、时间），禁止「讨论了技术问题」这类空话；",
					"- 用 markdown 分节输出，顺序：①目标与背景 ②已确认事实 ③技术结论与决策 ④改动过的文件/命令/版本 ⑤报错与踩坑 ⑥未完成/下一步 ⑦用户偏好与约定。",
					"现在开始读取附件并输出摘要，除此之外不要说任何话。"
				].join("\n");
				/**
				 * ⚠️ **压缩任务也必须带账号槽位**（2026-10-17 真机元凶）。
				 *
				 * 大会话的第一件事就是压缩历史，走的是这条 .txt 通道。原来这行
				 * 只传了 6 个参数、**漏了 account** ⇒ 领活循环拿到 `j.account = undefined`
				 * ⇒ 退回字面量 "default" ⇒ 打开改名后留下的**空档案** ⇒
				 * 页面停在 about:blank ⇒ 任务超时，用户看到「消息发不出去」。
				 */
				const job = queue.enqueue(instruction, thinkingFor(cProvider, cSpec, options, "off"), cProvider.id, void 0, true, options.sessionId === void 0 || options.sessionId === "" ? void 0 : String(options.sessionId), activeAccountFor(cProvider.id));
				job.file = file;
				deps.logger?.debug?.(`压缩 .txt 通道：${fullText.length} 字符 → ${file}，job ${job.id}`);
				let result;
				try {
					result = await waitForJob(job, options.signal);
				} catch (error) {
					yield { type: "finish", reason: { kind: "error", failure: { code: "WEBIN_COMPACTION_FILE_FAILED", message: `.txt 上传通道失败：${error?.message ?? String(error)}` } } };
					return;
				}
				if (result.error !== void 0) {
					yield { type: "finish", reason: { kind: "error", failure: { code: "WEBIN_COMPACTION_FILE_FAILED", message: String(result.error) } } };
					return;
				}
				{
					let ci = 0;
					const text = String(result.text ?? "");
					if (text.trim() !== "") {
						yield { type: "block-start", index: ci, blockType: "text" };
						yield { type: "text-delta", index: ci, text };
						yield { type: "block-end", index: ci, block: { type: "text", text } };
						ci += 1;
					}
				}
				yield { type: "finish", reason: { kind: "stop" } };
				return;
			}
			if (mode === "never" || !shouldFile) {
				// never：直接拒绝；auto 但没超阈值：落回普通文本路径（走下方常规发送）。
				if (mode === "never") {
					yield {
						type: "finish",
						reason: {
							kind: "error",
							failure: {
								code: "WEBIN_COMPACTION_UNSUPPORTED",
								message: "压缩摘要被设置为不走 LDW 网页版（compactionFileMode=never）。请把 compaction-basic 的 summarizationProvider / summarizationModel 配成普通 HTTP provider，或在 LDW 设置里把压缩 .txt 出口改成 auto/always。"
							}
						}
					};
					return;
				}
				// auto 且未超阈值：小输入直接发，继续走常规路径（不 return）。
			}
		}
		/**
		* ## 标题生成请求：走浏览器，但产出**强制带 LDW 前缀**（2026-10-18，用户点名）
		*
		* 「机器产生的标题前面请直接带上 LDW 三个字。」
		*
		* 背景：DSH 的会话标题由 dsh-session-title-first-prompt-llm 生成，
		* 它用**会话当前模型**发一次辅助请求（`purpose: "session-title"`）。
		* 当会话选的是 LDW 模型时，这个请求会一路走到这里。
		*
		* 做法：照常发进网页版（不改变生成质量），只在**最终文本上屏前**加前缀。
		* 生成过程仍走完整差分/游标链路；标题请求没有工具、没有思考，
		* 最终只会走到下面「parsed.text」那段——所以真正的前缀注入点
		* 是 streamOnce 结尾的输出段，由 `wantTitlePrefix` 标记控制。
		*/
		const wantTitlePrefix = options.purpose === "session-title";
		const { provider, spec, account: resolvedAccount } = resolve(options.provider, options.model);
		/**
		* ## 未登录时**直接报错**（而不是把消息发进网页版）
		*
		* `listModels` 已经不列未登录平台的模型，但**旧会话可能还存着**
		* 那个模型的 id（比如用户登录过、后来清了登录态）。
		* 那时如果照发，页面会跳到登录页，输入框根本不存在 ——
		* 用户看到的是「找不到可见的输入框」这种莫名其妙的错误。
		*
		* 所以这里给一个能直接照做的提示。
		*/
		const targetAccount = resolvedAccount === "" ? activeAccountFor(provider.id) : resolvedAccount;
		if (!await isSlotLoggedIn(provider.id, targetAccount)) {
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						code: "WEBIN_NOT_LOGGED_IN",
						message: `平台「${provider.name}」还没有登录，无法使用它的模型。\n请点输入框左边的「LDW」按钮（或切到 LDW 标签），在打开的浏览器里登录 ${provider.homeUrl} 后重试。`
					}
				}
			};
			return;
		}
		/**
		* **只发增量** —— 见 `diffPrompt()` 的说明。
		*
		* 会话键：优先用 DSH 给的 `sessionId`；没有时退到「平台 + system 指纹」，
		* 这样至少同一平台的不同 agent 不会互相污染。
		*/
		const sessionKey = options.sessionId !== void 0 && options.sessionId !== "" ? String(options.sessionId) : `${provider.id}#${fingerprint(options.system ?? "")}`;
		/**
		* 工具段（协议 + 目录）—— 只在首轮带，见 `diffPrompt` 的说明。
		*
		* 体量：60 个工具 × 约 80 字符 ≈ 5,000 字符
		* （目录格式是「`name(签名)` — 首句」，对所有工具一视同仁）。
		*
		* ⚠️ 用户可在设置页关掉（`enableTools: false`）—— 关掉后模型收不到
		* 工具目录，自然也不会输出工具代码块。给「只想聊天、不想让它动我机器」
		* 的场景一个开关。
		*/
		const cfg = config();
		const toolSection = cfg.enableTools ? buildToolSection([...options.tools ?? []]) : "";
		/**
		* ## 页面签名变了 ⇒ 强制新对话（2026-10-18 第三批）
		*
		* 豆包的模式锁在会话上（用户实测：开新窗口才切得动），元宝的
		* 模式/模型组合同理 —— 上一条 DSH 会话若以「聊天#Hy3」发了历史，
		* 这一轮要「工作#Hy4」就必须换窗口，且历史要**全量重发**。
		*
		* 判据：游标里存的 `pageSig` ≠ 本轮的 `模式#模型` ⇒ forceFresh。
		* 首轮游标不存在 ⇒ 天然 forceFresh 不了（本就该首轮），跳过比较。
		*/
		const mappedMode = pageModeFor(provider, spec, options);
		const pageSig = `${mappedMode || "-"}#${spec.pageModel ?? "-"}`;
		const prevSig = cursors.get(provider.id, sessionKey)?.pageSig;
		const forceFresh = prevSig !== void 0 && prevSig !== pageSig;
		if (forceFresh) deps.logger?.info?.(`${sessionKey} 页面签名 ${prevSig} → ${pageSig}，开新对话并全量重发历史`);
		const diff = diffPrompt({
			...options,
			platform: provider.id,
			sessionKey,
			cursors,
			toolSection,
			toolResultLimit: cfg.toolResultLimit,
			forceFresh,
			pageSig
		});
		const prompt = diff.text;
		if (prompt.trim() === "") {
			/**
			* 增量为空 = 这一轮的输入和历史完全重复。
			*
			* 这在网页版语义下**不需要再发一次** —— 页面里已经有这段内容了。
			* 但 DSH 期望拿到一条 assistant 回复，所以直接回一个空停止，
			* 而不是把整段历史重发一遍（那正是「聊天记录里全是超长提示词」的来源）。
			*/
			deps.logger?.debug?.(`${sessionKey} 增量为空，跳过发送`);
			yield {
				type: "finish",
				reason: { kind: "stop" }
			};
			return;
		}
		/**
		* **首轮必须开新对话**（`freshChat`）。
		*
		* 没有绑定时不能「在当前页发」—— 当前页可能是别的会话的对话，
		* 两个 DSH 会话就会挤进同一个网页对话（用户实测报的封号级缺陷）。
		*
		* ## 分段回放（2026-10-18 第三批，forceFresh 时）
		*
		* 全量历史一把发会被输入框截断，也不像人。forceFresh（模式锁定
		* 开新窗口）时把历史正文按消息边界切成 ≤1200 字符的段挂
		* `job.replaySegments`，驱动器逐段「发→点停」，最后才发真问题。
		*/
		const job = queue.enqueue(
			prompt,
			thinkingFor(provider, spec, options),
			provider.id,
			diff.chatUrl,
			diff.chatUrl === void 0,
			/**
			* ⭐ 带上**DSH 会话 id** —— client 据此只领自己窗口的活。
			*
			* 用 `options.sessionId`（DSH 给的原始值）而不是 `sessionKey`
			* （那个在没 sessionId 时会退化成 `platform#fingerprint`，
			* 不是真正的会话标识，client 那边对不上）。
			*/
			options.sessionId === void 0 || options.sessionId === "" ? void 0 : String(options.sessionId),
			/**
			* ⭐ 多账号（2026-10-16）：带上该平台**当前生效的账号槽位**。
			* 驱动器据此选 profile 目录（`edge-ldw/<平台>/<槽位>`），
			* 登录快照也按槽位隔离（`webin/auth/<平台>#<槽位>.json`）。
			* 没配置多账号时是 "default"，任务里不写这个字段（与旧版兼容）。
			*/
			/**
			 * 优先用**模型 id 里带的槽位**（用户在选择器里明确选了哪个账号）；
			 * 没带（旧会话或单账号）才回退到「该平台当前生效的槽位」。
			 */
			targetAccount
		);
		/**
		* ⭐ 把「页面档位 / 页面模式」挂到 job 上（2026-10-18 第三批：元宝两层菜单）。
		*
		* 为什么能这么写：`queue.enqueue()` **返回的就是那个 job 对象**，
		* 而 runJob 收到的也是它 —— 所以直接加字段即可，
		* **不必动 enqueue 的定位参数签名**（那种改动容易碰坏别处）。
		*
		* 顺序约定（驱动器里照此执行）：**先拨模式、再拨模型** ——
		* 元宝切模式会重置模型子菜单的选择。
		*/
		if (typeof spec.pageModel === "string" && spec.pageModel !== "") job.pageModel = spec.pageModel;
		if (mappedMode !== "") job.pageMode = mappedMode;
		/**
		* ⭐ 分段回放：forceFresh（开新窗口）⇒ 把「真问题之前」的历史切段。
		*
		* prompt = 系统提示词 + 工具目录 + 历史正文 + 真问题；真问题是
		* messages 里的**最后一条 user 消息**。切法：按消息边界（【用户】/【助手】）
		* 聚合，每段 ≤1200 字符；真问题那一段**不进回放**（留给正常发送）。
		*/
		if (forceFresh === true) {
			const lastUser = [...options.messages ?? []].reverse().find((m) => m?.role === "user");
			const lastUserText = blockText(lastUser);
			const promptBody = String(prompt);
			const cut = lastUserText !== "" ? promptBody.lastIndexOf(lastUserText.slice(0, Math.min(80, lastUserText.length))) : -1;
			if (cut > 0) {
				const history = promptBody.slice(0, cut).trim();
				const finalQuestion = promptBody.slice(cut).trim();
				if (history !== "" && finalQuestion !== "") {
					job.prompt = finalQuestion;
					job.replaySegments = splitReplay(history, 1200);
					deps.logger?.debug?.(`job ${job.id} 分段回放：历史 ${history.length} 字符 → ${job.replaySegments.length} 段（真问题 ${finalQuestion.length} 字符）`);
				}
			}
		}
		/**
		* ## 大输入 .txt 出口（2026-10-19 深夜补——用户实测抓到的最大缺口）
		*
		* 用户原话：「我在这个会话里问它『你看到的是.txt文件吗』，它说没有看到」
		* ——原来 compactionFileMode 只管**压缩摘要**（/compact），日常聊天的
		* 大输入（首轮系统提示词+全套历史）**永远不会**走 .txt，输入框直接截断。
		*
		* 修法：普通发送路径与压缩路径**同一套出口语义**——
		*   - resolveExitMode()（下同）算出 effective mode（LDW 覆盖键优先）；
		*   - `always`：本轮 prompt 一律 .txt 上传 + 短指令；
		*   - `auto`：超过 directSendThresholdChars 才转 .txt；
		*   - `never`：老行为（直接发全文）。
		* ⚠️ 只对**非 forceFresh** 的常规轮生效：forceFresh 走分段回放
		* （job.replaySegments），两者互斥——回放把历史灌进页面后，
		* 后续轮次的增量本来就小，不会再触发阈值。
		*/
		const exitMode = resolveExitMode();
		const directLimit = Number(cfg.directSendThresholdChars) > 0 ? Number(cfg.directSendThresholdChars) : 6000;
		if (forceFresh !== true && prompt.length > 0) {
			const shouldFileNow = exitMode === "always" || (exitMode === "auto" && prompt.length > directLimit);
			if (shouldFileNow) {
				/**
				* ## 同会话不重传（2026-10-20 用户定案：「既然在同一个对话里，一般不需要反复发的」）
				*
				* 网页会话里模型上下文**连续**——上一轮已把全量历史传过附件的话，
				* 这一轮只需把**新增量**当正文直接发，不重传附件（省时间、省风控暴露）。
				*
				* 判据：游标里有 txtSentCount（上次 .txt 传到的消息数）——
				*   - 本轮 messages.length > txtSentCount ⇒ 只发增量，跳过 .txt；
				*   - txtSentCount 不存在（首次/换窗口后）⇒ 照常打包 .txt。
				* 成功后把 txtSentCount = messages.length 写进游标。
				*/
				const prevTxt = cursors.get(provider.id, sessionKey)?.txtSentCount;
				if (typeof prevTxt === "number" && (options.messages ?? []).length > prevTxt && (options.messages ?? []).length - prevTxt < prompt.length) {
					/** 本轮只发增量——prompt 从 diffPrompt 重算：截到 prevTxt 之后。 */
					deps.logger?.debug?.(`job ${job.id} 同会话 .txt 已传 ${prevTxt} 条，本轮只发增量 ${(options.messages ?? []).length - prevTxt} 条正文`);
				} else {
					const stateRoot2 = stateRoot();
					const dir = join(stateRoot2, "biginput");
					await mkdir(dir, { recursive: true });
					const file = join(dir, `input-${Date.now()}.txt`);
					await writeFile(file, prompt, "utf8");
					/** 与压缩通道同款指令语义（模型按附件全文回答，不再复述）。 */
					const instruction = [
						"你将收到一个 .txt 附件，里面是本次对话需要的完整上下文（系统设定与历史，消息以【用户】【助手】等角色标注）。",
						"请先通读附件全文，然后只回答附件末尾的最新问题；回答内容不要复述附件。",
						"现在开始读附件并作答。"
					].join("\n");
					job.prompt = instruction;
					job.file = file;
					/** 标记：本轮走了 .txt——成功后 txtSentCount 记进游标（见 diff.commit 后）。 */
					job.__txtSentCount = (options.messages ?? []).length;
					deps.logger?.debug?.(`job ${job.id} 大输入走 .txt（mode=${exitMode}，${prompt.length} 字符 > 阈值 ${directLimit} → ${file}）`);
				}
			}
		}
		deps.logger?.debug?.(`job ${job.id} 已派发（平台=${provider.id}，会话=${job.sessionId ?? "(无)"}，${diff.note}，${prompt.length} 字符，thinking=${String(job.thinking)}，exit=${exitMode}${job.file !== undefined ? "（.txt 附件）" : ""}）`);
		let result;
		try {
			result = await waitForJob(job, options.signal);
		} catch (error) {
			/**
			* ⚠️ **失败时绝不能推进游标。**
			*
			* 推进了就意味着「DSH 认为这段内容发过了」，下一轮只发之后的增量 ——
			* 而页面里其实没有这段内容 ⇒ **上下文永久丢失**，模型从此缺一段记忆。
			* 不推进 ⇒ 下次调用重新算出同样的增量，内容不丢。
			*/
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						message: error?.message ?? String(error),
						/**
						* ⭐ 用**官方失败码**（不是自定义 WEBIN_FAILED）—— 否则 dsh-llm-retry
						* 认不出来，一次都不会重试。见 classifyFailure 的说明。
						*/
						...classifyFailure(error?.message ?? String(error)),
						/**
						* ⭐⭐ 官方 LlmFailure.status —— HTTP 状态码。
						*
						* 客户端从 hook 的 res.status / this.status 拿到，经 client → host 任务
						* 一路带到这里。DSH 的重试策略据此分类（429 与 500 处理不同）。
						* 拿不到时**不带这个字段**（不是填 0）—— 官方契约里它是可选的。
						*/
						...(() => {
							const st = error?.httpStatus;
							return typeof st === "number" && st > 0 ? { status: st } : {};
						})()
					}
				}
			};
			return;
		}
		/**
		* 投递成功（页面已确认发送、且回复已收回）⇒ 这时才推进游标。
		*
		* 注意：`waitForJob` 成功返回意味着**页面确实处理了这个 prompt**，
		* 所以即使回复内容为空，这段输入也已经进过页面了，游标该推进。
		*/
		diff.commit();
		/**
		* 记住「这条 DSH 会话现在绑定的网页对话」。
		*
		* client 交结果时带上了发送成功后的页面 URL（即对话落地页）。
		* 存进游标后，**这个 DSH 会话的后续任务都会要求先导航回这个对话** ——
		* 换别的 DSH 会话聊天时各回各的对话，不再全挤一个窗口（封号级缺陷，用户实测发现）。
		*
		* ⚠️ 必须放在 `diff.commit()` **之后**：commit 会整体重写游标，
		* 放前面的话这里刚存的 chatUrl 会被 commit 用旧值覆盖掉
		* （verify-session-route 的 ⭐ 断言就是抓这个的）。
		*/
		if (typeof result.chatUrl === "string" && result.chatUrl !== "") {
			const cur = cursors.get(provider.id, sessionKey);
			cursors.set(provider.id, sessionKey, {
				sentCount: cur?.sentCount ?? messages.length,
				systemFingerprint: cur?.systemFingerprint ?? fp,
				at: Date.now(),
				chatUrl: result.chatUrl
			});
			deps.logger?.debug?.(`${sessionKey} 绑定对话 ${result.chatUrl}（已落盘）`);
		}
		/**
		* txtSentCount 落游标（2026-10-20 同会话不重传）：
		* 本轮走了 .txt 且成功 ⇒ 记住「附件已传到第 N 条」——
		* 下一轮 messages 更多时只发增量正文，不再打包附件。
		* 同样放 commit 之后（commit 整体重写游标会冲掉）。
		*/
		if (typeof job.__txtSentCount === "number") {
			const cur2 = cursors.get(provider.id, sessionKey);
			cursors.set(provider.id, sessionKey, {
				sentCount: cur2?.sentCount ?? messages.length,
				systemFingerprint: cur2?.systemFingerprint ?? fp,
				at: Date.now(),
				...cur2?.chatUrl === void 0 ? {} : { chatUrl: cur2.chatUrl },
				txtSentCount: job.__txtSentCount
			});
			deps.logger?.debug?.(`${sessionKey} .txt 附件已传到第 ${job.__txtSentCount} 条（下轮只发增量）`);
		}
		/**
		* ## 解析工具调用（抄 cuckoo 的 JS 代码块协议）
		*
		* 网页模型没有原生 function calling，所以让它把调用写成 ```ldw 代码块
		* （cuckoo 的模板明确要求「多行文本用反引号模板字符串，不做任何转义」
		* —— 比 web-login 的 JSON 协议少一整类失败模式）。
		*
		* 这里把代码块**抠出来**转成 DSH 的 `tool-call` chunk：
		*   - 块外文字照常作为正文流给 DSH
		*   - 块本身**绝不进正文**（否则会显示在网页记录里，看起来不像人）
		*
		* ⚠️ 解析失败时不静默丢弃：把原文当正文透出（用户至少能看到模型写了什么），
		* 并记一条日志。宁可多显示一点，也不能让消息凭空消失。
		*/
		/**
		* ## 知识库自然语言协议翻译（2026-10-18 第三批，用户点名）
		*
		* 「调动知识库的模式建议叫AI用：『我要调动第一层/第二层知识库，搜索xx』
		*  这种格式，不容易被风控」
		*
		* lite-chat-kb 预设里教模型**用自然语言说**这句话（而不是输出代码块——
		* 代码块在网页端的输入历史里是风控特征）。所以在这里、parseToolCalls
		* 之前，把这句话**翻译成真正的 ```ldw 调用**：
		*
		*   「我要调动第一层知识库，搜索XX」→ knowledge_search({query:"XX"})
		*   「我要调动第二层知识库，搜索XX」→ archives_search({query:"XX"})
		*
		* 只在**有对应工具**时翻译（options.tools 里有 knowledge_search /
		* archives_search 才动），普通会话说了这句话原文照走。
		*/
		const toolNames = new Set([...options.tools ?? []].map((t) => t?.name));
		const replyText0 = String(result.text ?? "");
		/**
		* 全局开关（2026-10-19）：adapter-compat 的「知识库自然语言协议」钮写的
		* kbProtocol（真源=本 config.json，每请求现读）。关掉 ⇒ 这句话按普通文字走。
		*
		* 通用工具句式（nlToolProtocol，默认关）：「我要用工具 read，参数 {...}」
		* ——动态映射（从本轮工具目录现查名字），工具增减无需改代码。
		* 两个协议按序尝试：KB 专用优先（句式更具体），通用兜底。
		*/
		const kbOn = cfg.kbProtocol !== false;
		const nlOn = cfg.nlToolProtocol === true;
		let kbCall = kbOn ? translateKbProtocol(replyText0, toolNames) : null;
		if (kbCall === null && nlOn) kbCall = translateToolUtterance(replyText0, options.tools ?? []);
		const replyText = kbCall === null ? replyText0 : kbCall;
		if (kbCall !== null) deps.logger?.debug?.(`自然语言协议翻译：→ ${kbCall.slice(0, 80)}…`);
		const parsed = parseToolCalls(replyText, [...options.tools ?? []]);
		if (parsed.failed.length > 0) deps.logger?.warn?.(`工具调用解析失败 ${parsed.failed.length} 处：${parsed.failed[0]}`);
		let index = 0;
		/**
		* 思考残留剥离（2026-10-20）：think 追加被挪出的思考段，
		* text 用剩余正文——用户不再看到思考混进回答。
		*/
		const stripped = stripLeadingThinkLeak(parsed.text);
		const finalThink = (result.think + (stripped.moved !== "" ? (result.think.trim() !== "" ? "\n\n" : "") + stripped.moved : "")).trim();
		const finalText = stripped.text;
		if (stripped.moved !== "") deps.logger?.debug?.(`思考残留剥离：${stripped.moved.length} 字符挪进 reasoning`);
		if (finalThink !== "") {
			/**
			* ⭐ 按官方契约**分块**发射（原来整段一次性发）。
			*
			* 官方 StreamChunk 声明（从 DSH 的 app.asar 提取）：
			*   | { type: 'reasoning-delta'; index: number; text: string }
			*   | { type: 'text-delta'; index: number; text: string }
			* 两者都是**增量**事件，分块比「一个巨大的 delta」更符合契约语义。
			*
			* ⚠️ 诚实说明：这不会让它真正流式 —— 插件是从客户端一次性拿到完整文本的。
			* 真正的逐字上屏需要客户端边生成边上报（另一处改动）。
			*/
			yield {
				type: "block-start",
				index,
				blockType: "reasoning"
			};
			for (const piece of chunkText(finalThink)) yield {
				type: "reasoning-delta",
				index,
				text: piece
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "reasoning",
					text: finalThink
				}
			};
			index += 1;
		}
		if (finalText.trim() !== "") {
			/** 标题请求：机器产生的标题强制带 LDW 前缀（用户点名，2026-10-18；
			*  全局开关 titlePrefix 可关，2026-10-19）。 */
			const titleOn = cfg.titlePrefix !== false;
			const titleText = wantTitlePrefix === true && titleOn ? withLdwTitlePrefix(finalText) : finalText;
			yield {
				type: "block-start",
				index,
				blockType: "text"
			};
			for (const piece of chunkText(titleText)) yield {
				type: "text-delta",
				index,
				text: piece
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "text",
					text: titleText
				}
			};
			index += 1;
		}
		for (const call of parsed.calls) {
			const id = `call_${Date.now().toString(36)}_${index}_${Math.random().toString(36).slice(2, 8)}`;
			yield {
				type: "block-start",
				index,
				blockType: "tool-call"
			};
			yield {
				type: "tool-call-delta",
				index,
				id,
				name: call.name,
				argumentsDelta: call.arguments
			};
			yield {
				type: "block-end",
				index,
				block: {
					type: "tool-call",
					id,
					name: call.name,
					arguments: call.arguments
				}
			};
			index += 1;
		}
		if (parsed.calls.length > 0) deps.logger?.debug?.(`解析出 ${parsed.calls.length} 个工具调用：${parsed.calls.map((c) => c.name).join(", ")}`);
		if (parsed.text.trim() === "" && parsed.calls.length === 0) {
			deps.logger?.warn?.("本轮回复为空（正文与工具调用都没有）—— 报 EMPTY_RESPONSE，交给 DSH 重试");
			yield {
				type: "finish",
				reason: {
					kind: "error",
					failure: {
						code: "EMPTY_RESPONSE",
						message: "网页版这一轮没有产出任何内容（可能被「服务器暂时不可用」之类的中断截断）。已按官方 EMPTY_RESPONSE 上报，请由重试机制接手。"
					}
				}
			};
			return;
		}
		yield {
			type: "finish",
			reason: parsed.calls.length > 0 ? { kind: "tool-calls" } : { kind: "stop" }
		};
	}
	return {
		providerInfo(provider) {
			return {
				id: provider,
				name: registry.all().find((p) => routeFor(p.id) === provider)?.name ?? provider
			};
		},
		providerRetryPolicy() {
			return RETRY_POLICY;
		},
		/** ⚠️ 必须有：dsh-llm 在计量/压缩路径上**无条件**转调它，缺了会让压缩静默失效。 */
		imageRequestPricing() {},
		/**
		* ## 模型清单 —— **未登录的平台不列出**
		*
		* 用户要求：「如果是已登录才能使用 LDW 那俩模型」。
		*
		* 为什么在 `listModels` 做而不是在设置页做：DSH 的模型选择器
		* 就是拿这个清单渲染的。不列出来 ⇒ 用户根本选不到 ⇒ 不会出现
		* 「选了模型但发不出去」这种更糟的体验。
		*
		* ⚠️ 判断用**持久化快照**而不是「浏览器此刻在线」：
		* 否则重启 DSH 后、用户还没切到 LDW 标签时模型会消失，看起来像插件坏了。
		*/
		async listModels(provider) {
			const hit = registry.all().find((p) => routeFor(p.id) === provider);
			if (hit === void 0) return Promise.resolve([]);
			// 按槽位独立探测；当前账号未登录不能隐藏其他已登录账号的模型。
			/**
			 * 多账号（用户点名要的「并行两个号」）：
			 * 把每个**已登录的槽位**各展开成一组模型条目，模型 id 带 @槽位 后缀
			 * ⇒ 派活时能路由到那个账号自己的 profile（各自独立的登录态）。
			 *
			 * 只列**已登录**的槽位：列一个登不上的账号，用户选了也只会发不出去。
			 */
			const slots = accountsForPlatform(readConfig().config.accounts, hit.id).slots ?? ["default"];
			/**
			 * ⭐ 再排掉用户手动隐藏的槽位（账号卡片里那个「模型栏 ✓/✗」按钮）。
			 * 隐藏**不影响派活**：它照样能用「当前槽位」被选中，只是不在模型栏里占位。
			 */
			const hidden = accountsForPlatform(readConfig().config.accounts, hit.id).hiddenInModels ?? [];
			const usable = slots.filter((slot) => !hidden.includes(slot) && isSlotLoggedInFast(hit.id, slot));
			/**
			* ## 模型清单（2026-10-19 定案：内置为准，探测不自动进清单）
			*
			* 第一版「探测即合并」翻车了（实测）：元宝打开模型菜单时侧栏历史
			* 也被扫进探测结果，缓存一污染，模型选择页出现一堆「LDW · 收到收到」
			* 这样的垃圾条目——用户骂「弄得一团糟」。
			*
			* 定案修正：
			*   - **清单 = 内置 models**（Hy3/Hy4/DeepSeek 已按页面实测内置）；
			*   - 探测结果只存档（设置页「识别」按钮的返回里看得到），
			*     **不再自动并入 listModels**；
			*   - 要把探测档位变成可选模型，走 `POST /providers/:id/models`
			*     （已存在的白名单覆盖接口）显式写入——用户确认过才进。
			*   - 探测到的**模式层**（Instant/Thinking/Expert/立即/思考）仍按
			*     `effectiveEffortsFor` 供思考强度下拉——那是枚举可控的，
			*     且 Hy4/元宝DeepSeek 的模型级档位天然约束了它。
			*/
			const effectiveModels = Array.isArray(hit.models) ? hit.models : [];
			/**
			* ## legacy 别名不进选择页（2026-10-19 用户点名「模型选择页还是乱的」）
			*
			* 旧 id 别名（yuanbao-fast/ldw-fast…）只为让**旧会话**能解析，
			* 选择页里不该显示（一屏七个元宝档位没法看）。
			* listModels 过滤 legacy:true；resolve() 不过滤（旧会话照常解析）。
			*/
			const visibleModels = effectiveModels.filter((m) => m?.legacy !== true);
			const out = [];
			for (const slot of usable) for (const spec of visibleModels) out.push(modelInfoFor(provider, hit, spec, slot));
			return Promise.resolve(out);
		},
		resolveModel(provider, model) {
			const { provider: plat, spec } = resolve(provider, String(model ?? ""));
			return Promise.resolve(resolvedModelInfo(provider, plat, spec, String(model ?? "")));
		},
		prepareCall(provider, model) {
			const { provider: plat, spec } = resolve(provider, String(model ?? ""));
			return Promise.resolve({
				model: resolvedModelInfo(provider, plat, spec, String(model ?? "")),
				stream: (options) => streamOnce(options)
			});
		},
		stream(options) {
			return streamOnce(options);
		}
	};
}
//#endregion
//#region src/shared/auth-snapshot.ts
/**
* 解包 AppKit 的 `{"value":<v>,"__version":"0"}` 包装。
*
* ⚠️ 解析失败时**不能把原文当 token** —— 那样 `"{broken"` 这种畸形值
* 会被当成有效 token（非空字符串），于是坏快照又能覆盖好快照。
* 只有**看起来像 JSON 却解析失败**的才返回 undefined；
* 真正的裸 token（不以 `{` 开头）才按原文返回。
*/
function unwrapAppKit(raw) {
	if (typeof raw !== "string" || raw === "") return void 0;
	const trimmed = raw.trim();
	if (trimmed === "") return void 0;
	/** JSON 的空值字面量：`"null"` / `"undefined"` 都不是 token。 */
	if (trimmed === "null" || trimmed === "undefined") return void 0;
	if (!trimmed.startsWith("{") && !trimmed.startsWith("["))
 /** 裸字符串 token（旧版页面可能这样存）。 */
	return trimmed;
	try {
		const parsed = JSON.parse(trimmed);
		if (parsed !== null && typeof parsed === "object" && "value" in parsed) return parsed.value;
		return parsed;
	} catch {
		/** 像 JSON 但解析失败 ⇒ 视为无效，绝不 fallback 成原文。 */
		return;
	}
}
/**
* 这份快照看起来「确实登录了」吗？
*
* 判据（任一成立即算已登录）：
*   - `userToken` 解包后是非空字符串
*   - `__appKit_userInfo` 解包后 `.id` 是非空字符串
*/
function snapshotLooksLoggedIn(snapshot) {
	// 非 DeepSeek provider 只接受由站点专用探针生成的最小布尔快照；不存 token/cookie。
	if (typeof snapshot.provider === "string" && snapshot.provider !== "deepseek") return snapshot.loggedIn === true;
	const ls = snapshot.localStorage ?? {};
	const token = unwrapAppKit(ls.userToken);
	if (typeof token === "string" && token.trim() !== "") return true;
	const info = unwrapAppKit(ls["__appKit_userInfo"]);
	if (info !== null && typeof info === "object") {
		const id = info.id;
		if (typeof id === "string" && id.trim() !== "") return true;
	}
	return false;
}
/**
* 从原始快照文本判断登录态（**不抛错**）。
*
* 坏 JSON 一律视为「未登录」而不是崩溃 —— 配置文件坏了不能让插件挂掉。
*/
function snapshotTextLooksLoggedIn(text) {
	if (typeof text !== "string" || text.trim() === "") return false;
	try {
		const parsed = JSON.parse(text);
		if (parsed === null || typeof parsed !== "object") return false;
		return snapshotLooksLoggedIn(parsed);
	} catch {
		return false;
	}
}
//#endregion
//#region src/host/cookie-jar.ts
/**
* ## 用 Electron 的 session API 持久化 cookie（**解决「重启必须重新登录」**）
*
* ## 为什么必须走这条路
*
* 用户实测报的：「每次重启 dsh 都需要重新登陆 deepseek？无语了」
*
* 根因链：
*   1. DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
*      （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
*      进程一退，cookie 全丢；
*   2. DeepSeek 的登录态主要靠 **httpOnly cookie**；
*   3. 页面里的 JS（`document.cookie`）**看不见也写不了** httpOnly cookie。
*
* 所以「把 localStorage + document.cookie 存成快照再回写」这条路
* **天生不完整** —— 快照里根本没有真正决定登录态的那几个 cookie。
*
* 插件 host 半跑在 DSH 主进程（Electron）里，**能拿到
* `session.fromPartition(...).cookies`**，那个 API 包含 httpOnly。
*
* ## 怎么拿到 partition
*
* 我们**不猜** partition 名（它是 randomUUID，猜不到）。client 半在
* webview 挂载后会知道自己的 partition（从 lease 来），把它上报给 host，
* host 再用 `session.fromPartition(那个名字)` 取 cookie。
*
* ⚠️ 但 client 半拿不到 partition —— `acquire()` 的返回值只在
* DSH 内部用。所以这里改成**扫描式**：遍历当前所有 partition，
* 找出域名匹配目标平台的那个。`session.fromPartition` 只能按名字取，
* 所以还需要枚举名字 —— Electron 没有「列出所有 partition」的 API。
*
* ## 因此：退一步，用「按名字试探 + 全量扫描 fallback」
*
* 实际上 Electron 的 `session.defaultSession` 与所有 partition 共享
* cookie jar 的**域名索引**吗？不 —— 每个 partition 独立。
*
* **结论：拿不到名字就拿不到 session。**
*
* 所以本模块做的是**另一件确定可行的事**：让 client 半在**能拿到
* partition 名字**时上报它（DSH 的 `webview` 元素上 `partition` 属性
* 是我们自己设的 —— 但那是我们编的，不是 DSH 分配的）。
*
* 于是最终方案改为：**client 侧把 cookie 快照能力做全**（见下），
* host 侧提供一个「如果 electron 可用就顺便用 API 补全 httpOnly」的
* 可选增强。两者都不行时，明确告诉用户「需要重新登录一次」。
*/
/** cookie 存档目录。 */
function cookieDir(stateRoot) {
	return join(stateRoot, "cookies");
}
function cookieFile(stateRoot, platform) {
	/** 平台 id 可能含路径分隔符（自定义 provider 允许），换成安全的字符。 */
	const safe = platform.replace(/[^A-Za-z0-9_.-]/g, "_");
	return join(cookieDir(stateRoot), `${safe}.json`);
}
/**
* 尝试拿 Electron 的 session 模块。
*
* ## ⚠️ 为什么不能用 `eval('require')`（我第一版写错了，**实测才发现**）
*
* 第一版写的是 `const req = eval('require')` —— 以为这样能绕过打包器。
* 但**插件的 host 产物是 ESM**（`tsdown.config.ts` 里 `format: 'esm'`），
* ESM 模块里**根本没有 `require`** ⇒ `eval('require')` 抛
* `ReferenceError` ⇒ 被 catch 吞掉 ⇒ 永远返回 undefined。
*
* **实测证据**（对运行中的 host 打 `POST /client/partition`）：
*
*     {"ok":true,"cookieApi":false,"archived":false}
*
* `cookieApi:false` 意味着「重启免登录」那条路**从来没生效过** ——
* 用户报「每次重启 dsh 都需要重新登陆」，我以为是分区问题，
* 实际上我连 Electron API 都没拿到。
*
* ## 正确做法：`createRequire(import.meta.url)`
*
* ESM 里拿 `require` 的标准方式。
*
* ## 为什么还要 try/catch
*
* - **单元测试 / 纯 node 环境**下 `require('electron')` 会 MODULE_NOT_FOUND
* - Electron 的 `session` 只在**主进程**可用
*
* 拿不到就返回 undefined，调用方走降级路径。
* **绝不能因为拿不到就抛错** —— 那会让整个插件加载失败。
*/
function tryElectronSession() {
	/** 判据统一：拿到 `session.fromPartition` 才算成功。 */
	const strategies = [
		() => {
			const meta = import.meta;
			return typeof meta.url === "string" ? createRequire(meta.url)("electron") : void 0;
		},
		() => createRequire(String(process.execPath))("electron"),
		() => {
			const mm = process.mainModule;
			return typeof mm?.require === "function" ? mm.require("electron") : void 0;
		},
		() => {
			const g = globalThis;
			return typeof g.require === "function" ? g.require("electron") : void 0;
		},
		() => {
			const eb = process.electronBinding;
			return typeof eb === "function" ? eb("electron_module") : void 0;
		}
	];
	for (const get of strategies) try {
		const electron = get();
		if (electron?.session?.fromPartition !== void 0) return electron.session;
	} catch {}
}
/**
* 诊断：**为什么**拿不到 Electron session？
*
* ## 为什么要这个（用户要求「不要猜」）
*
* 实测 `cookieApi: false`，光看这一个布尔值**分不清原因**。
* 加了诊断路由后拿到确切答案：
*
*     hasImportMetaUrl: true            ← createRequire 可用
*     requireKind: "function"           ← 同上
*     error: "Cannot find module 'electron'"
*     electronVersion: "44.0.0"         ← 确实在 Electron 里
*     processType: "(none)"             ← process.type 不是 'browser'
*
* 所以是**模块解析**问题（插件从自己目录加载，那里没有 electron 包），
* 而且进程类型可疑。
*
* ## 做法：**把所有可能的获取方式都试一遍，列出哪个成功**
*
* 不猜「哪种能行」—— 全部实测，把结果列出来。拿到 `session.fromPartition`
* 的算成功。
*/
function diagnoseElectron() {
	const out = {
		hasImportMetaUrl: false,
		importMetaUrl: "",
		error: void 0,
		processType: String(process.type ?? "(none)"),
		electronVersion: String(process.versions.electron ?? "(none)"),
		nodeVersion: process.version,
		argv0: String(process.argv0 ?? "").slice(0, 160),
		execPath: String(process.execPath ?? "").slice(0, 160),
		resourcePath: String(process.resourcesPath ?? "(none)"),
		hasElectronBinding: typeof process.electronBinding === "function",
		hasMainModule: process.mainModule !== void 0,
		strategies: []
	};
	const meta = import.meta;
	out.hasImportMetaUrl = typeof meta.url === "string";
	out.importMetaUrl = typeof meta.url === "string" ? meta.url.slice(0, 200) : "";
	/**
	* ## 逐个试所有获取方式
	*
	* 判据统一：**拿到 `session.fromPartition` 才算成功**。
	* 拿到一个空壳 electron（渲染进程里就是）不算。
	*/
	const strategies = [
		{
			name: "createRequire(import.meta.url)(\"electron\")",
			get: () => typeof meta.url === "string" ? createRequire(meta.url)("electron") : void 0
		},
		{
			name: "createRequire(execPath)(\"electron\")",
			get: () => createRequire(String(process.execPath))("electron")
		},
		{
			name: "process.mainModule.require(\"electron\")",
			get: () => {
				const mm = process.mainModule;
				return typeof mm?.require === "function" ? mm.require("electron") : void 0;
			}
		},
		{
			name: "globalThis.require(\"electron\")",
			get: () => {
				const g = globalThis;
				return typeof g.require === "function" ? g.require("electron") : void 0;
			}
		},
		{
			name: "process.electronBinding(\"electron_module\")",
			get: () => {
				const eb = process.electronBinding;
				return typeof eb === "function" ? eb("electron_module") : void 0;
			}
		}
	];
	for (const s of strategies) try {
		const got = s.get();
		const hasSession = got?.session !== void 0 && got?.session !== null;
		const hasFromPartition = typeof got?.session?.fromPartition === "function";
		out.strategies.push({
			name: s.name,
			ok: hasFromPartition,
			detail: hasFromPartition ? "✅ 拿到 session.fromPartition" : got === void 0 ? "返回 undefined" : "拿到 " + typeof got + "，session=" + String(hasSession)
		});
	} catch (e) {
		out.strategies.push({
			name: s.name,
			ok: false,
			detail: e?.message ?? String(e)
		});
	}
	/** 全都失败时，把第一条的错误原文当主因（最可能是它）。 */
	if (!out.strategies.some((s) => s.ok)) {
		const first = out.strategies[0];
		if (first !== void 0) out.error = first.detail;
	}
	return out;
}
/** Electron 的 session 是否可用（供 `/status` 显示，让用户知道走哪条路）。 */
function cookieApiAvailable() {
	return tryElectronSession() !== void 0;
}
/**
* 从指定 partition 抓取某域名的全部 cookie（**含 httpOnly**）。
*
* @param partition - DSH 分配的 partition 名（client 上报）
* @param domain - 目标域名（如 `chat.deepseek.com`）
* @returns cookie 列表；session 不可用时返回 undefined（调用方降级）
*/
async function grabCookies(partition, domain) {
	const ses = tryElectronSession();
	if (ses === void 0) return void 0;
	try {
		/** 域名匹配：Electron 的 domain 可能带前导点（`.deepseek.com`）。 */
		return (await ses.fromPartition(partition).cookies.get({})).filter((c) => {
			const d = String(c.domain ?? "").replace(/^\./, "");
			return d === domain || domain.endsWith(`.${d}`) || d.endsWith(`.${domain}`);
		});
	} catch {
		return;
	}
}
/**
* 把 cookie 写回指定 partition。
*
* ## 为什么必须带 url
*
* Electron 的 `cookies.set()` 要求给出 `url`（它从 url 推导 domain/path/
* secure）。只给 `domain` 不生效 —— 这是踩过的坑。
*/
async function restoreCookies(partition, cookies) {
	const ses = tryElectronSession();
	if (ses === void 0) return 0;
	const jar = ses.fromPartition(partition).cookies;
	let ok = 0;
	for (const c of cookies) try {
		const host = String(c.domain ?? "").replace(/^\./, "");
		const scheme = c.secure === true ? "https" : "http";
		await jar.set({
			url: `${scheme}://${host}${c.path === "" ? "/" : c.path}`,
			name: c.name,
			value: c.value,
			domain: c.domain,
			path: c.path === "" ? "/" : c.path,
			secure: c.secure === true,
			httpOnly: c.httpOnly === true,
			...c.expirationDate === void 0 ? {} : { expirationDate: c.expirationDate },
			...c.sameSite === void 0 ? {} : { sameSite: c.sameSite }
		});
		ok += 1;
	} catch {}
	return ok;
}
/** 存档 cookie 到磁盘。 */
function saveCookieArchive(stateRoot, archive) {
	const dir = cookieDir(stateRoot);
	if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
	writeFileSync(cookieFile(stateRoot, archive.platform), JSON.stringify(archive), "utf8");
}
/** 读 cookie 存档。 */
function loadCookieArchive(stateRoot, platform) {
	const f = cookieFile(stateRoot, platform);
	if (!existsSync(f)) return void 0;
	try {
		const raw = readFileSync(f, "utf8");
		const parsed = JSON.parse(raw);
		if (!Array.isArray(parsed.cookies)) return void 0;
		return parsed;
	} catch {
		return;
	}
}
//#endregion
//#region src/shared/version.ts
/**
* 安全读取构建期常量（万一没注入 —— 比如别的工具链直接编译源码）。
*
* 用 `typeof` 探测而不是直接引用：直接引用未声明的标识符会抛
* `ReferenceError`，那样整个插件都加载不了。
*/
function injected(name, fallback) {
	try {
		if (name === "version" && true) return "0.2.23";
		if (name === "commit" && true) return "23a1f78";
		if (name === "repo" && true) return "cv-superding/dsh-webin";
		if (name === "builtAt" && true) return "2026-10-14T13:38:37.881Z";
	} catch {}
	return fallback;
}
/** 当前跑的这份是哪个版本。 */
function currentVersion() {
	return {
		version: injected("version", "0.0.0"),
		commit: injected("commit", "unknown"),
		repo: injected("repo", "cv-superding/dsh-webin"),
		builtAt: injected("builtAt", "")
	};
}
/** GitHub 仓库地址。 */
function repoUrl(repo) {
	return `https://github.com/${repo ?? currentVersion().repo}`;
}
/** 打开仓库「点 Star」的地址（直达 star 确认页，省一次点击）。 */
function starUrl(repo) {
	return `${repoUrl(repo)}/stargazers`;
}
/**
* 检查更新。
*
* ## 为什么看**提交号**而不是「版本号」
*
* DSH 插件的实际分发方式是 `link:` 或本地目录（README 里的安装方式），
* 用户的代码就是从仓库拉的一份工作副本。这种情况下：
*   - `package.json` 的 version 常年不动
*   - 真正决定「有没有新东西」的是**提交**
*
* ## 为什么用 GitHub 公开 API
*
* 不需要凭据（公开仓库），不碰用户的 GitHub token ——
* 插件不该为了检查更新去要一个能写仓库的凭据。
*
* ## ⚠️ 必须有超时（真实 bug）
*
* 早期直接 `await fetch(...)` 没有超时。GitHub 在国内**经常连不上但不
* 立刻报错**（连接挂着）—— 于是设置页的「检查更新」按钮**永远转圈**。
* 用户报的就是这个：「插件更新的逻辑貌似有bug」。
*
* 现在用 `AbortController` 加 10 秒硬超时，超时明确报错而不是干等。
*
* ## 怎么判断「落后」（真实 bug）
*
* 早期判据是「提交号不等即有更新」。这会把两种**不该报更新**的情况
* 也算进去：
*   - 用户自己提交了没推（本地比远端**新**）
*   - 远端被 force-push 回退
*
* 现在用 compare API 判断方向（`identical` / `ahead` / `behind` / `diverged`）。
*
* @param repo - `owner/repo`；省略用当前插件的
* @param timeoutMs - 网络超时（默认 10 秒）
*/
async function checkForUpdate(repo, timeoutMs = 1e4) {
	const slug = repo ?? currentVersion().repo;
	const checkedAt = Date.now();
	const mine = currentVersion().commit;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		/**
		* ## 用 compare API 而不是「取 main 的最新提交」
		*
		* `GET /commits/main` 只能告诉我「远端最新是什么」，**无法判断方向** ——
		* 提交号不同时，不知道是自己落后还是自己超前。
		*
		* `GET /compare/<mine>...main` 直接给出 `status`：
		*   `identical` / `ahead` / `behind` / `diverged`
		* 这正是需要的语义。
		*
		* ⚠️ 本地提交号是 `unknown` 时（tarball 安装 / 没注入）无从比较 ——
		* 退回 `commits/main` 只报告「远端最新是什么」，**不判定落后**
		* （报「有更新」会让用户白折腾）。
		*/
		const url = mine === "unknown" ? `https://api.github.com/repos/${slug}/commits/main` : `https://api.github.com/repos/${slug}/compare/${mine}...main`;
		const res = await fetch(url, {
			headers: {
				accept: "application/vnd.github+json",
				"user-agent": "dsh-webin-update-check"
			},
			signal: controller.signal
		});
		if (!res.ok) {
			/**
			* 404 有两种可能：仓库不存在，**或者本地提交号在远端不存在**
			* （用户自己 commit 过、或远端 force-push 过）。
			* 后者不是错误，是「本地更新」—— 明确说出来，别让用户以为网断了。
			*/
			if (res.status === 404 && mine !== "unknown") return {
				ok: true,
				ahead: true,
				behind: false,
				same: false,
				latestCommit: mine,
				latestMessage: "本地提交在远端不存在（你可能有未推送的提交）",
				checkedAt
			};
			return {
				ok: false,
				reason: `GitHub 返回 ${res.status}`,
				checkedAt
			};
		}
		const data = await res.json();
		/** 本地提交号未知时走的是 `commits/main`，没有 status 字段。 */
		if (mine === "unknown") {
			const sha = typeof data.sha === "string" ? data.sha.slice(0, 7) : "";
			if (sha === "") return {
				ok: false,
				reason: "响应里没有提交号",
				checkedAt
			};
			return {
				ok: true,
				latestCommit: sha,
				latestMessage: String(data.commit?.message ?? "").split("\n")[0] ?? "",
				latestAt: data.commit?.committer?.date ?? "",
				/** 无从比较 ⇒ 不判定落后。 */
				behind: false,
				same: false,
				checkedAt
			};
		}
		/**
		* compare 的 `commits` 数组是「从 base 到 head 多出来的提交」。
		* 取最后一个 = 远端最新。
		*/
		const list = Array.isArray(data.commits) ? data.commits : [];
		const newest = list.length > 0 ? list[list.length - 1] : void 0;
		const latestCommit = typeof newest?.sha === "string" ? newest.sha.slice(0, 7) : "";
		const status = String(data.status ?? "");
		/**
		* ## ⚠️ status 的方向语义（**踩过，反了会很严重**）
		*
		* 我们打的是 `compare/<mine>...main` —— base 是**本地提交**，
		* head 是**远端 main**。所以 status 描述的是「从本地到远端」：
		*
		*   - `ahead`    —— **远端**比本地超前 ⇒ **我落后了，有更新** ✅
		*   - `behind`   —— 远端比本地落后 ⇒ 我超前（自己提交了没推）
		*   - `identical`—— 完全一致
		*   - `diverged` —— 分叉
		*
		* ## 第一版写反了，后果很具体
		*
		* 原来写成 `behind: status === 'behind'` —— 于是**只有自己超前时才报
		* 「有更新」，真正落后时反而报「本地更新」** ⇒ 用户永远不会看到
		* 更新提示。这正是用户报的「插件更新的逻辑貌似有bug」。
		*
		* 实测证据（`compare/6d71261...main`，本地落后 28 个提交）：
		*   `{"status":"ahead","ahead_by":28,"behind_by":0}`
		* —— 远端超前 28，但 status 是 `ahead` 而不是 `behind`。
		*
		* 所以判据是 `ahead` ⇒ 有更新。
		*/
		return {
			ok: true,
			latestCommit: latestCommit === "" ? mine : latestCommit,
			latestMessage: String(newest?.commit?.message ?? "").split("\n")[0] ?? "",
			latestAt: newest?.commit?.committer?.date ?? "",
			/** 远端超前（`ahead`）= 我落后 = 有更新。分叉也算。 */
			behind: status === "ahead" || status === "diverged",
			same: status === "identical",
			/** 远端落后（`behind`）= 我超前 = 自己提交了没推。 */
			ahead: status === "behind",
			checkedAt
		};
	} catch (error) {
		return {
			ok: false,
			reason: error?.name === "AbortError" ? `检查更新超时（${Math.round(timeoutMs / 1e3)} 秒无响应）—— 可能是网络无法访问 GitHub` : error?.message ?? String(error),
			checkedAt
		};
	} finally {
		clearTimeout(timer);
	}
}
/**
* 更新方式说明（给设置页显示）。
*
* 本插件有**两种**安装方式，更新动作不同，不能给一句笼统的「点这里升级」：
*   - `link:` 本地目录 ⇒ 用户自己 `git pull`
*   - npm 包 ⇒ `dsh plugin add` 重装
*
* ⚠️ **`lib/` 是构建产物**（在 `.gitignore` 里）。只 `git pull` 不重新构建
* 的话，跑的还是旧产物 —— 用户会以为「更新了但没变化」。
* 所以命令里必须带 `npm run build`，而且要告诉用户怎么确认。
*/
function updateHint(repo) {
	return [
		"cd <本插件目录>",
		"git pull",
		"npm install",
		"npm run build",
		"# 然后在 DSH 里重新加载插件（或重启 DSH）",
		`# 确认版本：设置页应显示新的提交号（仓库：https://github.com/${repo ?? currentVersion().repo}）`
	].join("\n");
}
/**
* 把一次更新检查的结果总结成**一句话**（设置页显示用）。
*
* ## 为什么要单独一个函数
*
* 早期设置页直接把 `behind` 映射成「有更新 / 无更新」两句话 ——
* 于是「本地比远端新」（自己提交了没推）也显示成「无更新」，
* 用户会困惑「我明明改了代码」。
*
* 现在把四种状态分开说。
*/
function describeUpdate(check, mine) {
	if (!check.ok) return `检查失败：${check.reason ?? "未知原因"}`;
	if (check.same === true) return `已是最新（${mine}）`;
	if (check.ahead === true) return `本地更新（${mine}）—— 远端还没有这个提交`;
	if (check.behind === true) {
		const at = check.latestAt === void 0 || check.latestAt === "" ? "" : ` · ${check.latestAt.slice(0, 10)}`;
		return `有新版本 ${check.latestCommit ?? ""}${at} —— ${check.latestMessage ?? ""}`;
	}
	return "状态未知（远端历史与本地不一致）";
}
//#endregion
//#region src/host/index.ts
/**
* dsh-webin — host 半。
*
* 职责：
*   1. 为**每个平台**注册 provider 路由（`webin-deepseek`、`webin-qwen`…），
*      让各平台的网页版出现在模型选择器里
*   2. 任务队列：把 agent 的 prompt 派给 client，等 client 从真实浏览器取回回复
*   3. 登录态快照的**持久化**（`~/.dsh/webin/auth/`，跨 DSH 重启存活）
*   4. 自定义 provider 的**持久化**（`~/.dsh/webin/providers/`）
*
* 为什么持久化放在 host 而不是 client：
*   DSH 的 guest partition 是 `dsh-sidebar-browser-${randomUUID()}`
*   （`main.js:9638`，**无 `persist:` 前缀 ⇒ 内存分区**）。
*   client 侧的 `window.localStorage` 也跟着主窗口 profile 走，不是我们自己的存储；
*   只有 host 侧的文件系统是真正由本插件掌控、且跨重启存活的。
*
* ## 多平台隔离怎么实现的
*
* `DesktopBrowserGuests.acquire(owner, workspace)` 按 **workspace 字符串**缓存
* partition（`main.js:9636-9641`）：
*
* ```js
* let partition = this.partitions.get(workspace);
* if (partition === void 0) {
*   partition = `dsh-sidebar-browser-${randomUUID()}`;
*   this.partitions.set(workspace, partition);
* }
* ```
*
* 所以**用 provider.id 当 workspace 名**，各平台自然拿到不同 partition、
* 不同 cookie / localStorage ⇒ **登录态天然隔离**，且不需要改 DSH 一行。
*/
/**
 * ⚠️ 插件注册名**必须等于 package.json 的包名**（2026-10-16 踩坑）。
 *
 * 本插件是完整包 `dsh-webin-edge-driver`，不是上游 `dsh-webin`。
 * 实测本机所有插件（dsh-timeline / dsh-deepseek-web-login …）的
 * host `name` 与 client 注册 id 都等于各自包名；对不上时整条插件不激活。
 *
 * ⚠️ 但**不要**动下面 `API_PREFIX`（`/dsh-webin/api`）—— 那是 host 与
 * client 之间的内部约定，两半一致就行，与包名无关；改单边会导致 404。
 */
const name = "dsh-webin-edge-driver";
/** 硬依赖 webServer（路由）与 llm（注册 provider）。 */
const inject = ["webServer", "llm"];
/** 路由前缀（client 半同源 fetch 这个前缀）。 */
const API_PREFIX = "/dsh-webin/api";
/**
 * ## 插件自己的 HTTP 端口（2026-10-17 架构调整）
 *
 * 真机上出现过「插件一开，连 DSH 官方接口都点不动」：插件的请求和 DSH
 * 主站共用同一个源和同一批连接，一旦插件的某条请求慢了，浏览器的连接池
 * 被占住，整个界面跟着排队。
 *
 * 把插件接口放到**独立端口**后：不同源 ⇒ 浏览器给它们各自独立的连接池，
 * 插件再慢也只会拖慢它自己的面板，不可能再阻塞 DSH 本身。
 */
const API_PORT = 38101;
/** 默认账号槽位名。 */
const DEFAULT_SLOT = "default";
/** 请求体上限，防止意外灌爆内存。 */
const BODY_LIMIT_BYTES = 2097152;
/** 状态根目录：`~/.dsh/webin/`。 */
function stateRoot() {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	return join(home, "webin");
}
/**
 * 单个槽位的快照文件路径。
 *
 * 槽位在磁盘上的名字是 **`平台#槽位`**（default 槽位就是平台名）—— 出处是
 * `slotNameFor()`，所以这里必须容得下 `#`。
 */
function snapshotPath(slot) {
  /**
   * ## ⚠️⚠️ 白名单必须含 `#`，长度必须够（2026-10-16 真机踩到，**多账号直接串号**）
   *
   * 曾经是 `/^[A-Za-z0-9_-]{1,64}$/` —— 两层限制**都致命**：
   *
   *   1. **不含 `#`** ⇒ `slotNameFor()` 产出的 `平台#槽位` 一律校验失败，
   *      回落到 `DEFAULT_SLOT`：
   *      ```
   *      deepseek#second -> auth/default.json    ← 全落到这一个文件
   *      deepseek#奶奶   -> auth/default.json
   *      ```
   *      后果是双向串号：
   *        · **读**：额外槽位去读 default 的快照，于是**冒充**它的登录态
   *          （实测 `/accounts` 里 `second` 报 `loggedIn:true via:snapshot`，纯假阳性）
   *        · **写**：额外槽位的快照会**覆盖 default 的**，两个账号互相踩
   *   2. **上限 64 偏小**：平台名上限 64、槽位上限 48，`平台#槽位` 最长 113
   *      ⇒ 长名字同样被静默打回 default。
   *
   * 所以：加 `#`，长度放到 160（64+1+48 还有余量）。
   *
   * ⚠️ 规则已收拢到 `lib/slot-names.js` 的 `isSafeSnapshotName()` ——
   * 这里只调用，**不再内联正则**。内联正则正是这次 bug 的成因（两处各写一份、
   * 各漏一样）。以后改规则只改那个模块，并跑 `node scripts/test-slot-names.mjs`。
   */
  const safe = isSafeSnapshotName(slot) ? slot : DEFAULT_SLOT;
  return join(stateRoot(), "auth", `${safe}.json`);
}
/**
 * 某平台某槽位的 **Edge profile 目录**（不依赖 EdgeDriver 实例）。
 *
 * 为什么要在 host 半复刻一份：登录门禁 `isPlatformLoggedIn` 是纯函数、
 * 在 `apply()` 之外调用，拿不到 driver 实例。而它需要知道「去哪个目录
 * 读 cookie」。
 *
 * ⚠️ 这里的**布局规则必须与 edge-driver.js 的 `userDataDirFor()` 保持一致**
 * （default 槽位不拼账号层）。两处不一致 = 判据和浏览器看不同的目录，
 * 那正是这次要修的 bug 的同类。改一处必须同步改另一处。
 */
function edgeProfileDirFor(platformId, accountId = "default") {
	const home = process.env.DSH_HOME ?? join(homedir(), ".dsh");
	const base = join(home, "edge-ldw");
	/**
	 * ⚠️ 这里**必须**用 `slot-names.js` 的 `safePathSegment`，不要内联
	 * `replace(/[^A-Za-z0-9_-]/g, "_")`（旧写法）—— 那会把**所有非 ASCII
	 * 都变成下划线**，于是「奶奶」和「爷爷」都成了 `__`，两个账号**共用
	 * 同一个浏览器 profile**、登录态互相覆盖。
	 *
	 * 而且这个函数与 `edge-driver.js` 的 `userDataDirFor()` **必须完全一致**：
	 * 一个算「去哪读 cookie」、一个算「浏览器实际用哪个 profile」，
	 * 不一致就会出现「判据说没登录、其实登录着」那类幽灵 bug。
	 */
	const safePlatform = safePathSegment(platformId, "unknown");
	const safeAccount = safePathSegment(accountId || "default", "default");
	/** default = 旧布局（平台一层），与 edge-driver 的 userDataDirFor 同步。 */
	if (safeAccount === "default") return join(base, safePlatform);
	return join(base, safePlatform, safeAccount);
}
/**
* 某个平台「已登录」吗？（多账号版：**任一槽位**登录过就算）
*
* ## 判据：槽位快照存在**且**快照里确实有登录凭据
*
* 单账号（无 accounts 配置）= 只有 default 槽位 = 旧文件名 `<平台>.json`，
* 行为与旧版完全一致。多账号时逐槽位查 `<平台>#<槽位>.json`。
*
* 为什么不看「浏览器在线」：那样重启 DSH 后、用户还没切到 LDW 标签时，
* 模型会从选择器里消失 —— 用户会以为插件坏了。
*
* ⚠️ 注意用 `snapshotTextLooksLoggedIn` 而不是「文件存在」——
* 未登录时页面也会写 `userToken={"value":null}`，那种快照不算登录。
*/
function isPlatformLoggedIn(platform) {
	try {
		/** 旧格式单文件（default 槽位 + 老版本写入的）。 */
		const legacyPath = snapshotPath(platform);
		if (existsSync(legacyPath) && snapshotTextLooksLoggedIn(readFileSync(legacyPath, "utf8"))) return true;
		/** 多账号槽位文件：`平台#槽位.json`。 */
		const slots = accountsForPlatform(readConfig().config.accounts, platform).slots ?? [];
		for (const slot of slots) {
			if (slot === "default") continue;
			const path = snapshotPath(`${platform}#${slot}`);
			if (existsSync(path) && snapshotTextLooksLoggedIn(readFileSync(path, "utf8"))) return true;
		}
		/**
		 * ## 第二条判据：直接读 Edge profile 的 Cookie（2026-10-16 加，破死锁）
		 *
		 * 为什么必须有这条：快照**只在任务跑通之后**才写，于是
		 *
		 * ```
		 *   没有快照 ⇒ 门禁判 false ⇒ 任务不入队 ⇒ runJob 不跑 ⇒ 快照写不出来
		 * ```
		 *
		 * 死锁。用户实测报的就是「我明明登录了，它一直说我没登录」——
		 * 登录态（`hy_token` 等）好好躺在 `<profile>/Default/Network/Cookies` 里，
		 * 只是判据没去那儿看。
		 *
		 * 这条判据的性质（都是用户明确关心的点）：
		 *   - **零成本**：只读 SQLite 文件，不起 Edge、不联网、不占内存
		 *   - **跨重启**：cookie 持久化，重启 DSH 后依然成立
		 *   - **不解密**：只看 cookie 名与密文长度，不碰值
		 *
		 * 失败一律**静默回退到 false**（等于维持旧行为），绝不因为读 cookie
		 * 出错就把插件搞挂 —— 那会让「配置坏了」升级成「插件坏了」。
		 */
		try {
			const accountId = accountsForPlatform(readConfig().config.accounts, platform).active ?? "default";
			const dir = edgeProfileDirFor(platform, accountId);
			const probe = peekCookieProbe(platform, dir);
			if (probe.loggedIn === true) return true;
			/**
			 * ## 自定义平台：判不了就**放行**（fail-open）
			 *
			 * `reason === "no-rule"` 意思是「这个平台没有 cookie 规则」——
			 * 也就是**内置四站之外的自定义 provider**（用户自己写的 JSON）。
			 *
			 * 为什么必须放行：自定义平台的登录方式千奇百怪（可能只要一个
			 * 匿名 session、可能是内网免登录），我们**没有判据也不该瞎判**。
			 * 之前一律 return false ⇒ 门禁永远拦着 ⇒ 自定义平台**根本用不了**
			 * （`listModels` 不列模型、`streamOnce` 直接报未登录）。这是真实 bug。
			 *
			 * 放行的代价可控：真正有没有登录，`runJob` 里还有一道
			 * `probe()` 守卫（找不到输入框就会抛错并说明原因），不会静默出错。
			 *
			 * ⚠️ 只在 `no-rule` 时放行：`no-login-cookie`（有规则但没凭据）
			 * 和 `profile-unreadable`（读不了）都必须保持 false，
			 * 否则内置四站会全部误判成已登录。
			 */
			if (probe.reason === "no-rule") return true;
		} catch { /* cookie 判据只是加分项，失败不影响旧判据 */ }
		return false;
	} catch {
		return false;
	}
}
/**
* 已登录的平台 id 列表（给状态接口与设置页用）。
*
* 注意判据是**登录快照**而不是「浏览器在线」—— 快照跨重启存活，
* 所以重启后未打开标签页时也能正确报告「这个平台登录过」。
*
* @param platforms - 平台清单（注册表在 `apply()` 内，所以由调用方传入）
*/
function loggedInPlatforms(platforms) {
	const out = [];
	for (const p of platforms) if (isPlatformLoggedIn(p.id)) out.push(p.id);
	return out;
}
/**
* 自定义 provider 的存放目录：`~/.dsh/webin/providers/`。
*
* 一个平台一个 `<id>.json`（内容是单个 Provider 对象）。
* 与登录态快照同一套存储策略：host 侧落盘，跨重启存活。
*/
function providersDir() {
	return join(stateRoot(), "providers");
}
/** 读全部自定义 provider（跳过读不动的文件，不因为一个坏文件全盘失败）。 */
async function readCustomProviders() {
	const dir = providersDir();
	const items = [];
	const errors = [];
	if (!existsSync(dir)) return {
		items,
		errors
	};
	let names;
	try {
		names = await readdir(dir);
	} catch (error) {
		return {
			items,
			errors: [{
				file: dir,
				reason: error?.message ?? String(error)
			}]
		};
	}
	for (const fileName of names) {
		if (!fileName.endsWith(".json")) continue;
		try {
			const text = await readFile(join(dir, fileName), "utf8");
			items.push(JSON.parse(text));
		} catch (error) {
			errors.push({
				file: fileName,
				reason: error?.message ?? String(error)
			});
		}
	}
	return {
		items,
		errors
	};
}
/** 写一个自定义 provider（原子写，文件名用 id）。 */
async function writeCustomProvider(provider) {
	const dir = providersDir();
	await mkdir(dir, { recursive: true });
	const path = join(dir, `${provider.id}.json`);
	await writeAtomic(path, JSON.stringify(provider, null, 2));
	return path;
}
/** 删一个自定义 provider。 */
async function removeCustomProvider(id) {
	const path = join(providersDir(), `${id}.json`);
	if (!existsSync(path)) return false;
	await unlink(path);
	return true;
}
/**
* 会话游标的持久化目录：`~/.dsh/webin/sessions/<platform>.json`。
*
* ## 为什么必须落盘（用户实测发现的缺陷）
*
* 「重启 DSH 后网页版又新开了一个会话，没接上之前那个窗口」。
*
* 根因：游标只在 host 内存里，重启即丢：
*   1. `diff.chatUrl` 为空 ⇒ job 不带 `expectUrl` ⇒ client 在首页发 ⇒ **新开对话**
*   2. 差分游标也丢 ⇒ 重启后第一轮**重发全部历史**（网页记录里又出现超长提示词）
*
* 落盘后两个问题一起解决：重启 → 恢复游标 → 任务带 `expectUrl` →
* client 导航回原对话 → 差分继续按原进度走。
*/
function sessionsDir() {
	return join(stateRoot(), "sessions");
}
/** 单个平台的会话映射文件。 */
function sessionsPath(platform) {
	const safe = /^[A-Za-z0-9_-]{1,64}$/.test(platform) ? platform : "unknown";
	return join(sessionsDir(), `${safe}.json`);
}
/** 配置文件路径：`~/.dsh/webin/config.json`。 */
function configPath() {
	return join(stateRoot(), "config.json");
}
/**
* 读配置。**坏文件不能让插件挂掉** —— 回退默认值并报告原因。
*
* ## 为什么加了按 mtime 的缓存（2026-10-17 真机事故）
*
* 这个函数在热路径上被反复调用：`/status`、`/accounts`、`listModels`，
* 每个平台每个槽位都要读一次。真机上「点模型切换就卡死」时，
* CPU 采样有 **37% 的时间落在这个函数里**。
*
* 现在按 `mtimeMs + size` 缓存：文件变了立刻重读（设置页保存仍然立即生效），
* 没变就直接用上次解析好的对象 —— 磁盘 I/O 和 JSON 解析都省掉了。
*/
let configCache = null;
function readConfig() {
	const path = configPath();
	if (!existsSync(path)) {
		configCache = null;
		return {
			config: { ...DEFAULT_CONFIG },
			problems: [],
			raw: ""
		};
	}
	try {
		const stat = statSync(path);
		const stamp = `${stat.mtimeMs}:${stat.size}`;
		if (configCache !== null && configCache.path === path && configCache.stamp === stamp) {
			return configCache.value;
		}
		const raw = readFileSync(path, "utf8");
		const checked = checkConfig(JSON.parse(raw));
		const value = {
			config: checked.config,
			problems: checked.problems,
			raw
		};
		configCache = { path, stamp, value };
		return value;
	} catch (error) {
		return {
			config: { ...DEFAULT_CONFIG },
			problems: [{
				field: "(file)",
				reason: `读取失败：${error?.message ?? String(error)}`,
				fellBackTo: "默认值"
			}],
			raw: ""
		};
	}
}
/** 写配置（原子写：先写临时文件再改名，避免留下半截文件）。 */
async function writeConfigFile(config) {
	await mkdir(stateRoot(), { recursive: true });
	const path = configPath();
	const tmp = `${path}.tmp`;
	await writeFile(tmp, JSON.stringify(config, null, 2), "utf8");
	await rename(tmp, path);
}
/** 读请求体（有上限）。 */
function readBody(req) {
	return new Promise((resolve, reject) => {
		const chunks = [];
		let total = 0;
		req.on("data", (chunk) => {
			total += chunk.length;
			if (total > BODY_LIMIT_BYTES) {
				reject(/* @__PURE__ */ new Error("body too large"));
				req.destroy();
				return;
			}
			chunks.push(chunk);
		});
		req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
		req.on("error", reject);
	});
}
/** 统一的 JSON 响应。 */
function sendJson(res, status, payload) {
	const body = JSON.stringify(payload);
	res.writeHead(status, {
		"content-type": "application/json; charset=utf-8",
		"cache-control": "no-store",
		"content-length": Buffer.byteLength(body)
	});
	res.end(body);
}
/** 原子写：先写临时文件再 rename，避免半截文件。 */
async function writeAtomic(path, content) {
	await mkdir(dirname(path), { recursive: true });
	const tmp = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(tmp, content, {
		encoding: "utf8",
		mode: 384
	});
	await rename(tmp, path);
}
/** 从 URL 取槽位名：`/dsh-webin/api/auth/<slot>/<suffix>`。 */
function slotFromPath(pathname, suffix) {
	const prefix = `${API_PREFIX}/auth/`;
	if (!pathname.startsWith(prefix)) return void 0;
	const rest = pathname.slice(prefix.length);
	if (!rest.endsWith(suffix)) return void 0;
	const raw = rest.slice(0, rest.length - suffix.length);
	if (raw === "") return void 0;
	/**
	 * ⚠️ 必须解码：中文槽位名（如「奶奶」）在 URL 里是 percent-encoded。
	 * 不解码的话，`snapshotPath()` 收到的是 `%E5%A5%B6...`，校验会拒它、
	 * 静默回落到 default 槽位 —— 又变成「所有槽位共用一个快照」那类串号。
	 * 畸形编码就原样返回，让后面的校验去拒（不要在这里抛）。
	 */
	try { return decodeURIComponent(raw); } catch { return raw; }
}
/** 从 URL 取任务 id：`/dsh-webin/api/job/<id>/<suffix>`。 */
function jobIdFromPath(pathname, suffix) {
	const prefix = `${API_PREFIX}/job/`;
	if (!pathname.startsWith(prefix)) return void 0;
	const rest = pathname.slice(prefix.length);
	if (!rest.endsWith(suffix)) return void 0;
	const id = rest.slice(0, rest.length - suffix.length);
	return id === "" ? void 0 : id;
}
/**
* client 心跳的存活阈值。
*
* ## ⚠️ 为什么从 15 秒放宽到 45 秒（**实测发现的问题**）
*
* 心跳间隔是 **5 秒**（client 侧 `setInterval(beat, 5000)`），
* 而第一版阈值是 **15 秒** —— 只容忍漏掉 **2 次**。
*
* 实测（连续观察运行中的 host，每 2 秒采样一次）：
*
*     12:06:42  心跳延迟=10943ms
*     12:06:44  心跳延迟=12975ms
*     12:06:46  心跳延迟=14985ms
*     12:06:48  在线 0 个          ← 掉线
*
* 延迟每次 +2000ms（正好是我的采样间隔）说明**心跳停了**而不是变慢。
* 一旦主线程被占住几秒（client 那边有 500ms / 1500ms / 5000ms 三个
* 定时器，每个都要跨进程 `executeJavaScript`），心跳就漏，
* 15 秒内漏 3 次即判死。
*
* 后果：`/status` 报 `online: 0`，用户以为面板没开。
*
* 45 秒 = 容忍漏掉 8 次，覆盖「主线程忙几秒」的正常抖动，
* 又能在一个面板真的关掉后 45 秒内反映出来。
*/
/**
* 客户端判死阈值。
*
* ## ⚠️ 为什么从 45 秒提到 150 秒（实测证据）
*
* 心跳间隔是 **5 秒**（client 侧 `setInterval(beat, 5000)`），但
* **Electron 会对不可见 webview 里的定时器做节流** —— 实测连续采样拿到：
*
*     [1] ageMs=44199  online=1
*     [2] ageMs=None   online=0   ← 被判死
*     [3] ageMs=2008   online=1   ← 又回来
*
* 44 秒的间隔**贴着 45 秒的阈值**，于是 `online` 在临界点来回抖动。
* 后果不只是状态显示难看 —— **`online=0` 时任务可能无人领取**
* （用户实测报过「任务无人领」）。
*
* 判死阈值的语义是「这个客户端真的没了」，而不是「它这一秒没说话」。
* 150 秒 = 5 秒心跳的 30 倍，足以覆盖节流到 ~1 次/分钟的最坏情况，
* 同时仍能在客户端真死时（比如窗口关了）及时回收。
*/
const CLIENT_STALE_MS = 15e4;
/**
* client 产物的绝对路径 —— 用来判断面板跑的是不是最新构建。
*
* 插件从 `lib/index.js` 跑，所以 client 产物在**同目录**的 `client.js`。
* 用 `import.meta.url` 定位，而不是 cwd（DSH 的 cwd 是用户工作区，
* 不是插件目录）。
*/
function clientBundlePath() {
	try {
		const here = fileURLToPath(import.meta.url);
		return join(dirname(here), "client.js");
	} catch {
		return join(process.cwd(), "lib", "client.js");
	}
}
/**
* 安全取一个命名 logger。
*
* `ctx.logger` 是 Cordis 的 **callable service**（`LoggerService` 用 `createCallable` 包装，
* 见 cordis `lib/index.js:594`），所以：
*   - `ctx.logger('ns')` → 命名 Logger 实例
*   - `ctx.logger.info(...)` → 也合法（`LoggerService.prototype` 上挂了直通方法，`:646`）
*
* ⚠️ 但**不能假设它一定可调用**：`?.()` 只防 null/undefined，不防"存在但不是函数"。
* 宿主版本差异或服务被替换时，一次 TypeError 就会让整个 `apply()` 抛出、
* 插件加载失败。所以这里显式判类型，任何异常都退化成空 logger —— 日志丢了不致命，
* 插件装不上才致命。
*/
function safeLogger(ctx) {
	try {
		const svc = ctx.logger;
		if (svc === void 0 || svc === null) return {};
		let target = svc;
		if (typeof svc === "function") target = svc("dsh-webin");
		if (target === null || typeof target !== "object") target = svc;
		const t = target;
		const pick = (fn) => typeof fn === "function" ? (m) => fn.call(target, m) : void 0;
		return {
			info: pick(t.info),
			warn: pick(t.warn),
			debug: pick(t.debug)
		};
	} catch {
		return {};
	}
}
async function apply(ctx) {
	const log = safeLogger(ctx);
	/** 在线客户端心跳（clientId → 最近一次心跳）。 */
	const beats = /* @__PURE__ */ new Map();
	/**
	* 上次更新检查结果（**缓存 60 秒**）。
	*
	* 未认证的 GitHub API 每小时只有 60 次配额 —— 用户在设置页连点几次
	* 「检查更新」就能把它打光。缓存一下，正常使用完全够。
	*
	* ## ⚠️ 按仓库分键（修掉的真实 bug）
	*
	* 早期是**一个模块级变量**。若用户在设置页把 repo 改成别的仓库，
	* 60 秒内仍会拿到**上一个仓库**的结果 —— 显示的是别人的版本信息。
	*
	* 现在用 Map 按 `owner/repo` 分键。
	*/
	const updateChecks = /* @__PURE__ */ new Map();
	/** 缓存有效期。 */
	const UPDATE_CACHE_MS = 6e4;
	/**
	* 各平台当前的 guest partition 名（由 client 上报）。
	*
	* ## 为什么需要（解决「重启必须重新登录」）
	*
	* DSH 分配的 partition 是 `dsh-sidebar-browser-${randomUUID()}` ——
	* **随机、内存分区**，host 猜不到名字。而只有拿到名字才能用
	* `session.fromPartition(name).cookies` 读写**含 httpOnly** 的 cookie
	* （那是 DeepSeek 登录态的真正载体，页面 JS 看不到）。
	*
	* client 半在 `browser.acquire()` 的返回值里拿得到，所以由它上报。
	* 重启后 client 会重新上报一个新的 partition 名 —— host 用存档里的
	* cookie 写回**新** partition，从而实现免登录。
	*/
	const partitions = /* @__PURE__ */ new Map();
	/**
	* 上报过身份的 DSH 会话（`sessionId` → 最后上报时刻）。
	*
	* client 半挂载 `conversation.view` 的 LDW 视图时上报自己窗口的
	* `sessionId`（DSH 的 standardProps 直接给）。用途：
	*   - `/status` 能列出「现在有哪些窗口挂着 LDW」
	*   - 排查「任务被别的窗口领走」时，对照任务的 `sessionId`
	*/
	const knownSessions = /* @__PURE__ */ new Map();
	const liveClients = () => {
		const now = Date.now();
		const out = [];
		for (const [id, beat] of beats) {
			if (now - beat.at > CLIENT_STALE_MS) {
				beats.delete(id);
				continue;
			}
			out.push(beat);
		}
		return out;
	};
	const registry = new ProviderRegistry();
	const queue = new JobQueue();
	/**
	* ## 端到端自测：直接往队列塞一个任务，看 client 能不能跑完整条链路
	*
	* ## 为什么需要（用户的话：「你自己测试吧！到目前为止，一次都没成功！」）
	*
	* 我之前的测试全是**离线单测** —— 只能证明「代码里写了什么」，
	* 证明不了「真跑起来能不能回显」。
	*
	* 而真正的端到端需要 DSH 调 LLM 接口派发任务 —— 我在测试脚本里
	* 做不到那一步。**但队列是同一个实例**（这个 `queue` 就是
	* `adapter` 用的那个），所以可以直接塞任务进去，让真实的 client
	* 去领、去发、去抓回复。
	*
	* 于是 `POST /selftest/echo` 能验证**除 DSH 派发之外的全部链路**：
	*
	*     塞任务 → client 领活 → 填输入框 → 点发送 → 网页版生成
	*            → 抓 DOM → 交结果 → 这里读结果
	*
	* 这是我能做到的最接近「真跑一遍」的验证。
	*/
	const selfTests = /* @__PURE__ */ new Map();
	/**
	* 游标落盘 —— **重启后接回原对话的关键**。
	*
	* 不落盘的话重启后：`chatUrl` 丢失 ⇒ 任务不带 `expectUrl` ⇒
	* client 在首页发 ⇒ **新开一个网页对话**（用户实测：「没接上之前的那个窗口」）；
	* 同时差分游标也丢 ⇒ 第一轮重发全部历史。
	*/
	const adapter = createAdapter({
		queue,
		logger: log,
		registry,
		/** 每轮读一次配置 —— 设置页改完立刻生效，不用重启。 */
		getConfig: () => readConfig().config,
		/**
		 * host 是否自己在驱动浏览器。
		 *
		 * 决定「无人领活宽限期」用 20 秒还是 3 分钟：host 驱动是串行的，
		 * 切换平台要关掉旧浏览器再用新档案启动（十几到几十秒），
		 * 用 20 秒会误判成「面板未连接」（2026-10-17 真机事故）。
		 */
		driverEnabled: () => edgeDriver.config.enabled === true,
		/**
		* 登录门禁：未登录的平台不列出模型、也不允许调用。
		* 用户要求「如果是已登录才能使用 LDW 那俩模型」。
		*/
		isLoggedIn: (platform) => isPlatformLoggedIn(platform),
		cursorStore: {
			load: (platform) => {
				const path = sessionsPath(platform);
				try {
					if (!existsSync(path)) return {};
					return JSON.parse(readFileSync(path, "utf8")).sessions ?? {};
				} catch (error) {
					log.warn?.(`读取会话映射失败 ${platform}: ${error?.message ?? String(error)}`);
					return {};
				}
			},
			save: (platform, key, cursor) => {
				const path = sessionsPath(platform);
				try {
					let all = {};
					if (existsSync(path)) try {
						all = JSON.parse(readFileSync(path, "utf8")).sessions ?? {};
					} catch {}
					if (cursor === void 0) delete all[key];
					else all[key] = cursor;
					mkdirSync(sessionsDir(), { recursive: true });
					writeFileSync(path, JSON.stringify({ sessions: all }, null, 2), "utf8");
				} catch (error) {
					log.warn?.(`写入会话映射失败 ${platform}: ${error?.message ?? String(error)}`);
				}
			}
		}
	});
	/**
	* ## ⭐⭐⭐ 真 Edge 驱动器（web 档案下的浏览器载体）
	*
	* ## 为什么需要
	*
	* webin 原版把「真浏览器」这一手交给 **DSH 桌面版（Electron）** 的 webview guest。
	* 但本机跑的是 **web 档案（纯 Node）** —— 没有 `globalThis.dshDesktop`，
	* 于是 client 半在 `desktopBrowser()` 直接 return，面板永不挂载 ⇒
	* LDW 登不上、任务无人领取。
	*
	* 这里在 host 半补一只「手」：用 CDP 驱动**本机真 Edge**，
	* 复用 webin 的**原生 DOM 脚本**（`edge-driver-scripts.js` 逐字提取自 client.js），
	* 干原本 webview 干的活：领活 → 填字 → 点发送 → 读回复 → 交结果。
	*
	* ## 为什么这不破坏 webin 的优势（用户明确要求「不要把 webin 的优势改掉」）
	*
	* 真浏览器 / 真打字 / 真点发送 / 不伪造 header / 从 hook 读流 / 差分发送 /
	* 工具调用 / 会话绑定 / 2~4 秒随机间隔 —— **全部保留**。
	* 换掉的**只有**「脚本在哪个 Chromium 里跑」。
	*
	* ## 按需启动 / 用完即退（用户对常驻进程敏感）
	*
	* 平时不跑；有任务才起 Edge；空闲 `idleShutdownMs` 后自动关掉。
	* 登录态写在独立 profile 目录（`.dsh/edge-ldw`），跨重启存活。
	*
	* ## 开关
	*
	* 配置 `edgeDriver.enabled = false` ⇒ 完全不动，回到 webin 原版行为。
	*/
	const edgeDriver = new EdgeDriver({
		config: {
			...EDGE_DRIVER_DEFAULTS,
			...readConfig().config.edgeDriver ?? {},
		},
		log,
		getProvider: (id) => registry.get(id),
		/** 没带账号的启动路径一律用「当前生效槽位」，避免误开空档案。 */
		getActiveAccount: (platformId) => activeAccountFor(platformId),
		/**
		 * 分段阈值全局同源（2026-10-23）：全局 .txt 三件套的 txtChunkBytes
		 * 直达驱动器——用户实测 40KB 文件没被 10KB 阈值分段就是这层断了。
		 * 每次读实时取（不缓存），UI 改完下一轮就生效。
		 */
		getGlobalTxtChunkBytes: () => config().txtChunkBytes,
	});
	edgeDriver.platformId = DEFAULT_PROVIDER_ID;
	/**
	* 驱动器自己发心跳 —— 否则 host 的看门狗（`reapStaleClaimed` 的 `alive` 判据）
	* 会认为「面板失联」，把超过 3 分钟的长生成任务误杀。
	*
	* 用同一个 `beats` 表，`/status` 里就会显示成一路在线客户端。
	*/
	const EDGE_DRIVER_CLIENT_ID = "edge-driver";
	ctx.effect(() => {
		const beat = () => {
			if (edgeDriver.proc === null) return;
			beats.set(EDGE_DRIVER_CLIENT_ID, {
				clientId: EDGE_DRIVER_CLIENT_ID,
				platform: edgeDriver.platformId,
				at: Date.now(),
				loggedIn: edgeDriver.lastProbeLoggedIn === true,
				hasGuest: true,
				replyCount: edgeDriver.stats.done,
			});
		};
		beat();
		const timer = setInterval(beat, 5e3);
		return () => {
			clearInterval(timer);
			beats.delete(EDGE_DRIVER_CLIENT_ID);
		};
	}, "dsh-webin: edge-driver heartbeat");
	/**
	* ## 开机自动唤醒（2026-10-18，用户点名）
	*
	* 「增加开机时是否自动启动某个账号的按钮。」
	*
	* 逻辑：读到 `autoWakeTarget`（`"平台#槽位"`）⇒ 延迟 `autoWakeDelayMs`
	* 后拉起该账号的 Edge（提前付掉冷启动，第一条消息能快点回）。
	* 之后窗口的去留交给 `idleShutdownMs`：闲置自动关、来活自动起 ——
	* 与「手动点启动」完全同一条路，不引入第二套生命周期。
	*
	* 防呆：
	*   - 格式不对/平台不存在 ⇒ 只记日志，不拉。
	*   - 失败一次就算了（不重试）—— 这是「提前热身」，不是关键路径。
	*   - 领活循环先起就让它起（谁先到算谁的）。
	*/
	ctx.effect(() => {
		if (edgeDriver.config.enabled !== true) return;
		const target = String(readConfig().config.autoWakeTarget ?? "").trim();
		if (target === "") return;
		const delay = Math.max(5e3, Number(readConfig().config.autoWakeDelayMs) || 45e3);
		const timer = setTimeout(() => {
			const [platformId, account = "default"] = target.split("#");
			const provider = registry.get(String(platformId ?? ""));
			if (provider === void 0) {
				log.warn?.(`[auto-wake] 配置的 autoWakeTarget「${target}」不是已注册平台，跳过`);
				return;
			}
			/** 槽位格式合法性交给现有的名字校验（与 UI 新建槽位同一套规则）。 */
			if (!isSafeSlotName(String(account))) {
				log.warn?.(`[auto-wake] 槽位名「${account}」不合法（${slotRuleText()}），跳过`);
				return;
			}
			if (edgeDriver.proc !== null) {
				log.info?.(`[auto-wake] 浏览器已在跑（平台 ${edgeDriver.platformId}），不重复唤醒`);
				return;
			}
			ensureEdgeQuietly(platformId, account);
		}, delay);
		return () => clearTimeout(timer);
	}, "dsh-webin: auto-wake on startup");
	/**
	* 把「起 Edge + 探登录态」包成静默版：任何失败只记日志。
	* （auto-wake 是热身，不是关键路径，绝不因它把启动期搅乱。）
	*/
	function ensureEdgeQuietly(platformId, account) {
		edgeDriver.ensureEdge(String(platformId), String(account)).then(() => {
			log.info?.(`[auto-wake] 已唤醒 ${platformId}#${account}（冷启动已提前，闲置后仍会按设置自动关）`);
			return edgeDriver.probe().catch(() => {});
		}).catch((e) => {
			log.warn?.(`[auto-wake] 唤醒 ${platformId}#${account} 失败（不影响后续正常使用）：${String(e?.message ?? e)}`);
		});
	}
	/**
	* 领活循环。默认**常驻轮询**（每 `pollIntervalMs` 一次），
	* 但真正起 Edge 只在「有任务可领」时 —— `ensureEdge()` 在 tick 里被调用，
	* 队列空时它不会启动浏览器。
	*
	* ⚠️ 为了让「队列空 ⇒ 不起 Edge」，这里先探一次队列：
	* 没有待领任务就直接返回，连 `ensureEdge` 都不进。
	*/
	/**
	 * 浏览器启动失败的退避状态 —— 提到 effect 外面，`/status` 才能把它报出去，
	 * 用户在设置页就能看到「已重试 N 次、X 秒后重试」，而不是干等。
	 */
	const launchBackoff = createLaunchBackoff();
	ctx.effect(() => {
		if (edgeDriver.config.enabled !== true) {
			log.info?.("edge-driver 未启用（edgeDriver.enabled = false）");
			return;
		}
		/**
		 * ## ⚠️ 启动失败必须退避（2026-10-17 实测事故）
		 *
		 * 浏览器起不来（CDP 连不上 / 启动即退出）时，原实现每 1.5 秒就重新
		 * `spawn` 一次 —— 独立实例实测 40 秒拉起 27 个 Chrome，主线程接近满核，
		 * HTTP 端口能连上却不回响应。手机上这就是「插件一启用整个界面失灵」。
		 *
		 * 现在：失败按 5s→15s→45s→120s 退避，同一「平台#槽位」连续失败 3 次
		 * 就把待领任务判失败并给出可读原因，不再空转。
		 */
		/**
		 * 重入锁：`ensureEdge` 可能要等十几秒（等 CDP 端口）。没有这把锁时，
		 * 1.5 秒一次的定时器会在等待期间再进来一次，**并发拉起第二个浏览器**，
		 * 浏览器起不来时就会变成「越卡越拉、越拉越卡」。
		 */
		let ticking = false;
		/** tick 开跑时刻（卡死自愈判据）。 */
		let tickStartedAt = 0;
		const tick = async () => {
			if (ticking) return;
			if (edgeDriver.busy === true || edgeDriver.stopping === true) return;
			ticking = true;
			tickStartedAt = Date.now();
			try {
				/**
				* 先看有没有活 —— 没有就完全不碰 Edge（省内存）。
				*
				* ⭐⭐ **多平台：不写死 deepseek**（用户点名要的「千问也能试」）
				*
				* 早期版本这里硬编码 `edgeDriver.platformId = DEFAULT_PROVIDER_ID`，
				* 于是**只有 deepseek 的任务有人领**，qwen 之类的任务会一直挂到
				* `claimGraceMs` 超时判失败。现在从队列里读出**真正有活待领**的那些
				* 平台，逐个处理。
				*
				* 串行是刻意的：webin 的设计就是「一次只用一个浏览器干活」
				* （`sendDelay*` 的随机间隔、全局单例），并行会同时暴露多个
				* 浏览器指纹并发的特征，反而危险。
				*/
				/**
				 * ⭐ 多账号（2026-10-16）：每个平台的任务再按**账号槽位**分组。
				 * 同平台不同槽位的任务要用不同的 Edge profile（不同登录身份），
				 * 驱动器是串行的，所以逐「平台×槽位」处理，切槽位时会自动重启
				 * Edge（ensureEdge 里 shutdownEdge）。
				 */
				const pendingTargets = [];
				{
					const seen = /* @__PURE__ */ new Set();
					for (const j of queue.inspect()) {
						if (j.state !== "pending" || !j.platform) continue;
						const key = `${j.platform}#${j.account ?? "default"}`;
						if (seen.has(key)) continue;
						seen.add(key);
						/** 任务没带账号 ⇒ 用**当前配置的生效槽位**，绝不退回空档案 default。 */
						pendingTargets.push({ platformId: j.platform, account: j.account ?? activeAccountFor(j.platform) });
					}
				}
				if (pendingTargets.length === 0) return;

				for (const { platformId, account } of pendingTargets) {
					if (edgeDriver.busy === true || edgeDriver.stopping === true) break;
					/** 这个「平台×槽位」的活还在不在？（前面的目标可能已经把它领走了） */
					if (!queue.inspect().some((j) => j.state === "pending" && j.platform === platformId && (j.account ?? "default") === account)) continue;

					/**
					 * 退避期内不再尝试启动 —— 否则浏览器起不来时会变成
					 * 「每个轮询都 spawn 一次」的启动风暴（实测 40 秒 27 次）。
					 */
					if (!launchBackoff.ready(platformId, account)) continue;

					try {
						await edgeDriver.ensureEdge(platformId, account);
						launchBackoff.ok(platformId, account);
					} catch (e) {
						/**
						 * 这个平台起不来（没浏览器 / 配置错 / CDP 连不上）⇒ 跳过它，
						 * 别让它拖垮别的平台；同时退避，避免启动风暴。
						 */
						const failure = launchBackoff.fail(platformId, account);
						const detail = String(e?.message ?? e);
						log.warn?.(
							`edge-driver 平台 ${platformId}#${account} 起不来（第 ${failure.count} 次，` +
							`${Math.round(failure.retryInMs / 1000)}s 内不再重试）: ${detail}`,
						);
						/**
						 * 连续失败到上限：**立刻**把该平台×槽位的待领任务判失败。
						 * 不这样做的话，界面会一直停在「生成中」，用户以为卡死了。
						 */
						if (failure.giveUp) {
							for (const j of queue.inspect()) {
								if (j.state !== "pending" || j.platform !== platformId) continue;
								if ((j.account ?? "default") !== account) continue;
								queue.settle(j.id, {
									error: `浏览器启动失败（已重试 ${failure.count} 次）：${detail}\n` +
										"请在 LDW 设置里确认浏览器路径可用、或先手动打开一次浏览器后重试。",
								});
							}
						}
						continue;
					}

					const job = queue.claimNext(platformId, void 0, account);
					if (job === void 0) continue;
					edgeDriver.busy = true;
					edgeDriver.pending = { jobId: job.id, startedAt: Date.now() };
					edgeDriver.stats.claimed++;
					log.info?.(`edge-driver 领到任务 ${job.id}（平台 ${platformId}，${String(job.prompt ?? "").length} 字符）`);
					try {
						const provider = registry.get(job.platform ?? platformId);
						const r = await edgeDriver.runJob(job, provider);
						edgeDriver.lastProbeLoggedIn = true;
						queue.settle(job.id, {
							text: r.text,
							think: r.think,
							status: r.status,
							...r.chatUrl === "" ? {} : { chatUrl: r.chatUrl }
						});
						edgeDriver.stats.done++;
						log.info?.(`edge-driver 任务 ${job.id} 完成（${r.text.length} 字符，via ${r.via}）`);
						/**
						* 顺手写一份登录态快照。
						*
						* 为什么必须写：host 的 `isPlatformLoggedIn(platform)` 判据是
						* **快照文件存在且里面有凭据**（不是「浏览器在线」）——
						* 快照是跨重启的持久证据，模型选择器靠它决定「LDW 模型列不列出来」。
						* 驱动器跑通一次就说明确实登录着，这时补一份最准。
						*/
						try {
							const snap = await edgeDriver.snapshot();
							if (typeof snap === "string" && snap.trim() !== "" && snap.trim() !== "{}") {
								/** ⭐ 按任务携带的账号槽位写快照（多账号隔离）。 */
								await writeAtomic(snapshotPath(slotNameFor(job.platform ?? platformId, job.account)), snap);
							}
						} catch (e) {
							log.debug?.(`edge-driver 写快照失败（不影响本轮）: ${String(e?.message ?? e)}`);
						}
					} catch (e) {
						edgeDriver.stats.failed++;
						const msg = String(e?.message ?? e);
						log.warn?.(`edge-driver 任务 ${job.id} 失败: ${msg}`);
						queue.settle(job.id, { error: msg });
					} finally {
						edgeDriver.busy = false;
						edgeDriver.pending = null;
						edgeDriver.lastJobAt = Date.now();
						/**
						 * 同一个平台的连续任务之间插入停顿 —— 照抄 webin
						 * 「不让请求呈固定节奏」的意图。
						 */
						const gap = 800 + Math.floor(Math.random() * 1200);
						await new Promise((r) => setTimeout(r, gap));
					}
				}
				edgeDriver.touchIdle();
			} catch (e) {
				if (edgeDriver.config.verboseLog) log.debug?.(`edge-driver 循环异常: ${String(e?.message ?? e)}`);
			} finally {
				// 无论成功失败都要放锁，否则一次异常会让轮询永久停摆。
				ticking = false;
			}
		};
		const timer = setInterval(() => {
			/**
			* ## ⏰ ticking 卡死自愈（2026-10-19 实测事故）
			*
			* 事故链：tick 里任何一步的 await 挂死（如 portAlive 的裸 fetch 对着
			* 半死端口、或 CDP 连接不回）⇒ finally 永远不执行 ⇒ `ticking` 永远
			* true ⇒ **领活循环整体停摆**——队列里的任务全靠 claimGrace 超时判死，
			* 驱动器 stats.claimed 永远 0（真机：job-1..9 全部无人领）。
			*
			* 修法：interval 里监控「tick 开跑后超过 3 分钟还没回来」⇒ 强制放锁
			* （不 kill 正在跑的活——它若真在长任务里，busy 会是 true，
			* 下个 tick 会因 busy 跳过；放锁只是让「挂死的等待」不再拖死整条流水线）。
			* 正常一轮 tick 最长 3 分钟（切平台 ~30s + 领活），给它 3 分钟上限
			* 再打 50% 余量。
			*/
			if (ticking && Date.now() - tickStartedAt > 27e4) {
				log.warn?.("edge-driver 领活循环疑似挂死（>4.5 分钟未归）——强制放锁自愈");
				ticking = false;
			}
			void tick();
		}, Math.max(500, edgeDriver.config.pollIntervalMs));
		void tick();
		return () => {
			clearInterval(timer);
			edgeDriver.stopLoop();
			void edgeDriver.shutdownEdge("插件卸载");
		};
	}, "dsh-webin: edge-driver loop");
	/** 当前注册了哪些路由（自定义 provider 增删后要重注册）。 */
	let registeredRoutes = [];
	const syncProviders = () => {
		const routes = registry.all().map((p) => routeFor(p.id));
		if (routes.length === registeredRoutes.length && routes.every((r, i) => r === registeredRoutes[i])) return;
		for (const route of registeredRoutes) disposers.get(route)?.();
		disposers.clear();
		for (const route of routes) disposers.set(route, ctx.llm.registerAdapter([route], adapter));
		registeredRoutes = routes;
		log.info?.(`已注册 provider 路由：${routes.join(", ")}`);
	};
	const disposers = /* @__PURE__ */ new Map();
	ctx.effect(() => () => {
		for (const dispose of disposers.values()) dispose();
		disposers.clear();
		registeredRoutes = [];
	}, "dsh-webin: llm adapters");
	const initial = await readCustomProviders();
	if (initial.items.length > 0) {
		const loaded = registry.loadCustom(initial.items);
		if (loaded.accepted.length > 0) log.info?.(`已加载自定义 provider：${loaded.accepted.join(", ")}`);
		for (const r of loaded.rejected) log.warn?.(`自定义 provider #${r.index} 校验失败：${r.reason}`);
	}
	for (const e of initial.errors) log.warn?.(`自定义 provider 文件读取失败 ${e.file}：${e.reason}`);
	syncProviders();
	const handler = async (req, res) => {
		try {
			const url = new URL(req.url ?? "/", "http://127.0.0.1");
			const pathname = url.pathname;
			const method = (req.method ?? "GET").toUpperCase();
			/**
			* ## POST /client/partition —— client 上报它拿到的 guest partition 名
			*
			* ## 为什么需要这个（解决「重启必须重新登录」）
			*
			* DSH 给 guest 分配的 partition 是 `dsh-sidebar-browser-${randomUUID()}`
			* （`lib/main.js:9638`）—— **无 `persist:` 前缀 = 内存分区**，
			* 进程退出 cookie 全丢。
			*
			* 而 DeepSeek 的登录态主要靠 **httpOnly cookie**：页面里的
			* `document.cookie` 看不见也写不了。所以只靠页面侧快照
			* **天生补不全**（用户实测：「每次重启 dsh 都需要重新登陆」）。
			*
			* partition 名是随机的、host 猜不到 —— 但 client 半在
			* `browser.acquire()` 的返回值里拿得到。上报后，host 就能用
			* Electron 的 `session.fromPartition(name).cookies` 读写**含
			* httpOnly** 的完整 cookie。
			*
			* ⚠️ 拿不到 electron（纯 node / 测试环境）时**不能报错** ——
			* 那会让 client 的这次上报看起来像失败。返回 `cookieApi:false`
			* 让 client 知道走的是降级路径。
			*/
			if (method === "POST" && pathname === `${API_PREFIX}/client/partition`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const platform = typeof payload.platform === "string" ? payload.platform : "";
				const partition = typeof payload.partition === "string" ? payload.partition : "";
				const domain = typeof payload.domain === "string" ? payload.domain : "";
				if (platform === "" || partition === "") {
					sendJson(res, 400, {
						ok: false,
						reason: "missing platform/partition"
					});
					return;
				}
				partitions.set(platform, {
					partition,
					domain,
					at: Date.now()
				});
				sendJson(res, 200, {
					ok: true,
					/** electron 可用时才能真正读写 httpOnly cookie。 */
					cookieApi: cookieApiAvailable(),
					/** 有没有存档可以写回。 */
					archived: loadCookieArchive(stateRoot(), platform) !== void 0
				});
				return;
			}
			/** POST /auth/<platform>/cookies —— 抓取当前 partition 的 cookie 并存档。 */
			if (method === "POST" && pathname.startsWith(`${API_PREFIX}/auth/`) && pathname.endsWith("/cookies")) {
				const platform = decodeURIComponent(pathname.slice(`${API_PREFIX}/auth/`.length, -8));
				const known = partitions.get(platform);
				if (known === void 0) {
					sendJson(res, 409, {
						ok: false,
						reason: "还不知道该平台的 partition —— 请先打开 LDW 标签让它上报"
					});
					return;
				}
				const domain = known.domain === "" ? platform : known.domain;
				const cookies = await grabCookies(known.partition, domain);
				if (cookies === void 0) {
					sendJson(res, 501, {
						ok: false,
						reason: "当前环境拿不到 Electron session API（无法读取 httpOnly cookie）"
					});
					return;
				}
				saveCookieArchive(stateRoot(), {
					platform,
					cookies,
					at: Date.now()
				});
				sendJson(res, 200, {
					ok: true,
					count: cookies.length,
					domain
				});
				return;
			}
			/** GET /auth/<platform>/cookies —— 把存档写回当前 partition。 */
			if (method === "GET" && pathname.startsWith(`${API_PREFIX}/auth/`) && pathname.endsWith("/cookies")) {
				const platform = decodeURIComponent(pathname.slice(`${API_PREFIX}/auth/`.length, -8));
				const known = partitions.get(platform);
				if (known === void 0) {
					sendJson(res, 409, {
						ok: false,
						reason: "还不知道该平台的 partition"
					});
					return;
				}
				const archive = loadCookieArchive(stateRoot(), platform);
				if (archive === void 0) {
					sendJson(res, 404, {
						ok: false,
						reason: "没有 cookie 存档"
					});
					return;
				}
				const n = await restoreCookies(known.partition, archive.cookies);
				sendJson(res, 200, {
					ok: n > 0,
					restored: n,
					total: archive.cookies.length,
					...n === 0 ? { reason: "写回失败（可能拿不到 Electron session API）" } : {}
				});
				return;
			}
			/**
			* ## POST /selftest/echo —— 端到端自测：真的发一条消息，等真的回复
			*
			* ## 为什么需要（用户：「你自己测试吧！到目前为止，一次都没成功！」）
			*
			* 真正的端到端要 DSH 调 LLM 派发任务，测试脚本做不到。
			* **但队列是同一个实例** —— 直接塞进去，真实 client 会领走、
			* 填输入框、点发送、抓 DOM、交结果。
			*
			* 所以这个路由能验证除「DSH 派发」外的**全部链路**。
			*
			* 用法：
			*     POST /selftest/echo  {"prompt":"1+1=?","platform":"deepseek"}
			*     → {"ok":true,"jobId":"job-..."}
			*     然后 GET /selftest/echo/<jobId> 读结果
			*/
			if (method === "POST" && pathname === `${API_PREFIX}/selftest/echo`) {
				/**
				* ## POST /test-send —— 大肥鱼自测（2026-10-20）：同步版完整链路测试。
				* body {platform?, slot?, text?} → enqueue → 驱动器自动领 → 网页真发 → 回复。
				* 位置借 echo 的壳：比 echo 更进一步——直接等回复返回（echo 只入队）。
				*/
				if (pathname === `${API_PREFIX}/selftest/echo` && method === "POST") {
					const body2 = await readBody(req);
					let payload2;
					try { payload2 = JSON.parse(body2 === "" ? "{}" : body2); } catch { payload2 = {}; }
					if (payload2?.wait === true) {
						const platformId = typeof payload2.platform === "string" && payload2.platform !== "" ? payload2.platform : "deepseek";
						const account = typeof payload2.slot === "string" && payload2.slot !== "" ? payload2.slot : activeAccountFor(platformId);
						const text = typeof payload2.text === "string" && payload2.text.trim() !== "" ? payload2.text : "你好，这是一条测试消息。";
						const provider2 = registry.get(platformId);
						if (provider2 === undefined) { sendJson(res, 404, { ok: false, reason: `平台 ${platformId} 不存在` }); return; }
						if (edgeDriver.busy === true) { sendJson(res, 409, { ok: false, reason: "driver-busy" }); return; }
						
						const job2 = queue.enqueue(text, false, provider2.id, void 0, true, void 0, account);
						log.info?.(`[test-send] ${platformId}#${account} 已入队（job ${job2.id}）`);
						/** waitForJob 在闭包外不可见——入队即回 202，结果走 GET /status 的 jobs 轮询。 */
						sendJson(res, 202, { ok: true, jobId: job2.id, queued: true });
						return;
					}
				}
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const prompt = String(payload.prompt ?? "").trim();
				if (prompt === "") {
					sendJson(res, 400, {
						ok: false,
						reason: "prompt 不能为空"
					});
					return;
				}
				const platform = String(payload.platform ?? "deepseek");
				if (registry.all().find((p) => p.id === platform) === void 0) {
					sendJson(res, 400, {
						ok: false,
						reason: `未知平台 ${platform}`,
						platforms: registry.all().map((p) => p.id)
					});
					return;
				}
				/**
				* ⚠️ **不带 sessionId** —— 这样任何窗口都能领走（`hasIdentity`
				* 那侧的兼容路径），避免自测因为窗口没上报身份而领不到。
				*/
				const job = queue.enqueue(prompt, false, platform);
				selfTests.set(job.id, {
					prompt,
					at: Date.now()
				});
				sendJson(res, 200, {
					ok: true,
					jobId: job.id,
					prompt,
					platform,
					hint: `GET ${API_PREFIX}/selftest/echo/${job.id} 读结果`
				});
				return;
			}
			/**
			* GET /selftest/echo/<jobId> —— 读自测结果
			*
			* 返回任务的**完整状态**（pending / claimed / done / failed），
			* 以及拿到的回复正文。这样「到底跑到哪一步」一眼可见。
			*/
			if (method === "GET" && pathname.startsWith(`${API_PREFIX}/selftest/echo/`)) {
				const jobId = decodeURIComponent(pathname.slice(`${API_PREFIX}/selftest/echo/`.length));
				const job = queue.get(jobId);
				if (job === void 0) {
					sendJson(res, 404, {
						ok: false,
						reason: "没有这个任务",
						jobId
					});
					return;
				}
				const mine = selfTests.get(jobId);
				sendJson(res, 200, {
					ok: true,
					jobId,
					prompt: mine?.prompt ?? job.prompt,
					elapsedMs: Date.now() - (mine?.at ?? job.createdAt),
					state: job.done !== void 0 ? "done" : job.failed !== void 0 ? job.cancelled === true ? "cancelled" : "failed" : job.claimedAt !== void 0 ? "claimed" : "pending",
					claimedBy: job.claimedBy ?? "(未领)",
					/** 拿到的回复正文（这就是「回显」的内容）。 */
					...job.done === void 0 ? {} : {
						text: job.done.text,
						think: job.done.think
					},
					...job.failed === void 0 ? {} : { error: job.failed }
				});
				return;
			}
			/**
			* ## GET /diagnose/electron —— 为什么拿不到 Electron session
			*
			* 用户要求「不要猜」。`cookieApi: false` 只是一个布尔值，
			* 分不清是 `import.meta.url` 拿不到、`require` 抛错、
			* 还是 electron 拿到了但 session 是空壳。
			*
			* 这个路由把**每一步的结果和错误原文**都返回出来 ——
			* 一眼看出卡在哪，不用再猜。
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/diagnose/electron`) {
				sendJson(res, 200, {
					ok: true,
					...diagnoseElectron()
				});
				return;
			}
			/**
			* ## POST /client/session —— client 上报「我挂在哪个 DSH 会话上」
			*
			* ## 为什么需要（用户报的「所有窗口都生效」）
			*
			* 早期 `/job/next` 只按平台过滤 ⇒ **任何窗口都能领走任何任务**。
			* 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个
			* 会话窗口」、「所有窗口都生效」。
			*
			* client 半从 `conversation.view` 的 standardProps 拿到 `sessionId`
			* （**DSH 官方提供的 prop**，见 Slots Inspect 的 standardProps 列表），
			* 挂载时上报一次。之后领活带上 `?session=<id>`，host 只派匹配的。
			*
			* ⚠️ 上报失败不影响功能（退回按平台派发），所以这里**不返回错误**
			* 给用户造成困扰 —— 只记日志。
			*/
			if (method === "POST" && pathname === `${API_PREFIX}/client/session`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const sid = typeof payload.sessionId === "string" ? payload.sessionId.trim() : "";
				if (sid === "") {
					sendJson(res, 400, {
						ok: false,
						reason: "missing sessionId"
					});
					return;
				}
				knownSessions.set(sid, Date.now());
				/** 顺手清理 10 分钟没上报的（窗口关了）。 */
				const cutoff = Date.now() - 6e5;
				for (const [id, at] of knownSessions) if (at < cutoff) knownSessions.delete(id);
				sendJson(res, 200, {
					ok: true,
					known: knownSessions.size
				});
				return;
			}
			/**
			* ## POST /client/diag —— 页面侧异常落盘（手机排障用）
			*
			* 手机上接不了调试器，界面失灵时只有一句用户描述。客户端把未捕获异常、
			* 未处理的 Promise 拒绝、启动阶段写到这里，host 追加到
			* `<DSH_HOME>/webin/client-diag.log`（超过 512KB 先截断，避免无限长）。
			*
			* 只记错误与阶段，不记对话内容、不记凭据。
			*/
			if (method === "POST" && pathname === `${API_PREFIX}/client/diag`) {
				try {
					const body = await readBody(req);
					const payload = JSON.parse(body || "{}");
					const line = JSON.stringify({
						at: new Date(typeof payload.at === "number" ? payload.at : Date.now()).toISOString(),
						kind: String(payload.kind ?? "").slice(0, 64),
						bridge: String(payload.bridge ?? "").slice(0, 32),
						ua: String(payload.ua ?? "").slice(0, 200),
						href: String(payload.href ?? "").slice(0, 200),
						detail: String(payload.detail ?? "").slice(0, 4000)
					});
					const file = join(stateRoot(), "client-diag.log");
					mkdirSync(dirname(file), { recursive: true });
					try {
						if (statSync(file).size > 512 * 1024) writeFileSync(file, "");
					} catch { /* 文件还不存在 */ }
					writeFileSync(file, line + "\n", { flag: "a" });
					sendJson(res, 200, { ok: true });
				} catch (error) {
					sendJson(res, 400, { ok: false, reason: String(error?.message ?? error) });
				}
				return;
			}
			/**
			* ## GET /build —— 当前 client 产物的构建号（给注入脚本轮询用）
			*
			* 注入到 `index.html` 的自检脚本每隔几秒问一次；rev 变了就重载。
			* 这样**不依赖** DSH 的 HMR（实测它浏览器端不消费 `rebuilt` 帧）。
			*
			* ⚠️ 这个路由要**极轻**：它每几秒被每个页面请求一次。
			* 只 stat 一个文件，不做别的。
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/build`) {
				let rev = "unknown";
				let mtimeMs = 0;
				try {
					const p = clientBundlePath();
					const st = statSync(p);
					mtimeMs = st.mtimeMs;
					/**
					* 与 DSH 的 `artifactRevision` **同算法**（framedHash + mtime/ctime/size）——
					* 这样我们的 rev 和 graph 里那个一致，排查时能直接对照。
					*/
					rev = createHash("sha1").update("plugin-artifact").update("\0").update(`${String(Buffer.byteLength(String(st.mtimeMs)))}:`).update(String(st.mtimeMs)).update(`${String(Buffer.byteLength(String(st.ctimeMs)))}:`).update(String(st.ctimeMs)).update(`${String(Buffer.byteLength(String(st.size)))}:`).update(String(st.size)).digest("hex").slice(0, 12);
				} catch {}
				sendJson(res, 200, {
					ok: true,
					rev,
					mtimeMs,
					builtAt: currentVersion().builtAt
				});
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/job/next`) {
				const platform = url.searchParams.get("platform") ?? void 0;
				/**
				* ## ⭐ `?session=<sessionId>` —— 来领活的窗口是哪个 DSH 会话
				*
				* ## 为什么必须有（用户报的「所有窗口都生效」）
				*
				* 早期只按 `platform` 过滤 ⇒ **任何 DSH 窗口都能领走任何任务**。
				* 用户实测：「换了几个 dsh 窗口聊天，发现全都是在网页版的同一个
				* 会话窗口」、「所有窗口都生效」。
				*
				* client 半从 `conversation.view` 的 standardProps 拿到
				* `sessionId`（**DSH 官方提供的 prop**，见 Slots Inspect 的
				* `standardProps` 列表），领活时带上。
				*
				* ⚠️ 没带时退回「按平台派发」（向后兼容）—— 否则老 client
				* 的任务会永远没人领。
				*/
				const session = url.searchParams.get("session") ?? void 0;
				/**
				* `?running=<jobId>` —— client 报告「我正在跑哪个任务」。
				*
				* 用途：用户按停止后 host 会把任务标记为 `cancelled`，
				* client 靠这个参数问「我这个任务还算数吗」。
				* 不算数就去按页面的停止按钮，别让页面白生成到结束（烧配额）。
				*/
				const running = url.searchParams.get("running") ?? void 0;
				if (running !== void 0 && running !== "") {
					const current = queue.get(running);
					if (current === void 0 || current.cancelled === true) {
						sendJson(res, 200, {
							ok: true,
							job: null,
							cancel: running
						});
						return;
					}
				}
				const job = queue.claimNext(platform, session);
				if (job === void 0) {
					sendJson(res, 200, {
						ok: true,
						job: null,
						clientOnline: queue.hasClaimed()
					});
					return;
				}
				sendJson(res, 200, {
					ok: true,
					job: {
						id: job.id,
						prompt: job.prompt,
						thinking: job.thinking,
						platform: job.platform,
						/** 该任务属于哪个 DSH 会话 —— client 可据此确认没领错。 */
						...job.sessionId === void 0 ? {} : { sessionId: job.sessionId },
						/**
						* 该任务所属 DSH 会话绑定的网页对话 URL。
						* client 发现当前页面不在这里时，先导航过去再发送 ——
						* 否则所有 DSH 会话挤一个网页对话（封号级缺陷）。
						*/
						...job.expectUrl === void 0 ? {} : { expectUrl: job.expectUrl },
						/**
						* 首轮（无绑定）：client 必须**开新对话**，不能占用当前页 ——
						* 否则两个 DSH 会话会挤进同一个网页对话。
						*/
						...job.freshChat === true ? { freshChat: true } : {}
					}
				});
				return;
			}
			const resultJobId = jobIdFromPath(pathname, "/result");
			if (method === "PUT" && resultJobId !== void 0) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				if (payload.via === "dom-scrape") log.warn?.(`job ${resultJobId} 的结果来自 DOM 兜底（hook 未捕获 SSE）—— 若频繁出现请点「诊断」查看 postPaths`);
				const settled = typeof payload.error === "string" && payload.error !== "" ? queue.settle(resultJobId, { error: payload.error }) : queue.settle(resultJobId, {
					text: String(payload.text ?? ""),
					think: String(payload.think ?? ""),
					status: String(payload.status ?? "finished"),
					/**
					* 发送成功后所在的页面 URL —— host 记住它，
					* 让该 DSH 会话的后续任务都导航回这个对话接着聊。
					*/
					...typeof payload.chatUrl === "string" && payload.chatUrl !== "" ? { chatUrl: payload.chatUrl } : {}
				});
				log.debug?.(`job ${resultJobId} settled=${String(settled)}`);
				sendJson(res, settled ? 200 : 404, { ok: settled });
				return;
			}
			const getSlot = slotFromPath(pathname, "/snapshot");
			if (method === "GET" && getSlot !== void 0) {
				const path = snapshotPath(getSlot);
				if (!existsSync(path)) {
					sendJson(res, 404, {
						ok: false,
						reason: "no-snapshot"
					});
					return;
				}
				const text = await readFile(path, "utf8");
				res.writeHead(200, {
					"content-type": "application/json; charset=utf-8",
					"cache-control": "no-store"
				});
				res.end(text);
				return;
			}
			if (method === "PUT" && getSlot !== void 0) {
				const body = await readBody(req);
				try {
					JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				await writeAtomic(snapshotPath(getSlot), body);
				log.info?.(`auth snapshot saved: slot=${getSlot} bytes=${body.length}`);
				sendJson(res, 200, {
					ok: true,
					slot: getSlot,
					bytes: body.length
				});
				return;
			}
			if (method === "DELETE" && getSlot !== void 0) {
				const path = snapshotPath(getSlot);
				if (existsSync(path)) await unlink(path);
				sendJson(res, 200, {
					ok: true,
					slot: getSlot
				});
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/auth`) {
				let slots = [];
				try {
					slots = (await readdir(join(stateRoot(), "auth"))).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
				} catch {
					slots = [];
				}
				sendJson(res, 200, {
					ok: true,
					slots,
					root: stateRoot()
				});
				return;
			}
			/**
			* ## GET /accounts —— 多账号管理（2026-10-16，用户点名要的）
			*
			* 返回每个平台的账号槽位、当前生效槽位、以及「该槽位登录过没有」。
			* 设置页据此渲染「账号槽位列表 + 切换 + 新增」。
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/accounts`) {
				const { config: cfg, problems } = readConfig();
				const accounts = cfg.accounts ?? {};
				const platforms = registry.all().map((p) => {
					const entry = accountsForPlatform(accounts, p.id);
					/**
					 * 逐槽位查登录态。
					 *
					 * ## 两条判据（2026-10-16 修）
					 *
					 * 原来只看**快照文件**，于是出现「明明登录了，设置页却显示未登录」——
					 * 因为快照只在任务跑通后才写，而门禁不让未登录的任务入队 ⇒ 死锁。
					 *
					 * 现在与 `isPlatformLoggedIn` 保持一致：快照 **或** cookie 任一命中即算登录。
					 * cookie 判据按**该槽位自己的 profile 目录**查，所以多账号之间不会串。
					 */
					const slotStatus = entry.slots.map((slot) => {
						let loggedIn = false;
						let via = "";
						let cookie = "";
						try {
							const path = snapshotPath(slotNameFor(p.id, slot));
							if (existsSync(path) && snapshotTextLooksLoggedIn(readFileSync(path, "utf8"))) {
								loggedIn = true;
								via = "snapshot";
							}
						} catch {}
						if (!loggedIn) {
							try {
								const probe = peekCookieProbe(p.id, edgeProfileDirFor(p.id, slot));
								if (probe.loggedIn === true) {
									loggedIn = true;
									via = "cookie";
									cookie = probe.cookie ?? "";
								}
							} catch {}
						}
						return { slot, loggedIn, via, ...cookie === "" ? {} : { cookie } };
					});
					return {
						platform: p.id,
						name: p.name,
						slots: entry.slots,
						active: entry.active,
						/** 被隐藏（不在模型栏显示）的槽位。 */
						hiddenInModels: entry.hiddenInModels ?? [],
						slotStatus
					};
				});
				sendJson(res, 200, {
					ok: true,
					platforms,
					/** 配置归一化时丢弃/回退的字段（设置页提示用户）。 */
					problems: problems.filter((pr) => pr.field.startsWith("accounts"))
				});
				return;
			}
			/**
			* ## PUT /accounts —— 更新一个平台的账号槽位表 / 切换当前账号
			*
			* body：`{"platform":"deepseek","slots":["default","work"],"active":"work"}`
			*
			* 只改这一个平台，其他平台的配置原样保留（read-modify-write）。
			* 原子写，坏配置会被归一化层拦住。
			*/
			/**
			* ## POST /providers/:id/detect-models —— 模型清单自动识别（2026-10-18，用户点名）
			*
			* 「元宝其实有 hy3,hy4,deepseek 三个模型……建议代码能够自动识别而不是死的。」
			*
			* 流程：起（或复用）该平台的 Edge → 打开平台首页 → 找到「模型选择」
			* 弹层 → 点开 → 全量读取选项 → 存进 `detected-models/<平台>.json` →
			* 从此 listModels 把它们合并进去。
			*
			* - 探测期间 `edgeDriver` 被占用 ⇒ 正在跑任务时返回 409，前端提示稍后再点。
			* - 浏览器没登录 ⇒ 返回和发送一样的可读错误（「先登录」）。
			* - 探测失败（页面没弹层/结构变了）⇒ ok:false 但**不破坏**内置清单。
			*/
			if (method === "POST" && /^\/dsh-webin\/api\/providers\/([A-Za-z0-9_-]+)\/detect-models$/.test(pathname)) {
				const id = pathname.match(/^\/dsh-webin\/api\/providers\/([A-Za-z0-9_-]+)\/detect-models$/)[1];
				const provider = registry.all().find((p) => p.id === id);
				if (provider === void 0) { sendJson(res, 404, { ok: false, reason: `平台 ${id} 不存在` }); return; }
				const account = activeAccountFor(id);
				if (edgeDriver.busy === true) { sendJson(res, 409, { ok: false, reason: "busy", message: "驱动器正在跑任务，稍后再探测" }); return; }
				try {
					await edgeDriver.ensureEdge(id, account);
					/** 确保落在平台域里（Edge 可能还停在 about:blank）。 */
					const cur = String(await edgeDriver.evalInPage("location.href", 10000).catch(() => ""));
					if (!new RegExp(provider.urlPattern).test(cur)) await edgeDriver.goto(provider.homeUrl);
					await edgeDriver.waitForPageSettled?.(provider).catch(() => {});
					const det = await edgeDriver.detectPageModels(provider);
					if (det.ok !== true) { sendJson(res, 200, { ok: false, reason: det.reason ?? "unknown", items: [] }); return; }
					/** 两层：模型层（Models 子菜单）+ 模式层（思考强度）。 */
					const models = modelsFromItems(det.models, id);
					const modes = modesFromItems(det.modes);
					const saved = saveDetected(stateRoot(), id, models, modes, det.raw);
					log.info?.(`[detect-models] 平台 ${id} 探测到 ${models.length} 个模型 + ${modes.length} 个模式（保存=${saved}）：模型=[${models.map((m) => m.pageModel).join(" / ")}] 模式=[${modes.map((m) => m.name).join(" / ")}]`);
					/** 触发同步：注册表里的 provider 不动（内置是兜底），合并发生在 listModels。 */
					syncProviders();
					sendJson(res, 200, { ok: true, count: models.length, models, modes, raw: det.raw });
				} catch (e) {
					sendJson(res, 500, { ok: false, reason: String(e?.message ?? e) });
				}
				return;
			}
			/**
			* ## GET /providers/:id/detected-models —— 只读探测缓存
			*
			* 前端「自动识别」卡片用它显示「上次探测时间 + 探测结果」。
			*/
			if (method === "GET" && /^\/dsh-webin\/api\/providers\/([A-Za-z0-9_-]+)\/detected-models$/.test(pathname)) {
				const id = pathname.match(/^\/dsh-webin\/api\/providers\/([A-Za-z0-9_-]+)\/detected-models$/)[1];
				const cached = loadDetected(stateRoot(), id);
				sendJson(res, 200, { ok: cached !== null, ...(cached ?? { models: [] }) });
				return;
			}
			/**
			* ## POST /accounts/rename —— **原地改名**（用户点名要的）
			*
			* body：`{"platform":"doubao","from":"default","to":"evelyn-doubao"}`
			*
			* 槽位名同时决定三样东西的路径，所以改名必须**一起搬**，否则
			* 改完就变成「新账号、未登录」：
			*   ① 浏览器档案 `edge-ldw/<平台>[/<槽位>]`
			*   ② 登录快照 `auth/<平台>[#<槽位>].json`
			*   ③ 凭据键 `credentials.json → accounts.<平台>.<槽位>`
			*
			* 搬不动就报错并**不改配置** —— 宁可没改，也不要留下半个状态。
			*/
			if (method === "POST" && pathname === `${API_PREFIX}/accounts/rename`) {
				const body = await readBody(req);
				let payload;
				try { payload = JSON.parse(body); } catch { sendJson(res, 400, { ok: false, reason: "invalid-json" }); return; }
				const platform = typeof payload?.platform === "string" ? payload.platform : "";
				const from = typeof payload?.from === "string" ? payload.from : "";
				const to = String(payload?.to ?? "").trim();
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(platform)) { sendJson(res, 400, { ok: false, reason: "invalid-platform" }); return; }
				if (!isSafeSlotName(to)) { sendJson(res, 400, { ok: false, reason: "invalid-slot", message: slotRuleText() }); return; }
				if (from === to) { sendJson(res, 400, { ok: false, reason: "same-name" }); return; }
				const cfgNow = readConfig().config;
				const accountsNow = { ...(cfgNow.accounts ?? {}) };
				const entry = accountsNow[platform];
				if (entry === void 0 || !Array.isArray(entry.slots) || !entry.slots.includes(from)) {
					sendJson(res, 404, { ok: false, reason: "no-such-slot", message: `平台 ${platform} 没有槽位「${from}」` });
					return;
				}
				if (entry.slots.includes(to)) {
					sendJson(res, 409, { ok: false, reason: "slot-exists", message: `槽位「${to}」已存在` });
					return;
				}
				const moved = [];
				try {
					/** ① 浏览器档案。from 为空/default 时是「平台一层」的旧布局，目标在它**内部**。 */
					const oldDir = edgeProfileDirFor(platform, from === "default" ? "default" : from);
					const newDir = edgeProfileDirFor(platform, to);
					if (oldDir !== newDir && existsSync(oldDir)) {
						if (from === "default" || from === "") {
							mkdirSync(newDir, { recursive: true });
							for (const item of readdirSync(oldDir)) {
								if (item === to) continue;
								renameSync(join(oldDir, item), join(newDir, item));
							}
						} else {
							mkdirSync(dirname(newDir), { recursive: true });
							renameSync(oldDir, newDir);
						}
						moved.push("profile");
					}
					/** ② 登录快照。 */
					const oldSnap = snapshotPath(slotNameFor(platform, from));
					const newSnap = snapshotPath(slotNameFor(platform, to));
					if (existsSync(oldSnap)) {
						mkdirSync(dirname(newSnap), { recursive: true });
						renameSync(oldSnap, newSnap);
						moved.push("snapshot");
					}
					/** ③ 凭据键。 */
					try {
						const store = loadCredentials();
						const bucket = store?.accounts?.[platform];
						if (bucket !== void 0 && bucket[from] !== void 0) {
							bucket[to] = bucket[from];
							delete bucket[from];
							saveCredentials(store);
							moved.push("credentials");
						}
					} catch { /* 凭据搬不动不影响改名本身 */ }
				} catch (error) {
					sendJson(res, 500, { ok: false, reason: "migrate-failed", message: `文件迁移失败：${String(error?.message ?? error)}` });
					return;
				}
				const slots = entry.slots.map((x) => (x === from ? to : x));
				const active = entry.active === from ? to : entry.active;
				await writeConfigFile({ ...cfgNow, accounts: { ...accountsNow, [platform]: { ...entry, slots, active } } });
				log.info?.(`账号改名：${platform} ${from} → ${to}（迁移 ${moved.join(" / ") || "无文件"}）`);
				sendJson(res, 200, { ok: true, platform, from, to, slots, active, moved });
				return;
			}
			if (method === "PUT" && pathname === `${API_PREFIX}/accounts`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, { ok: false, reason: "invalid-json" });
					return;
				}
				const platformId = payload?.platform;
				if (typeof platformId !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(platformId)) {
					sendJson(res, 400, { ok: false, reason: "invalid-platform" });
					return;
				}
				const { config: cfg } = readConfig();
				const accounts = { ...(cfg.accounts ?? {}) };
				/**
				 * 归一化写回：把单平台条目过一遍白名单再落盘。
				 * "default" 永远在 slots 里（隐式补全）。
				 *
				 * ⚠️ 非法槽位名**直接拒绝**（400），不静默丢弃（2026-10-16 修）。
				 * 原来这里 `filter` 掉就完事 —— 调用方（设置页/脚本）传个中文
				 * 槽位名「奶奶」，接口回 `ok:true`，但槽位列表里就是没有它，
				 * 调用方完全无从知道为什么。静默失效最难查，宁可报错。
				 */
				const wantSlots = Array.isArray(payload.slots) ? payload.slots : ["default"];
				const badSlots = wantSlots.filter((s) => !isSafeSlotName(s));
				if (badSlots.length > 0) {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-slot",
						message: `${slotRuleText()}。不合法的：${badSlots.map((s) => `「${String(s).slice(0, 32)}」`).join(" ")}`,
						invalid: badSlots.map((s) => String(s).slice(0, 32))
					});
					return;
				}
				const slots = [...new Set(wantSlots)];
				/**
			 * ⚠️ 只在**没有任何槽位**时才补 default（2026-10-16 改）。
			 *
			 * 原来是无条件 unshift —— 用户把 default 从配置里删掉，
			 * 读配置时它又被塞回来，表现为「删不掉」。
			 * default 只是**空表时的兜底身份**；用户给平台起了自己的账号名之后，
			 * 不该再硬塞一个 default 进去。
			 */
			/** ⚠️ 空槽位保持为空（一来就是 0 个账号，不再凭空补 default）。 */
				/**
				 * ⭐ 保留「模型栏隐藏」设置（缺省 = 全显示）。
				 * ⚠️ 必须**显式带上**：PUT 是整份替换这个平台的条目，
				 * 不带就等于把这台的隐藏设置清零（跟 active 那个坑同一类）。
				 */
				const hiddenInModels = Array.isArray(payload?.hiddenInModels)
					? [...new Set(payload.hiddenInModels.filter((s) => typeof s === "string" && slots.includes(s)))]
					: (accounts[platformId]?.hiddenInModels ?? []).filter((s) => slots.includes(s));
				const active = isSafeSlotName(payload.active) && slots.includes(payload.active) ? payload.active : "default";
				accounts[platformId] = hiddenInModels.length > 0 ? { slots, active, hiddenInModels } : { slots, active };
				await writeConfigFile({ ...cfg, accounts });
				log.info?.(`账号配置已更新：${platformId} slots=[${slots.join(",")}] active=${active}`);
				sendJson(res, 200, { ok: true, platform: platformId, slots, active });
				return;
			}
			/**
			* ## DELETE /accounts/<platform>/<slot> —— 删一个账号槽位
			*
			* 删槽位 = 从配置移除 + 删该槽位的登录快照 + 提示用户 profile 目录
			* 留着（里面是完整的浏览器登录态，删快照不影响再次登录；真要清
			* 浏览器数据由用户手动删 `~/.dsh/edge-ldw/<平台>/<槽位>`）。
			* "default" 槽位不允许删（它是兜底身份）。
			*/
			if (method === "DELETE" && pathname.startsWith(`${API_PREFIX}/accounts/`)) {
				const rest = pathname.slice(`${API_PREFIX}/accounts/`.length);
				const slash = rest.indexOf("/");
				const platformId = slash === -1 ? rest : rest.slice(0, slash);
				/**
				 * ⚠️ 必须 `decodeURIComponent`：中文槽位名（如「奶奶」）在 URL 里是
				 * percent-encoded（`%E5%A5%B6%E5%A5%B6`），不解码就会被下面的
				 * 校验当成非法字符拒掉 —— 表现是「中文槽位能建、却删不掉」。
				 * 解码失败（畸形百分号编码）时保持原样，交给校验去拒。
				 */
				const rawSlot = slash === -1 ? "" : rest.slice(slash + 1);
				let slot = rawSlot;
				try { slot = decodeURIComponent(rawSlot); } catch { /* 畸形编码就原样，下面会拒 */ }
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(platformId) || !isSafeSlotName(slot)) {
					sendJson(res, 400, { ok: false, reason: "invalid-path", message: slotRuleText() });
					return;
				}
				if (slot === "default") {
					sendJson(res, 400, { ok: false, reason: "default 槽位不可删除（它是兜底身份）" });
					return;
				}
				const { config: cfg } = readConfig();
				const accounts = { ...(cfg.accounts ?? {}) };
				const entry = accountsForPlatform(accounts, platformId);
				const slots = entry.slots.filter((s) => s !== slot);
				if (slots.length === entry.slots.length && entry.slots.every((s) => s !== slot)) {
					sendJson(res, 404, { ok: false, reason: "槽位不存在" });
					return;
				}
				const active = entry.active === slot ? "default" : entry.active;
				accounts[platformId] = { slots, active };
				await writeConfigFile({ ...cfg, accounts });
				/** 删该槽位的登录快照（有的话）。 */
				let snapshotRemoved = false;
				try {
					const path = snapshotPath(slotNameFor(platformId, slot));
					if (existsSync(path)) {
						await unlink(path);
						snapshotRemoved = true;
					}
				} catch {}
				log.info?.(`账号槽位已删除：${platformId}#${slot}（快照${snapshotRemoved ? "已删" : "本就没有"}，profile 目录保留）`);
				sendJson(res, 200, { ok: true, platform: platformId, slot, slots, active, snapshotRemoved });
				return;
			}
			/**
			 * ## /credentials —— 统一 Token/Cookie 凭据文件（2026-10-16 新增）
			 *
			 * 用户要「一个文件，手机和电脑都能用」地管 Token/Cookie。
			 * 文件在 `~/.dsh/webin/credentials.json`（可用环境变量
			 * `DSH_WEBIN_CREDENTIALS` 指到同步目录，实现手机+电脑共用）。
			 *
			 * ⚠️ **GET 一律脱敏**：只回长度/指纹/轮换频率，**绝不回明文**。
			 * 明文只有在用户自己打开那个文件时才看得到 —— 这是防误泄露的第一道闸。
			 */
			if (method === "GET" && pathname === `${API_PREFIX}/credentials`) {
				const store = loadCredentials();
				sendJson(res, 200, {
					ok: true,
					path: storePath(),
					accounts: listCredentials(store),
					/** 给用户看「怎么写进去」的最小说明。 */
					hint: "直接编辑该文件，或用 PUT /dsh-webin/api/credentials 写入；环境变量 DSH_WEBIN_CREDENTIALS 可换路径（手机/电脑共用一个文件）。"
				});
				return;
			}
			if (method === "PUT" && pathname === `${API_PREFIX}/credentials`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, { ok: false, reason: "invalid-json" });
					return;
				}
				const platform = String(payload?.platform ?? "").trim();
				const slot = String(payload?.slot ?? "default").trim() || "default";
				/** 与槽位文件同一套字符约束，防止路径穿越与非法目录名。 */
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(platform)) {
					sendJson(res, 400, { ok: false, reason: "invalid-platform", message: "platform 只允许字母数字下划线连字符（1~64 位）" });
					return;
				}
				if (!isSafeSlotName(slot)) {
					sendJson(res, 400, { ok: false, reason: "invalid-slot", message: slotRuleText() });
					return;
				}
				if (typeof payload?.token !== "string" && typeof payload?.cookie !== "string") {
					sendJson(res, 400, { ok: false, reason: "nothing-to-set", message: "token 与 cookie 至少要给一个" });
					return;
				}
				const store = loadCredentials();
				const entry = setCredential(platform, slot, {
					...(typeof payload.token === "string" ? { token: payload.token } : {}),
					...(typeof payload.cookie === "string" ? { cookie: payload.cookie } : {}),
				}, store);
				const savedTo = saveCredentials(store);
				/**
				 * ⚠️ 日志**只记长度**，不记内容 —— 凭据进日志等于泄露。
				 */
				log.info?.(`凭据已写入：${platform}#${slot}（token ${entry.tokenLen} / cookie ${entry.cookieLen} 字符，变更 ${entry.changedCount} 次）`);
				sendJson(res, 200, {
					ok: true,
					path: savedTo,
					account: {
						platform, slot,
						tokenLen: entry.tokenLen,
						cookieLen: entry.cookieLen,
						changedCount: entry.changedCount,
						rotation: describeRotation(entry)
					}
				});
				return;
			}
			if (method === "DELETE" && pathname === `${API_PREFIX}/credentials`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, { ok: false, reason: "invalid-json" });
					return;
				}
				const platform = String(payload?.platform ?? "").trim();
				const slot = String(payload?.slot ?? "default").trim() || "default";
				const store = loadCredentials();
				const removed = deleteCredential(platform, slot, store);
				if (removed) {
					saveCredentials(store);
					log.info?.(`凭据已删除：${platform}#${slot}`);
				}
				sendJson(res, 200, { ok: true, removed, platform, slot });
				return;
			}
			/**
			 * ## POST /credentials/inject —— 粘贴凭据直接登录（2026-10-16 新增）
			 *
			 * 这是用户点名要的能力：**不必开浏览器扫码**，把 Token/Cookie 灌进去就登。
			 * 手机和电脑因此能靠同一份凭据文件互相登录。
			 *
			 * 真机实验已验证：全新干净 profile + 一份 token/cookie ⇒ 直接进主界面。
			 *
			 * body：`{"platform":"deepseek","slot":"default"}` —— 从凭据文件读；
			 *       也可带 `token`/`cookie` 直接注入（便于「先试着登，成了再存」）。
			 */
			if (method === "POST" && pathname === `${API_PREFIX}/credentials/inject`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body === "" ? "{}" : body);
				} catch {
					sendJson(res, 400, { ok: false, reason: "invalid-json" });
					return;
				}
				const platform = String(payload?.platform ?? "").trim();
				const slot = String(payload?.slot ?? "default").trim() || "default";
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(platform) || !isSafeSlotName(slot)) {
					sendJson(res, 400, { ok: false, reason: "invalid-platform-or-slot", message: slotRuleText() });
					return;
				}
				/**
				 * ⚠️ driver 是**串行**的（一次只用一个浏览器干活，这是 webin 的
				 * 反封设计）。正在跑任务时注入会抢同一个 Edge，必须让用户等一下，
				 * 而不是并发操作把两边都搞坏。
				 */
				if (edgeDriver.busy === true || edgeDriver.stopping === true) {
					sendJson(res, 409, {
						ok: false,
						reason: "driver-busy",
						message: "Edge 正在跑任务，等它跑完再注入（避免两边抢同一个浏览器）"
					});
					return;
				}
				const provider = registry.get(platform);
				if (provider === undefined) {
					sendJson(res, 404, { ok: false, reason: "unknown-platform", platform });
					return;
				}
				/** 凭据来源：body 优先（试登），否则读文件。 */
				let token = typeof payload?.token === "string" ? payload.token : "";
				let cookie = typeof payload?.cookie === "string" ? payload.cookie : "";
				let fromStore = false;
				if (token === "" && cookie === "") {
					const cred = getCredential(platform, slot);
					if (cred === null) {
						sendJson(res, 404, {
							ok: false,
							reason: "no-credentials",
							message: `凭据文件里没有 ${platform}#${slot}，先用 PUT ${API_PREFIX}/credentials 写入，或在 body 里直接给 token/cookie。`
						});
						return;
					}
					token = typeof cred.token === "string" ? cred.token : "";
					cookie = typeof cred.cookie === "string" ? cred.cookie : "";
					fromStore = true;
				}
				try {
					const r = await edgeDriver.injectCredentials(provider, { token, cookie, accountId: slot });
					/**
					 * 把「验证结果」回填到凭据文件 —— 这就是用户想知道的那个
					 * 「我的 token 现在还有效吗」：**页面探针说了算**。
					 */
					try {
						const store = loadCredentials();
						const entry = getCredential(platform, slot, store);
						if (entry !== null) {
							entry.lastVerify = { at: Date.now(), ok: r.loggedIn === true, url: r.url };
							saveCredentials(store);
						}
					} catch { /* 回填失败不影响注入结果 */ }
					/**
					 * ## ⚠️ 注入成功后**必须补一份快照**（2026-10-16 真机踩到）
					 *
					 * 为什么：登录门禁的 **cookie 那条判据在 Edge 运行期间必然失效** ——
					 * Chromium 独占锁住 `<profile>/Default/Network/Cookies`，
					 * Windows 连复制都拒绝（实测 `EBUSY: resource busy or locked`，
					 * 重试也没用，只有等 Edge 关掉）。而「刚注入完、Edge 还开着」
					 * 恰恰是最常见的时刻 ⇒ 页面里明明登录着，`/accounts` 却报「未登录」。
					 *
					 * 快照是纯文件、不受锁影响、还能跨重启存活，所以这里补一份，
					 * 让门禁立刻有依据。与「任务跑通后补快照」是同一套逻辑（见领活循环）。
					 */
					if (r.loggedIn === true) {
						try {
							const snap = await edgeDriver.snapshot(provider);
							if (typeof snap === "string" && snap.trim() !== "" && snap.trim() !== "{}") {
								await writeAtomic(snapshotPath(slotNameFor(platform, slot)), snap);
								log.info?.(`凭据注入后已补写登录快照：${slotNameFor(platform, slot)}`);
							}
						} catch (e) {
							log.debug?.(`注入后补快照失败（不影响登录本身）: ${String(e?.message ?? e)}`);
						}
					}
					log.info?.(`凭据注入 ${platform}#${slot}: loggedIn=${r.loggedIn} cookie=${r.cookieSet} ls=${r.localStorageSet.length}${fromStore ? "（来自凭据文件）" : "（来自请求体）"}`);
					sendJson(res, r.loggedIn === true ? 200 : 422, {
						ok: r.loggedIn === true,
						platform,
						slot,
						source: fromStore ? "store" : "body",
						loggedIn: r.loggedIn,
						url: r.url,
						cookieSet: r.cookieSet,
						cookieFailed: r.cookieFailed,
						localStorageSet: r.localStorageSet,
						detail: r.detail
					});
				} catch (e) {
					log.warn?.(`凭据注入失败 ${platform}#${slot}: ${String(e?.message ?? e)}`);
					sendJson(res, 500, { ok: false, reason: "inject-failed", message: String(e?.message ?? e) });
				}
				return;
			}
			/**
			 * ## POST /sessions/cleanup —— 立刻清理「机器人建的对话」（用户点名要的按钮）
			 *
			 * `force: true` 时**无视 sessionDeleteMode**：
			 *   ① 账本里的全删掉；
			 *   ②（2026-10-18 第三批）再按 **LDW 标题前缀**扫一遍网页列表——
			 *     历史攒下的机器对话（账本没记的）也删，且账本孤儿一并抹掉
			 *     （用户在网页端手删过的，本地副本不留）。
			 * 不带 force 就只清到期的（= 手动触发一次策略内的回收）。
			 *
			 * ⚠️ 删除是**页面里的 fetch**（会话列表/删除都走网页版接口），
			 * 所以必须先确保浏览器起来了、且停在该平台的域里 ——
			 * 因此这里会 `ensureEdge()`（点一下按钮多等十几秒冷启动是合理的）。
			 *
			 * body：`{platform?, slot?, force?}`
			 */
			if (method === "POST" && pathname === `${API_PREFIX}/sessions/cleanup`) {
				const body = await readBody(req);
				let payload = {};
				try { payload = JSON.parse(body === "" ? "{}" : body); } catch { /* 用默认值 */ }
				const platform = typeof payload?.platform === "string" && payload.platform !== "" ? payload.platform : edgeDriver.platformId;
				const slot = typeof payload?.slot === "string" && payload.slot !== "" ? payload.slot : "default";
				const force = payload?.force === true;
				const provider = registry.get(platform);
				if (provider === undefined) {
					sendJson(res, 404, { ok: false, reason: "unknown-platform", platform });
					return;
				}
				if (provider?.sessionApi?.delete !== true) {
					sendJson(res, 400, {
						ok: false,
						reason: "no-session-api",
						message: `平台「${provider.name ?? platform}」还没有验证过的删除接口（元宝/豆包的删除端点待抓包：在对应网页手动删一条对话即可捕获）。当前可清理：DeepSeek。`
					});
					return;
				}
				if (edgeDriver.busy === true) {
					sendJson(res, 409, { ok: false, reason: "driver-busy", message: "正在跑任务，等它跑完再清理" });
					return;
				}
				try {
					await edgeDriver.ensureEdge(platform, slot);
					const removed = await edgeDriver.flushSessionDeletions(provider, { force });
					/** force 时按前缀补扫（历史机器对话 + 孤儿账本）。 */
					let prefixRemoved = 0;
					let orphans = 0;
					if (force === true) {
						const r = await edgeDriver.purgeByLdwTitle(provider).catch(() => ({ removed: 0, orphans: 0 }));
						prefixRemoved = r.removed ?? 0;
						orphans = r.orphans ?? 0;
					}
					const ledger = edgeDriver.sessionLedgerStatus(platform);
					log.info?.(`手动清理 ${platform}#${slot}：账本删 ${removed} 条，前缀删 ${prefixRemoved} 条，孤儿清 ${orphans} 条（force=${force}），账本剩 ${ledger.pending}`);
					sendJson(res, 200, { ok: true, platform, slot, identified: prefixRemoved + ledger.pending, removed: removed + prefixRemoved, prefixRemoved, orphans, remaining: ledger.pending });
				} catch (e) {
					log.warn?.(`手动清理失败 ${platform}#${slot}：${String(e?.message ?? e)}`);
					sendJson(res, 500, { ok: false, reason: "cleanup-failed", message: String(e?.message ?? e) });
				}
				return;
			}
			/**
			 * ## POST /edge/stop —— 手动立刻关掉后端浏览器（用户点名要的）
			 *
			 * 用户原话：「希望能够支持我手动控制后端浏览器是否运行」。
			 * 自动关停是 `idleShutdownMs`（默认 2 分钟），但用户想**立刻**关掉腾内存
			 * —— 尤其机器吃紧、或做完事不想留进程时。
			 *
			 * 走 `shutdownEdge()`（CDP `Browser.close`，优雅退出 ⇒ 会写盘，登录态不丢），
			 * 顺便清掉端口归属标记。
			 */
			if (method === "POST" && pathname === `${API_PREFIX}/edge/stop`) {
				if (edgeDriver.busy === true) {
					sendJson(res, 409, {
						ok: false,
						reason: "driver-busy",
						message: "正在跑任务，等它跑完再关（否则会打断生成）"
					});
					return;
				}
				try {
					await edgeDriver.shutdownEdge("用户手动关闭");
					log.info?.("浏览器已由用户手动关闭");
					sendJson(res, 200, { ok: true, running: false });
				} catch (e) {
					sendJson(res, 500, { ok: false, reason: "stop-failed", message: String(e?.message ?? e) });
				}
				return;
			}
			/**
			 * ## POST /edge/start —— 手动启动后端浏览器
			 *
			 * 与 `/edge/stop` 配对。body 可选 `{platform, slot}`（默认当前平台 + default）。
			 * 启动本身没副作用，只是把浏览器拉起来连上 CDP
			 * —— 这样第一次派任务的等待时间就提前付掉了（用户抱怨过「每次重启响应很慢」）。
			 */
			if (method === "POST" && pathname === `${API_PREFIX}/edge/start`) {
				const body = await readBody(req);
				let payload = {};
				try { payload = JSON.parse(body === "" ? "{}" : body); } catch { /* 用默认值 */ }
				const platform = typeof payload?.platform === "string" && payload.platform !== "" ? payload.platform : edgeDriver.platformId;
				/**
				 * ⚠️ 没指定槽位时用**当前配置的生效槽位**（2026-10-17 真机事故）。
				 * 写死 "default" 会在用户改名成 evelyn-xxx 之后打开一个**空档案**
				 * （改名后 edge-ldw/<平台> 只剩子目录）⇒ 页面 about:blank ⇒ 发不出消息。
				 */
				const slot = typeof payload?.slot === "string" && payload.slot !== "" ? payload.slot : activeAccountFor(platform);
				if (registry.get(platform) === undefined) {
					sendJson(res, 404, { ok: false, reason: "unknown-platform", platform });
					return;
				}
				try {
					await edgeDriver.ensureEdge(platform, slot);
					log.info?.(`浏览器已由用户手动启动（${platform}#${slot}）`);
					sendJson(res, 200, { ok: true, running: true, platform, slot });
				} catch (e) {
					log.warn?.(`手动启动浏览器失败：${String(e?.message ?? e)}`);
					sendJson(res, 500, { ok: false, reason: "start-failed", message: String(e?.message ?? e) });
				}
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/client/heartbeat`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const clientId = typeof payload.clientId === "string" && payload.clientId !== "" ? payload.clientId : "anonymous";
				const platform = typeof payload.platform === "string" && payload.platform !== "" ? payload.platform : DEFAULT_PROVIDER_ID;
				beats.set(clientId, {
					clientId,
					platform,
					at: Date.now(),
					loggedIn: payload.loggedIn === true,
					hasGuest: payload.hasGuest === true,
					replyCount: typeof payload.replyCount === "number" ? payload.replyCount : 0,
					/**
					* ## ⚠️ 这里原来**漏存 scrape** —— 诊断数据到 host 就被丢了
					*
					* 症状：client 侧 payload 里明明有 `scrape`（产物核对过），
					* 但 `/status` 永远看不到 —— 因为 handler 只挑几个字段
					* 重新组装，没读 `payload.scrape`。
					*
					* 教训：**类型上加字段 ≠ 运行时会保留** ——
					* 这种「手工挑字段」的写法每加一个字段都要记得同步。
					*/
					...payload.scrape === void 0 ? {} : { scrape: payload.scrape },
					...payload.dom === void 0 ? {} : { dom: payload.dom },
					...payload.clientBuiltAt === void 0 ? {} : { clientBuiltAt: payload.clientBuiltAt }
				});
				/**
				* ## ⭐⭐ 告诉面板「有新构建了」—— 让它自己重载
				*
				* ## ⚠️⚠️ 第一版判据写错了，造成**每 2 秒无限重载**（群友实测）
				*
				* 第一版：面板上报烘死的 `clientBuiltAt`，host 比 `mtime`，
				* 晚 5 秒以上就回 `reload: true`。
				*
				* 但 `builtAt` 是**构建开始时**算的，`client.js` **写盘**在构建末尾
				* —— 机器稍慢差值就超过 5 秒 ⇒ **永远判定落后** ⇒
				* 面板每收到一次心跳就 reload 一次 ⇒ **死循环**（每 2~2.2 秒一次），
				* 甚至把 DSH 桌面端拖崩。
				*
				* ## 正确判据：**rev 变化**（我启动时见过的 rev vs 现在的 rev）
				*
				*   1. host 每次心跳回包都带上当前产物的 `rev`
				*      （与 DSH 的 `artifactRevision` 同算法：sha1(mtime+ctime+size)）
				*   2. 面板**第一次**收到时把它记下来（=「我加载时是哪个版本」）
				*   3. 之后 rev **变了** ⇒ 真的出了新构建 ⇒ 才 reload
				*   4. reload 后加载到的就是新 bundle ⇒ 记下的 rev = 新 rev ⇒ 停止
				*
				* 这个判据**自收敛**：只有真的换了文件才会变，重载一次就稳定。
				*/
				let bundleRev = "";
				try {
					const st = statSync(clientBundlePath());
					bundleRev = createHash("sha1").update("plugin-artifact").update("\0").update(`${String(Buffer.byteLength(String(st.mtimeMs)))}:`).update(String(st.mtimeMs)).update(`${String(Buffer.byteLength(String(st.ctimeMs)))}:`).update(String(st.ctimeMs)).update(`${String(Buffer.byteLength(String(st.size)))}:`).update(String(st.size)).digest("hex").slice(0, 12);
				} catch {}
				sendJson(res, 200, {
					ok: true,
					clients: liveClients().length,
					/**
					* ⚠️ **每次都带** rev（不只 reload 时带）—— 面板要靠它做
					* 「初次记录」。reload 与否由面板自己判断（rev 变了才重载）。
					*/
					bundleRev
				});
				return;
			}
			/**
			* ---- GET /config —— 读配置 ----
			*
			* 返回「当前生效的配置」+「默认值」+「边界」+「校验问题」。
			* 设置页需要这四样才能画出正确的表单：
			*   - 当前值：显示
			*   - 默认值：给「恢复默认」按钮用
			*   - 边界：给输入框的 min/max，避免用户填了才被拒
			*   - 问题：文件坏了 / 值超界时明确告诉用户
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/config`) {
				const { config, problems } = readConfig();
				sendJson(res, 200, {
					ok: true,
					config,
					defaults: DEFAULT_CONFIG,
					limits: LIMITS,
					problems,
					summary: describeConfig(config),
					path: configPath()
				});
				return;
			}
			/**
			* ---- PUT /config —— 写配置 ----
			*
			* 校验在 host 做，**不信客户端传什么就存什么**。
			* 非法字段回退默认并逐条报告（不静默吞掉）—— 否则用户改了没生效会困惑。
			*/
			if (method === "PUT" && pathname === `${API_PREFIX}/config`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				/**
				* ## ⚠️ PUT 改为「增量合并」（2026-10-19 同一坑踩两次后定案）
				*
				* 事故：PUT 传 `{"directSendThresholdChars":6000}` 这类**部分键**时，
				* 旧逻辑 `checkConfig(payload)` 把没传的键全落默认值再**整文件替换**
				* ⇒ accounts（多账号槽位配置）被冲空两次（真机，用户消息全发不出去）。
				*
				* 修法：先读磁盘现配置做底，payload 里的键逐个覆盖，再校验落盘。
				* UI 的「保存配置」本来就传全量（不影响它）；API/脚本测试传部分键
				* 不再误伤其它配置。
				*/
				const base = readConfig().config;
				const merged = { ...base, ...payload };
				const checked = checkConfig(merged);
				try {
					await writeConfigFile(checked.config);
				} catch (error) {
					sendJson(res, 500, {
						ok: false,
						reason: `写入失败：${error?.message ?? String(error)}`
					});
					return;
				}
				log.info?.(`配置已更新（增量合并）：${describeConfig(checked.config)}`);
				sendJson(res, 200, {
					ok: true,
					config: checked.config,
					problems: checked.problems,
					summary: describeConfig(checked.config)
				});
				return;
			}
			/**
			* ---- DELETE /config —— 恢复默认 ----
			*
			* 直接写一份默认值（而不是删文件）—— 删了之后 `GET` 也能返回默认，
			* 但写出来用户能看见「确实是默认值」，比空文件直观。
			*/
			if (method === "DELETE" && pathname === `${API_PREFIX}/config`) {
				try {
					await writeConfigFile({ ...DEFAULT_CONFIG });
				} catch (error) {
					sendJson(res, 500, {
						ok: false,
						reason: `写入失败：${error?.message ?? String(error)}`
					});
					return;
				}
				log.info?.("配置已恢复默认");
				sendJson(res, 200, {
					ok: true,
					config: { ...DEFAULT_CONFIG },
					problems: [],
					summary: describeConfig(DEFAULT_CONFIG)
				});
				return;
			}
			/**
			* ---- GET /version —— 版本 + 更新检查 ----
			*
			* ## 为什么走 host 而不是让 client 直接请求 GitHub
			*
			*   - **CORS**：浏览器里对 `api.github.com` 的跨域请求会被拦
			*   - **凭据**：host 侧不需要任何凭据（公开仓库），也不该为了
			*     检查更新去要一个能写仓库的 token
			*   - **缓存**：host 侧记一下上次结果，用户反复开设置页时不必重复打
			*     GitHub（未认证的 API 每小时 60 次，刷几次就没了）
			*/
			if (method === "GET" && pathname === `${API_PREFIX}/version`) {
				const info = currentVersion();
				/** `?check=1` 才真的打 GitHub —— 默认只回本地版本，省配额。 */
				const wantCheck = new URL(req.url ?? "", "http://localhost").searchParams.get("check") === "1";
				let update;
				if (wantCheck) {
					const now = Date.now();
					/**
					* 60 秒内复用上次结果（用户连点「检查更新」不会打爆配额）。
					* ⚠️ **按仓库分键** —— 见 `updateChecks` 的说明。
					*/
					const cached = updateChecks.get(info.repo);
					if (cached !== void 0 && now - cached.checkedAt < UPDATE_CACHE_MS) update = cached;
					else {
						update = await checkForUpdate(info.repo);
						updateChecks.set(info.repo, update);
					}
				}
				sendJson(res, 200, {
					ok: true,
					...info,
					repoUrl: repoUrl(info.repo),
					starUrl: starUrl(info.repo),
					updateHint: updateHint(info.repo),
					/** 一句话总结（四种状态分开说，见 `describeUpdate`）。 */
					updateSummary: update === void 0 ? void 0 : describeUpdate(update, info.commit),
					...update === void 0 ? {} : { update }
				});
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/status`) {
				const clients = liveClients();
				sendJson(res, 200, {
					ok: true,
					plugin: name,
					/**
					* 真 Edge 驱动器状态 —— web 档案下 LDW 的浏览器载体。
					*
					* 排查顺序：先看 `edgeDriver.running`（Edge 起了吗），
					* 再看 `edgeDriver.cdpConnected`（CDP 连上了吗），
					* 再看 `edgeDriver.targetUrl`（停在哪个页面），
					* 最后看 `stats`（领了几个活、成了几个）。
					*/
					edgeDriver: edgeDriver.status(),
					/**
					* 浏览器启动失败的退避现状（有内容 = 最近起不来）。
					* 让设置页/诊断能直接说「已重试几次、多久后重试」，
					* 而不是让用户对着不动的界面猜。
					*/
					launchFailures: launchBackoff.snapshot(),
				/** 会话回收策略与待删账本现状（用户点名要的可配置删除）。 */
				sessionLedger: edgeDriver.sessionLedgerStatus(),
					/**
					* 平台清单 —— 每个平台一个 provider 路由，模型选择器里是独立分组。
					* `overridden` 标出哪些内置平台被用户自定义 JSON 覆盖了。
					*/
					platforms: registry.all().map((p) => ({
						id: p.id,
						name: p.name,
						route: routeFor(p.id),
						homeUrl: p.homeUrl,
						models: p.models.map((m) => ({
							id: `${p.id}:${m.id}`,
							name: m.name
						})),
						contextWindow: p.contextWindow,
						custom: registry.overriddenIds().includes(p.id)
					})),
					root: stateRoot(),
					providersDir: providersDir(),
					/**
					* 面板在线情况 —— 模型不回复时先看这里。
					* `online: 0` 表示没有任何 LDW 面板在跑，任务必然无人领取。
					*/
					clients: {
						online: clients.length,
						loggedIn: clients.filter((c) => c.loggedIn).length,
						detail: clients.map((c) => ({
							clientId: c.clientId,
							platform: c.platform,
							ageMs: Date.now() - c.at,
							loggedIn: c.loggedIn,
							hasGuest: c.hasGuest,
							replyCount: c.replyCount,
							/** ⭐ 抓取诊断 —— 看「抓到的是不是回复」。 */
							...c.scrape === void 0 ? {} : { scrape: c.scrape },
							...c.dom === void 0 ? {} : { dom: c.dom }
						}))
					},
					/**
					* 登录过的平台（判据是**持久化快照**，不是「浏览器此刻在线」）。
					*
					* 未登录的平台**不会列出模型** —— 用户要求
					* 「如果是已登录才能使用 LDW 那俩模型」。输入框旁边的 LDW 按钮
					* 也读这个字段决定显示「去登录」还是「已登录」。
					*/
					loggedInPlatforms: loggedInPlatforms(registry.all()),
					/** 多账号：每平台的账号槽位与当前生效槽位（2026-10-16）。 */
					accounts: registry.all().map((p) => {
						const entry = accountsForPlatform(readConfig().config.accounts, p.id);
						return {
							platform: p.id,
							slots: entry.slots,
							active: entry.active
						};
					}),
					/**
					* ## ⭐ 任务队列快照 —— 「所有窗口都生效」时看这里，不用猜
					*
					* 每条显示：任务属于哪个会话、被**哪个会话的窗口**领走、当前状态。
					*
					* 排查「任务被别的窗口抢走了」时，这一眼就能看出来：
					*   - `sessionId` 是任务的归属会话
					*   - `claimedBy` 是实际领走它的窗口
					*   - 两者不一致 ⇒ 就是派发错了
					*/
					jobs: queue.inspect(),
					/** client 上报过哪些会话（每个窗口挂载 LDW 视图时会上报）。 */
					knownSessions: [...knownSessions.entries()].map(([id, at]) => ({
						sessionId: id,
						ageMs: Date.now() - at
					})),
					routes: [
						`GET    ${API_PREFIX}/status`,
						`GET    ${API_PREFIX}/providers`,
						`POST   ${API_PREFIX}/providers`,
						`DELETE ${API_PREFIX}/providers/<id>`,
						`POST   ${API_PREFIX}/client/heartbeat`,
						`GET    ${API_PREFIX}/job/next?platform=<id>`,
						`PUT    ${API_PREFIX}/job/<id>/result`,
						`GET    ${API_PREFIX}/auth`,
						`GET    ${API_PREFIX}/auth/<slot>/snapshot`,
						`PUT    ${API_PREFIX}/auth/<slot>/snapshot`,
						`DELETE ${API_PREFIX}/auth/<slot>/snapshot`,
						`GET    ${API_PREFIX}/credentials`,
						`PUT    ${API_PREFIX}/credentials`,
						`DELETE ${API_PREFIX}/credentials`,
						`POST   ${API_PREFIX}/credentials/inject`,
						`POST   ${API_PREFIX}/edge/start`,
						`POST   ${API_PREFIX}/edge/stop`,
						`POST   ${API_PREFIX}/sessions/cleanup`
					]
				});
				return;
			}
			if (method === "GET" && pathname === `${API_PREFIX}/providers`) {
				const { items, errors } = await readCustomProviders();
				const loaded = new ProviderRegistry().loadCustom(items);
				/**
				* 设置页需要「当前生效的全部平台」。内置项也列出来 ——
				* 用户看到的是「我能用哪些平台」，而不是「我加过哪些文件」。
				*/
				const customIds = new Set(loaded.accepted.map((p) => p.id));
				sendJson(res, 200, {
					ok: true,
					dir: providersDir(),
					/** 生效的全部平台（内置 + 自定义，自定义覆盖同 id 内置）。 */
					providers: registry.all(),
					/** 哪些是用户自定义的（设置页据此决定能否删）。 */
					customIds: [...customIds],
					defaultProviderId: DEFAULT_PROVIDER_ID,
					accepted: loaded.accepted,
					rejected: loaded.rejected.map((r) => ({
						index: r.index,
						reason: r.reason
					})),
					/** 设置页显示的读盘错误。 */
					errors: errors.map((e) => ({
						file: e.file,
						reason: e.reason
					})),
					fileErrors: errors,
					count: items.length,
					/** 在线客户端（登录态来源）。 */
					clients: liveClients(),
					/** 登录过的平台（快照判据）—— 设置页据此显示「已登录 / 去登录」。 */
					loggedInPlatforms: loggedInPlatforms(registry.all())
				});
				return;
			}
			if (method === "POST" && pathname === `${API_PREFIX}/providers`) {
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-json"
					});
					return;
				}
				const loaded = new ProviderRegistry().loadCustom([payload]);
				if (loaded.accepted.length === 0) {
					sendJson(res, 400, {
						ok: false,
						reason: loaded.rejected[0]?.reason ?? "provider 校验失败"
					});
					return;
				}
				const id = loaded.accepted[0];
				const path = await writeCustomProvider(payload);
				registry.loadCustom([payload]);
				syncProviders();
				log.info?.(`自定义 provider 已装入：${id}`);
				sendJson(res, 200, {
					ok: true,
					id,
					path,
					route: routeFor(id)
				});
				return;
			}
			if (method === "DELETE" && pathname.startsWith(`${API_PREFIX}/providers/`)) {
				const id = decodeURIComponent(pathname.slice(`${API_PREFIX}/providers/`.length));
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
					sendJson(res, 400, {
						ok: false,
						reason: "invalid-id"
					});
					return;
				}
				const removed = await removeCustomProvider(id);
				log.info?.(`自定义 provider 已移除：${id}（${removed ? "文件已删" : "无文件"}）`);
				sendJson(res, 200, {
					ok: true,
					id,
					removed
				});
				return;
			}
			/**
			* ## PUT /providers/<id> —— 模型切换 / 平台参数覆盖（2026-10-16，用户点名要的）
			*
			* **只允许覆盖展示层字段**，绝不接受平台地址 / 选择器 / 抓取配置 ——
			* 那些改错一条就是「发不出去/抓不到回复」的隐形炸弹：
			*   - `models`        ：模型清单（想加 `qwen:max` / 删掉某个 LDW 模型都在这改）
			*   - `name`          ：平台显示名
			*   - `contextWindow` / `maxOutputTokens`：容量参数
			*
			* 实现方式：读当前生效的 provider 定义（内置或自定义），覆盖上面四个
			* 字段后写成**自定义覆盖文件**（注册表语义本来就是「自定义覆盖内置」）。
			* 删除覆盖文件（DELETE /providers/<id>）即恢复内置。
			*
			* ⚠️ 模型条目只收 `id/name/description/thinking` 四个字段——多余字段
			* 丢弃，防脏数据进配置。
			*/
			if (method === "PUT" && pathname.startsWith(`${API_PREFIX}/providers/`)) {
				const id = decodeURIComponent(pathname.slice(`${API_PREFIX}/providers/`.length));
				if (!/^[A-Za-z0-9_-]{1,64}$/.test(id)) {
					sendJson(res, 400, { ok: false, reason: "invalid-id" });
					return;
				}
				const body = await readBody(req);
				let payload;
				try {
					payload = JSON.parse(body);
				} catch {
					sendJson(res, 400, { ok: false, reason: "invalid-json" });
					return;
				}
				/** 当前生效定义（含内置），找不到就 404。 */
				const existing = registry.all().find((p) => p.id === id);
				if (existing === void 0) {
					sendJson(res, 404, { ok: false, reason: `平台 ${id} 不存在` });
					return;
				}
				/** 覆盖平台显示名（可选）。 */
				const name = typeof payload.name === "string" && payload.name.trim() !== "" ? payload.name.trim() : existing.name;
				/** 覆盖模型清单（可选）：逐条白名单提取。 */
				const models = Array.isArray(payload.models)
					? payload.models.map((m) => ({
						...(typeof m?.id === "string" && m.id !== "" ? { id: m.id } : {}),
						...(typeof m?.name === "string" && m.name !== "" ? { name: m.name } : {}),
						...(typeof m?.description === "string" && m.description !== "" ? { description: m.description } : {}),
						...(m?.thinking === true || m?.thinking === false ? { thinking: m.thinking === true } : {})
					})).filter((m) => typeof m.id === "string" && m.id !== "" && typeof m.name === "string" && m.name !== "")
					: existing.models;
				/** 容量参数（可选），非法回退现值。 */
				const contextWindow = Number.isFinite(Number(payload.contextWindow)) && Number(payload.contextWindow) > 0 ? Math.round(Number(payload.contextWindow)) : existing.contextWindow;
				const maxOutputTokens = Number.isFinite(Number(payload.maxOutputTokens)) && Number(payload.maxOutputTokens) > 0 ? Math.round(Number(payload.maxOutputTokens)) : existing.maxOutputTokens;
				/** 以当前生效定义打底（保留选择器等全部既有配置），覆盖展示层字段。 */
				const merged = { ...existing, name, models, contextWindow, maxOutputTokens };
				const loaded = new ProviderRegistry().loadCustom([merged]);
				if (loaded.accepted.length === 0) {
					sendJson(res, 400, { ok: false, reason: loaded.rejected[0]?.reason ?? "覆盖后校验失败（models 不能为空，除非 pending-validation）" });
					return;
				}
				await writeCustomProvider(merged);
				registry.loadCustom([merged]);
				syncProviders();
				log.info?.(`平台 ${id} 已更新：models=[${models.map((m) => m.id).join(",")}] contextWindow=${contextWindow}`);
				sendJson(res, 200, {
					ok: true,
					id,
					route: routeFor(id),
					models: models.map((m) => m.id),
					contextWindow,
					maxOutputTokens,
					/** 提示用户：删除覆盖文件可恢复内置定义。 */
					revertHint: `DELETE ${API_PREFIX}/providers/${id} 恢复内置`
				});
				return;
			}
			sendJson(res, 404, {
				ok: false,
				reason: "not-found",
				path: pathname
			});
		} catch (error) {
			log.warn?.(`request failed: ${error?.message ?? String(error)}`);
			try {
				sendJson(res, 500, {
					ok: false,
					reason: error?.message ?? "internal"
				});
			} catch {}
		}
	};
	ctx.effect(() => ctx.webServer.register({
		kind: "prefix",
		path: API_PREFIX,
		/**
		 * ⚠️ 兜底：handler 万一抛异常或某条分支忘了回包，**绝不能把请求挂住**。
		 *
		 * 2026-10-17 真机事故：插件请求挂住 + 客户端没超时 ⇒ 浏览器把该源的
		 * 6 条连接全占满 ⇒ DSH 自己的接口、模型列表、新会话、发送全部排队，
		 * 用户看到「插件一开，什么都点不动」。
		 */
		handler: (req, res) => {
			/**
			 * ## 🔎 请求追踪（真机排障用）
			 *
			 * 手机上「接口没回应」时，必须先分清是**根本没到服务器**还是
			 * **到了但没回包**。这里只记路径、耗时、状态，不记任何内容，
			 * 超过 3 秒还没结束的记一条 PENDING —— 一眼就能看出卡在哪。
			 */
			const startedAt = Date.now();
			const tracePath = String(req.url ?? "").split("?")[0].slice(0, 120);
			let traced = false;
			const trace = (state) => {
				if (traced) return;
				traced = true;
				try {
					const file = join(stateRoot(), "request-trace.log");
					mkdirSync(dirname(file), { recursive: true });
					try { if (statSync(file).size > 512 * 1024) writeFileSync(file, ""); } catch {}
					writeFileSync(
						file,
						`${new Date().toISOString()} ${state} ${Date.now() - startedAt}ms ` +
						`${req.method ?? "GET"} ${tracePath} ${res.statusCode ?? ""}\n`,
						{ flag: "a" },
					);
				} catch { /* 追踪失败不影响请求 */ }
			};
			const slowTimer = setTimeout(() => trace("PENDING"), 3e3);
			if (typeof slowTimer?.unref === "function") slowTimer.unref();
			const finish = () => { clearTimeout(slowTimer); trace("DONE"); };
			res.on?.("finish", finish);
			res.on?.("close", finish);
			return Promise.resolve(handler(req, res)).catch((error) => {
			trace("ERROR " + String(error?.stack ?? error?.message ?? error).slice(0, 300).replace(/\s+/g, " "));
			try {
				if (res.headersSent !== true) {
					sendJson(res, 500, { ok: false, reason: `插件内部错误：${String(error?.message ?? error)}` });
				}
			} catch { /* 连错误都发不出去就只能放弃这次请求，但绝不能挂住连接 */ }
			})
		}
	}), "dsh-webin: api routes");
	/**
	 * 独立端口：同一份 handler，加 CORS（跨源才能被页面调用）。
	 * 端口被占用时**不影响主流程** —— 客户端会自动回退到 DSH 同源路由。
	 */
	ctx.effect(() => {
		let server;
		try {
			server = createServer((req, res) => {
				try {
					res.setHeader("access-control-allow-origin", "*");
					res.setHeader("access-control-allow-headers", "content-type, accept");
					res.setHeader("access-control-allow-methods", "GET, POST, PUT, DELETE, OPTIONS");
					if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
				} catch { /* 头写不进去也不影响后面 */ }
				void Promise.resolve(handler(req, res)).catch((error) => {
					try {
						if (res.headersSent !== true) {
							sendJson(res, 500, { ok: false, reason: String(error?.message ?? error) });
						}
					} catch { /* 放弃这次请求 */ }
				});
			});
			server.on("error", (error) => {
				log.warn?.(`独立端口 ${API_PORT} 不可用（${String(error?.message ?? error)}）—— 客户端会回退到同源接口`);
			});
			server.listen(API_PORT, "127.0.0.1");
			server.unref?.();
			log.info?.(`插件接口独立端口已监听：http://127.0.0.1:${API_PORT}${API_PREFIX}`);
		} catch (error) {
			log.warn?.(`独立端口启动失败：${String(error?.message ?? error)}`);
		}
		return () => { try { server?.close(); } catch { /* 关不掉不影响退出 */ } };
	}, "dsh-webin: dedicated api port");
	/**
	* ## ⭐⭐ 任务看门狗 —— 面板中途死亡时回收 claimed 任务
	*
	* ## 真实事故（用户截图）
	*
	* 「深度求索中，用时 1 分 43 秒」—— 而网页版早就「已停止」。
	* 面板在生成中途死亡 ⇒ 结果永远不来 ⇒ 任务永远 claimed ⇒
	* DSH 干等到 adapter 超时（默认 10 分钟）。
	*
	* 每 30 秒扫一次：claim 超 3 分钟没结果的任务标 failed，
	* DSH 立刻收到错误可以重试 —— 不让用户干等 10 分钟。
	*/
	ctx.effect(() => {
		const timer = setInterval(() => {
			try {
				/**
				* ⭐⭐ 传入**真实心跳**作为存活判据 —— 面板活着就不回收。
				*
				* 这条看门狗原来的文案写着「心跳停止」，但**从没读过心跳**，只是
				* 「claim 后 3 分钟没结果」的盲超时。用户实测：一轮长生成超过 3 分钟，
				* 文件其实已经写成功，任务却被误杀（面板全程心跳正常）。
				*/
				const reaped = queue.reapStaleClaimed(Date.now(), 18e4, () => liveClients().length > 0);
				if (reaped > 0) log.warn?.(`看门狗回收了 ${reaped} 个失联任务（面板心跳确实已停）`);
			} catch {}
		}, 3e4);
		return () => clearInterval(timer);
	}, "dsh-webin: claimed-task watchdog");
	// 不注入整页自动刷新：构建变更不得打断账号编辑、模型切换或正在发送的消息。
	// 客户端模块更新交给 DSH 自身；需要整页更新时由用户主动刷新。
	log.info?.(`host ready; api=${API_PREFIX} state=${stateRoot()}`);
}
//#endregion
/**
 * ⚠️ 额外导出 `BUILTIN_PROVIDERS` 是**为了让诊断脚本复用真实配置**。
 *
 * 否则 `scripts/test-platform.mjs` 这类脚本只能手抄一份平台定义
 * （选择器、enterOnly、replyCapture…），抄来的必然与真配置漂移 ——
 * 那正是「测试通过但线上不行」的经典来源。多导出一个常量没有副作用。
 */
export { apply, inject, name, BUILTIN_PROVIDERS };
/**
 * ⚠️ 额外导出 `parseToolCalls` 只**为了测试**（`scripts/test-tool-parse.mjs`）。
 *
 * 它是「模型回复 → DSH 工具调用」的唯一入口，一旦回归就是「工具调用不生效」
 * 这种用户一眼能看见的故障。导出它，测试就能跑**真函数**，而不是抄一份
 * 相似逻辑（抄的必然漂移，那正是「测试通过但线上不行」的来源）。
 */
export { parseToolCalls };

//# sourceMappingURL=index.js.map