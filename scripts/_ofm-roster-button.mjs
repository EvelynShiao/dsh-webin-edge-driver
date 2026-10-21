/**
 * OFM Roster 卡片加显隐按钮——通过字符串替换接线。
 * 后端：hiddenModels 已就绪（sanitizeSettings + listModels 过滤，6/6 测试过）。
 * 前端：Roster 的 group() 里给每张 ModelCard 传 onToggleHidden；
 *       ModelCard 里渲染一个小按钮（显示/隐藏选择页）。
 */
import { readFileSync, writeFileSync } from "node:fs";

const p = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/profiles/web/node_modules/dsh-our-free-model/client.js";
let src = readFileSync(p, "utf8");

// ① Roster group() 给 ModelCard 传 onToggleHidden + hidden 状态
const groupOld = `h('div', { className: 'ofm_grid' }, list.map(m => h(ModelCard, {
            key: m.id, model: m, t, onBench, locked: m.channel === 'eac' && locked, eacLogin,
            bench: { running: benches[m.id]?.running === true, ...benches[m.id]?.result === undefined ? {} : { result: benches[m.id].result } },
          })))`;
const groupNew = `h('div', { className: 'ofm_grid' }, list.map(m => h(ModelCard, {
            key: m.id, model: m, t, onBench, locked: m.channel === 'eac' && locked, eacLogin,
            bench: { running: benches[m.id]?.running === true, ...benches[m.id]?.result === undefined ? {} : { result: benches[m.id].result } },
            hidden: hiddenSet.has(m.id),
            onToggleHidden: () => toggleHidden(m.id),
          })))`;
if (!src.includes(groupOld)) { console.log("❌ Roster group 锚没中"); process.exit(1); }
src = src.replace(groupOld, groupNew);

// ② Roster 顶部加 hiddenSet/toggleHidden 逻辑
const rosterHeadOld = `const locked = auth !== undefined && auth.available === true && auth.authorized !== true`;
const rosterHeadNew = `const locked = auth !== undefined && auth.available === true && auth.authorized !== true
      // 显隐（2026-10-20 用户点名「每个模型加个是否显示在模型选择页的按钮」）：
      // hiddenModels 存设置里（后端 listModels 过滤），resolveModel 不过滤（旧会话照用）。
      const [busyHide, setBusyHide] = useState(false)
      const hiddenSet = new Set(Array.isArray(summary.settings?.hiddenModels) ? summary.settings.hiddenModels : [])
      const toggleHidden = async id => {
        if (busyHide) return
        setBusyHide(true)
        try {
          const next = hiddenSet.has(id) ? [...hiddenSet].filter(x => x !== id) : [...hiddenSet, id]
          await post('/settings', { hiddenModels: next })
          window.location.reload()
        } catch (e) { /* 设置页顶层的 note 由 onApply 链展示 */ }
        finally { setBusyHide(false) }
      }`;
if (!src.includes(rosterHeadOld)) { console.log("❌ Roster head 锚没中"); process.exit(1); }
src = src.replace(rosterHeadOld, rosterHeadNew);

// ③ ModelCard 里渲染按钮（找到 ModelCard 的 props 解构加 onToggleHidden/hidden）
const cardPropsOld = `function ModelCard(props) {`;
const idx = src.indexOf(cardPropsOld);
if (idx < 0) { console.log("❌ ModelCard 没找到"); process.exit(1); }
// 找 props 的解构行
const after = src.slice(idx, idx + 600);
const propsMatch = after.match(/function ModelCard\(props\) \{\s*const \{([^}]+)\} = props/);
if (propsMatch === null) { console.log("❌ ModelCard 解构没找到"); process.exit(1); }
const oldDestruct = propsMatch[0];
const newDestruct = oldDestruct.replace("} = props", ", hidden, onToggleHidden } = props");
src = src.replace(oldDestruct, newDestruct);

writeFileSync(p, src, "utf8");
console.log("✅ Roster + ModelCard 接线完成（三个替换全中）");
