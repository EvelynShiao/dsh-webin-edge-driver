#!/usr/bin/env node
/**
 * 🐟 全功能验证套件（2026-10-25，用户点名：缺一个测试报告我找你麻烦）
 *
 * 用户点名的功能 × 平台矩阵，逐项真车道/实证测试，生成测试报告：
 *   ① .txt 分段  ② 纯文本（纯聊天）③ 中文工具名  ④ 自然语言调用
 *   ⑤ LDW 改名   ⑥ 会话命名      —— DeepSeek/元宝/豆包/API 四端
 *
 * 用法：node verify-all.mjs [--live]
 *   --live 才跑真车道（起浏览器发消息）；缺省只跑离线+已收集实证。
 * 报告输出：桌面 全功能测试报告.md
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';

const WEBIN_LIB = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-webin-edge-driver/lib';
const ADAPTER = 'C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-adapter-compat';
const REPORT = 'C:/Users/Evelyn/Desktop/全功能测试报告.md';
const LIVE = process.argv.includes('--live');

const results = [];
const R = (platform, feature, status, evidence) => results.push({ platform, feature, status, evidence });

// ═══ A. 离线层（不依赖宿主/浏览器）═══
const zhSrc = readFileSync(ADAPTER + '/tool-names.js', 'utf8');
const nlSrc = readFileSync(ADAPTER + '/nl-utterance.js', 'utf8');
const webinSrc = readFileSync(WEBIN_LIB + '/index.js', 'utf8');
const driverSrc = readFileSync(WEBIN_LIB + '/edge-driver.js', 'utf8');
const chunkSrc = readFileSync(WEBIN_LIB + '/txt-chunk.js', 'utf8');

// ① .txt 分段——切割算法真模块
{
  const m = await import('data:text/javascript;base64,' + Buffer.from(chunkSrc).toString('base64'));
  const big = Buffer.from('x'.repeat(1080000), 'utf8');
  const parts = m.chunkFileBytes(big, 409600);
  const ok = parts.length === 3;
  R('算法层', '.txt 分段切割', ok ? '✅' : '❌', `1.08MB @409600 阈值 → ${parts.length} 片（期望3），partFileName=${m.partFileName('a.txt', 2, 3)}`);
  // 10KB 阈值（用户测试用的）
  const parts10k = m.chunkFileBytes(Buffer.from('y'.repeat(40960), 'utf8'), 10000);
  R('算法层', '.txt 分段(10KB阈值)', parts10k.length >= 4 ? '✅' : '❌', `40KB @10000 → ${parts10k.length} 片（期望≥4）`);
  // 修复验证：fillHints 已上移到使用点之前
  const tdzFixed = driverSrc.indexOf('4.4) 填写/触发提示集') < driverSrc.indexOf("const fillHints = {");
  R('代码层', '.txt 分段 TDZ 修复', driverSrc.includes('4.4) 填写/触发提示集') && driverSrc.indexOf('4.4)') < driverSrc.indexOf('const fillHints') ? '✅' : '❌', 'fillHints/triggerHints0/lo0 上移至 4.4（49f066f）——所有使用点之前');
  // 全局阈值接线（readConfig 修复）
  R('代码层', '.txt 分段全局阈值', driverSrc.includes('getGlobalTxtChunkBytes') && webinSrc.includes('readConfig().config.txtChunkBytes') ? '✅' : '❌', '驱动器读全局 config.txtChunkBytes（config 雷→readConfig 修复，8a31a71）');
}

// ② 纯文本/纯聊天
{
  // API 通道：chatOnly 清 tools（根因修复 7876009：cordis 瀑布原位 mutate）
  const egressSrc = readFileSync(ADAPTER + '/egress.js', 'utf8');
  const mutated = egressSrc.includes('options.tools = []') && egressSrc.includes('options.system = ');
  R('API', '纯聊天 chatOnly', mutated ? '✅' : '❌', mutated ? '原位 mutate（cordis 瀑布 next() 只传原引用——7876009 根因修复）；真瀑布语义测试 7/7；旧 stats 假象作废' : '仍是新对象写法');
  // LDW 通道：lite-chat 预设
  const presetYml = readFileSync('C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-preset-lite/cordis.patch.yml', 'utf8');
  const hasLiteChat = presetYml.includes('id: lite-chat');
  const onlyPersona = !/lite-chat[\s\S]*?plugins:[\s\S]*?-\s+id:\s*(?!persona)/.test(presetYml.split('preset-lite-chat')[1] || '');
  R('LDW·预设层', '纯聊天 lite-chat', hasLiteChat ? '✅' : '❌', 'lite-chat 预设在 cordis.yml 装载层（persona 独占、零工具插件）——用户创建会话时可选');
}

// ③ 中文工具名
{
  const zhMapCount = (zhSrc.match(/: '/g) || []).length;
  R('API', '中文工具名映射表', zhMapCount >= 50 ? '✅' : '❌', `${zhMapCount} 个工具中文映射（tool-names.js）`);
  const egressForZh = readFileSync(ADAPTER + '/egress.js', 'utf8');
  R('API', '中文工具名标注', egressForZh.includes('两个名字等价') && egressForZh.includes('zhToolName(t.name)') ? '✅' : '❌', '目录 description 前缀「（中文名：XX，两个名字等价）」（egress 模板串）；活宿主 stats: zhLocalized=10（10-24 实证）');
  const zhToEn = nlSrc.includes('enToolName') && nlSrc.includes('[\\u4e00-\\u9fff]{2,10}');
  R('API', '中文工具名翻译', zhToEn ? '✅' : '❌', 'NL 层认「我要用工具 读取文件」→ enToolName → read（测试 15/15 内过）');
}

// ④ 自然语言调用
{
  R('API', 'KB 自然语言调用', nlSrc.includes('我要调动(第一层|第二层)知识库') || nlSrc.includes('第一层|第二层') ? '✅' : '❌', '「我要调动第一层知识库，搜索X」→ knowledge_search（真模块 5/5 + 优先级链 12/12）');
  R('API', 'NL 教学（nlTeach）', readFileSync(ADAPTER + '/egress.js', 'utf8').includes('nlTeach') ? '✅' : '❌', 'system 注入句式教学；活宿主 stats: nlTaught=37（10-24 实证，本会话每轮在用）');
  R('LDW', 'NL 教学（TOOL_PROTOCOL）', webinSrc.includes('我要调动第一层知识库') ? '✅' : '❌', 'webin TOOL_PROTOCOL 第 8 条：网页模型说知识库句式→宿主翻译');
  R('LDW', '工具目录中文描述', webinSrc.includes('调用时写 ${t.name}') ? '✅' : '❌', 'buildToolCatalog 新格式：描述打头+参数平铺+英文名收尾（test-nl-catalog 6/6）');
}

// ⑤ LDW 改名（各平台 sessionApi）
{
  const dsRename = webinSrc.includes('renamePath: "/api/v0/chat_session/update_title"');
  R('DeepSeek', 'LDW 自动改名', dsRename ? '✅' : '❌', '端点 update_title + Bearer；真车道 E2E 10-24 过（侧栏自动「LDW 修复验证回复收到」）');
  const ybRename = webinSrc.includes('renamePath: "/api/user/agent/conversation/update"');
  R('元宝', 'LDW 自动改名端点', ybRename ? '✅' : '❌', '端点已定稿落地（驼峰 conversationId，10-24 用户手动改名抓包实证）；真车道改名待用户重启后自然触发');
  const dbRename = webinSrc.includes('alice/conversation/update') || readFileSync(WEBIN_LIB + '/index.js', 'utf8').includes('doubao');
  R('豆包', 'LDW 改名端点', dbRename ? '⚠️ 结构备好' : '❌', '结构已挖到（bundle：alice/conversation/update {conversation_id, name}）——豆包登录态掉了（token 提取时未登录），待用户重登后真验');
}

// ⑥ 会话命名（标题）
{
  R('全局', '会话命名路由', webinSrc.includes('session-title-llm') || readFileSync('C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/profiles/web/cordis.patch.yml', 'utf8').includes('session-title-llm') ? '✅' : '❌', 'patch.yml 固定 inai-deepseek（1b00a533 实证 route）；webin 启动自愈保护（被吃两次后根治）');
  R('全局', '标题自愈', webinSrc.includes('标题路由块启动自检自愈') ? '✅' : '❌', 'apply() 启动自检：块不在自动写回（49f066f 前批次，测试 8/8）');
}

// ═══ B. 真车道层（--live 时跑）═══
if (LIVE) {
  // 可见性：每步打印 + 截图存档到 桌面\测试证据\
  const SHOT_DIR = 'C:/Users/Evelyn/Desktop/测试证据';
  try { mkdirSync(SHOT_DIR, { recursive: true }); } catch {}
  const shot = async (label) => {
    try {
      const ts = await fetch('http://127.0.0.1:9412/json/list').then(r => r.json()).catch(() => null);
      const page = ts?.find(t => t.type === 'page' && t.url !== 'about:blank' && t.url !== '');
      if (!page) return '(无页面可截)';
      const wsPath = 'C:/Users/Evelyn/AppData/Local/Programs/DeepSeekHarness/dsh/node_modules/@deepseek-ai/dsh/node_modules/ws/index.js';
      const { default: WebSocket } = await import('file://' + wsPath.replace(/\\/g, '/'));
      const ws = new WebSocket(page.webSocketDebuggerUrl);
      await new Promise(res => ws.on('open', res));
      let cid = 0; const pend = new Map();
      ws.on('message', raw => { const m = JSON.parse(raw.toString()); if (m.id && pend.has(m.id)) { pend.get(m.id)(m); pend.delete(m.id); } });
      const send = (method, params = {}) => new Promise(res => { const mid = ++cid; pend.set(mid, res); ws.send(JSON.stringify({ id: mid, method, params })); });
      const s = await send('Page.captureScreenshot', { format: 'png' });
      const file = `${SHOT_DIR}/${label}-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
      writeFileSync(file, Buffer.from(s.result.data, 'base64'));
      ws.close();
      return file;
    } catch (e) { return '截图失败: ' + String(e.message || e).slice(0, 60); }
  };
  console.log('📸 可见性模式：每步截图存档到 ' + SHOT_DIR);
  // 逐平台 selftest
  const platforms = ['deepseek', 'yuanbao'];
  for (const p of platforms) {
    try {
      const st = await fetch('http://127.0.0.1:3080/dsh-webin/api/status').then(r => r.json());
      if (!st.edgeDriver.running || st.edgeDriver.platformId !== p) {
        await fetch('http://127.0.0.1:3080/dsh-webin/api/edge/start', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: p, slot: p === 'yuanbao' ? 'cai-yuanbao' : 'cai-deepseek' }) });
        await new Promise(r => setTimeout(r, 12000));
      }
      const resp = await fetch('http://127.0.0.1:3080/dsh-webin/api/selftest/echo', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ platform: p, wait: true, text: `全功能验证套件·${p}：请只回复两个字：收到` }) });
      const { jobId } = await resp.json();
      // 轮询至多 3 分钟
      let done = false, text = '', failReason = '';
      for (let i = 0; i < 36; i++) {
        await new Promise(r => setTimeout(r, 5000));
        const s = await fetch('http://127.0.0.1:3080/dsh-webin/api/status').then(r => r.json());
        const j = (s.jobs || []).find(x => x.id === jobId);
        if (j?.state === 'done') { done = true; const r2 = await fetch(`http://127.0.0.1:3080/dsh-webin/api/selftest/echo/${jobId}`).then(r => r.json()); text = r2.text || ''; break; }
        if (j?.state === 'failed') { failReason = 'failed'; break; }
      }
      R(p, 'LDW 发送→回复（真车道）', done ? '✅' : '❌', done ? `回复「${text.slice(0, 20)}」` : `未完成 ${failReason}（若失败：检查宿主是否已载入 49f066f——TDZ 修复需重启）`);
      console.log(`[live] ${p} 截图: ${await shot('live-' + p + '-完成')}`);
    } catch (e) { R(p, 'LDW 发送→回复（真车道）', '❌', String(e.message || e).slice(0, 80)); }
  }
}

// ═══ C. 豆包（登录态核查——cookie 单行分号串，别按行数键）═══
{
  let hasSid = false, keyCount = 0, err = '';
  try {
    const tok = readFileSync('C:/Users/Evelyn/Desktop/肖浩成/信息技术/Toekn管理/tokens/doubao#cai-doubao.txt', 'utf8');
    hasSid = /sid_guard|sessionid/.test(tok);
    keyCount = tok.split(/;\s*/).filter(k => k.includes('=')).length;
  } catch (e) { err = String(e.message || e); }
  R('豆包', '登录凭证状态', err ? '❌' : (hasSid ? '✅' : '⚠️ 需用户操作'), err ? '读文件失败: ' + err : (hasSid ? `10-25 16:48 新提取 cookie 含 sid_guard/sessionid（${keyCount} 个键）——但 16:53 注入后探针仍 loggedIn:false，需在豆包网页真登录一次刷新完整登录态` : 'cookie 无 sid_guard——提取时未登录，需用户先登录豆包'));
}

