/** Bearer auth 注入辅助 + 三个 API（list/rename/delete）的页面 fetch 统一改造。
 *  本脚本：抠出 edge-driver.js 里 listSessions/renameSession/deleteSession 的 fetch 段，
 *  在每个 fetch 调用注入 Authorization 头。
 */
import { readFileSync, writeFileSync } from "node:fs";
const p = "C:/Users/Evelyn/AppData/Local/DeepSeekHarness/.dsh/plugin-src/dsh-webin-edge-driver/lib/edge-driver.js";
let src = readFileSync(p, "utf8");

/** 通用 Bearer 头构造（注入进每个页面 fetch expr 的开头）。 */
const bearerInit = `const bearer = (() => { try { const t = localStorage.getItem('userToken'); return t ? 'Bearer ' + (JSON.parse(t).value ?? t) : ''; } catch (e) { return ''; } })();`;

/** ① listSessions 的 fetch——原来是 `const r = await fetch(u, { credentials: 'include' });` */
const listOld = `const r = await fetch(u, { credentials: 'include' });`;
const listNew = `${bearerInit}\n        const r = await fetch(u, { credentials: 'include', headers: { 'Authorization': bearer } });`;
if (!src.includes(listOld)) { console.log("❌ listSession fetch 锚没中"); process.exit(1); }
src = src.replace(listOld, listNew);
console.log("① listSessions ✅");

/** ② renameSession 的 fetch——`const r = await fetch(cfg.renamePath, { method: cfg.renameMethod || 'POST', ...` */
const renameOld = `const r = await fetch(cfg.renamePath, { method: cfg.renameMethod || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });`;
const renameNew = `${bearerInit}\n      const r = await fetch(cfg.renamePath, { method: cfg.renameMethod || 'POST', headers: { 'content-type': 'application/json', 'Authorization': bearer }, body: JSON.stringify(payload) });`;
if (!src.includes(renameOld)) { console.log("❌ rename fetch 锚没中"); process.exit(1); }
src = src.replace(renameOld, renameNew);
console.log("② renameSession ✅");

/** ③ deleteSession 的 fetch——`const r = await fetch(cfg.deletePath, { method: cfg.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });` */
const delOld = `const r = await fetch(cfg.deletePath, { method: cfg.method || 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) });`;
const delNew = `${bearerInit}\n      const r = await fetch(cfg.deletePath, { method: cfg.method || 'POST', headers: { 'content-type': 'application/json', 'Authorization': bearer }, body: JSON.stringify(payload) });`;
if (!src.includes(delOld)) { console.log("❌ delete fetch 锚没中"); process.exit(1); }
src = src.replace(delOld, delNew);
console.log("③ deleteSession ✅");

writeFileSync(p, src, "utf8");
console.log("全部写入完成");
