// 从 client.js 里【逐字】切出脚本构造函数。用「缩进层级」配对，不用花括号（模板串里有 '{' 会误判）。
import fs from 'node:fs';
import path from 'node:path';

const SRC = 'C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\profiles\\web\\node_modules\\dsh-webin\\lib\\client.js';
const OUT_DIR = 'C:\\Users\\Evelyn\\AppData\\Local\\DeepSeekHarness\\.dsh\\work\\Evelyn\\ldw-driver';

const NAMES = [
  'buildDeepSeekHook',
  'buildProbeScript',
  'buildSnapshotScript',
  'buildDrainScript',
  'buildScrollScript',
  'buildScrapeScript',
  'buildFillScript',
  'buildTriggerScript',
  'buildClearInputScript',
  'buildThinkingScript',
  'buildStopScript',
  'buildContinueScript',
  'buildChromeUserAgent',
  'fingerprintFix',
];

const text = fs.readFileSync(SRC, 'utf8');
const lines = text.split(/\r?\n/);

/** 从 `function NAME(` 起，到「同缩进层级的单独 `}` 行」为止。 */
function findFunction(name) {
  const re = new RegExp(`^(\\s*)(?:async\\s+)?function\\s+${name}\\s*\\(`);
  let start = -1, indent = '';
  for (let i = 0; i < lines.length; i++) {
    const m = re.exec(lines[i]);
    if (m) { start = i; indent = m[1]; break; }
  }
  if (start < 0) return null;
  // 结束行 = 缩进与函数声明相同、且内容只有 `}`（可能带分号）
  const closeRe = new RegExp(`^${indent.replace(/\t/g, '\\t')}\\}\\s*;?\\s*$`);
  for (let i = start + 1; i < lines.length; i++) {
    if (closeRe.test(lines[i])) return [start + 1, i + 1];
  }
  return null;
}

const parts = [];
const report = [];
for (const n of NAMES) {
  const r = findFunction(n);
  if (!r) { report.push(`MISS ${n}`); continue; }
  const body = lines.slice(r[0] - 1, r[1]).join('\n');
  parts.push(body);
  report.push(`OK   ${n.padEnd(24)} lines ${String(r[0]).padStart(5)}-${String(r[1]).padStart(5)}  (${body.length} chars)`);
}
console.log(report.join('\n'));

fs.mkdirSync(OUT_DIR, { recursive: true });
const header = `// ⚠️ AUTO-EXTRACTED FROM dsh-webin v0.2.23 lib/client.js —— 逐字复制，未做任何改写。
// 来源 rev: f8d00be9c5df   提取时间: ${new Date().toISOString()}
// 目的: 让 webin 的原生 DOM 脚本（真打字 / 真点击 / 真读取）在 CDP 驱动的真 Edge 里跑。
// 若 dsh-webin 升级，本文件必须重新提取（DRIVER_SOURCE 记录提取来源）。
export const DRIVER_SOURCE = { plugin: 'dsh-webin', version: '0.2.23', rev: 'f8d00be9c5df' };

// —— 以下两个常量逐字复制自 client.js:10-12（hook 脚本依赖它们） ——
/** 幂等标记：重复注入不重复打补丁。 */
const MARKER = "__dshWebinHookInstalled__";
/** 事件缓冲在 window 上的键名（与 hook 内一致）。 */
const EVENT_QUEUE_KEY = \`\${MARKER}_events\`;

`;
const footer = `\n\nexport {\n${NAMES.map((n) => `  ${n},`).join('\n')}\n};\n`;
fs.writeFileSync(path.join(OUT_DIR, 'edge-driver-scripts.js'), header + parts.join('\n\n') + footer, 'utf8');
console.log('\n写出 ->', path.join(OUT_DIR, 'edge-driver-scripts.js'));

// 语法自检
const { execSync } = await import('node:child_process');
try {
  execSync(`"C:\\Users\\Evelyn\\AppData\\Local\\Programs\\DeepSeekHarness\\node\\node.exe" --check "${path.join(OUT_DIR, 'edge-driver-scripts.js')}"`, { stdio: 'pipe' });
  console.log('语法自检: 通过 ✅');
} catch (e) {
  console.log('语法自检: 失败 ❌\n' + String(e.stderr || e.message).slice(0, 1500));
}