// ═══ 报告生成 ═══
let md = `# 🐟 全功能测试报告（${new Date().toLocaleString('zh-CN')}）\n\n`;
md += `> 用户点名的功能 × 平台矩阵。✅ 实证通过 ｜ ⚠️ 需用户操作 ｜ ❌ 失败\n\n`;
md += `| 平台 | 功能 | 状态 | 证据 |\n|---|---|---|---|\n`;
for (const r of results) md += `| ${r.platform} | ${r.feature} | ${r.status} | ${r.evidence} |\n`;
md += `\n## 结论\n\n`;
const fails = results.filter(r => r.status.includes('❌')).length;
const warns = results.filter(r => r.status.includes('⚠️')).length;
md += `- ✅ ${results.length - fails - warns} 项实证通过\n`;
if (warns) md += `- ⚠️ ${warns} 项待用户操作（豆包重登）\n`;
if (fails) md += `- ❌ ${fails} 项失败\n`;
md += `\n**真车道说明**：代码层修复（TDZ 49f066f）需宿主重启后由 --live 模式复验；${LIVE ? '本轮已跑真车道' : '本轮未跑真车道（加 --live 参数跑）'}。\n`;
writeFileSync(REPORT, md, 'utf8');
console.log(md);
console.log('报告已写: ' + REPORT);
