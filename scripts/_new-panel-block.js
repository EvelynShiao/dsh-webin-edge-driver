  // ── 页面档位 / 页面模式（元宝两层菜单、豆包模式层）──────────────

  /** 可见性判定片段（注入脚本里复用）。 */
  _visExpr() {
    return "((e)=>!!(e&&(e.offsetWidth||e.offsetHeight||e.getClientRects().length)))";
  }

  /**
   * 打开「模型 / 模式选择」面板。
   *
   * 元宝与豆包的入口不同（元宝 `button[aria-label="Switch model"]`；
   * 豆包是输入框旁的 `chat_input_action_mode` 之类的按钮），所以用
   * **关键词 + 可见性**统一找：命中「switch model / 模型 / mode / 模式 /
   * hy·/deepseek/混元/聊天/工作」的可见按钮即为入口。
   *
   * @returns 'opened' | 'already' | 'no-button' | 'err'
   */
  async _openPanel() {
    const vis = this._visExpr();
    const expr = `(() => {
      const vis=${vis};
      const kw=/switch model|模型|mode|模式|hy\\d|deepseek|混元|hunyuan|聊天|工作/i;
      const cands=[...document.querySelectorAll('button,[role="button"],[data-testid]')].filter(vis);
      const hit=cands.find(e=>kw.test(String(e.getAttribute('aria-label')||'')+String(e.getAttribute('data-testid')||'')+String(e.innerText||'')));
      if(!hit) return 'no-button';
      if (hit.getAttribute('aria-expanded') === 'true') return 'already';
      hit.click();
      return 'opened';
    })()`;
    const r = String(await this.evalInPage(expr, 10000).catch(() => "err"));
    if (r === "opened") await sleep(1200);
    return r;
  }

  /** 读当前展开面板里的条目文本（去重、截断）。 */
  async _readPanelItems() {
    const vis = this._visExpr();
    const expr = `(() => {
      const vis=${vis};
      const sels=['[role="menuitemradio"]','[role="menuitem"]','[role="option"]','[class*="model-item"]','[class*="modelItem"]','[class*="mode-item"]','[class*="dropdown"] li','[class*="popup"] li','[class*="menu"] li','[class*="list"] > *'];
      const out=[],seen=new Set();
      for(const s of sels){
        for(const e of document.querySelectorAll(s)){
          if(!vis(e)) continue;
          const t=String(e.innerText||'').trim().replace(/\\n+/g,' | ');
          if(t.length<2||t.length>200) continue;
          const k=t.slice(0,40);
          if(seen.has(k)) continue; seen.add(k);
          out.push(t.slice(0,80));
          if(out.length>=24) break;
        }
        if(out.length>=24) break;
      }
      return JSON.stringify(out);
    })()`;
    const raw = String(await this.evalInPage(expr, 15000).catch(() => "[]"));
    try { return JSON.parse(raw); } catch { return []; }
  }

  /** 在已展开的面板里点一个条目（文本前缀优先、包含兜底）。 */
  async _pickPanelItem(want) {
    const vis = this._visExpr();
    const expr = `(() => {
      const vis=${vis};
      const want=${JSON.stringify(String(want ?? ""))};
      const sels=['[role="menuitemradio"]','[role="menuitem"]','[role="option"]','[class*="model-item"]','[class*="modelItem"]','[class*="mode-item"]','[class*="dropdown"] li','[class*="popup"] li','[class*="menu"] li'];
      const items=[];
      for(const s of sels){
        for(const e of document.querySelectorAll(s)){
          if(!vis(e)) continue;
          const t=String(e.innerText||'').trim();
          if(t.length<2||t.length>200) continue;
          items.push(e);
        }
      }
      if(items.length===0) return 'no-items';
      const w=want.toLowerCase();
      const head=(e)=>String(e.innerText||'').trim().split('\\n')[0].toLowerCase();
      const hit=items.find(e=>head(e).startsWith(w)) || items.find(e=>String(e.innerText||'').trim().toLowerCase().includes(w));
      if(!hit) return 'no-match:'+items.map(e=>String(e.innerText||'').trim().split('\\n')[0]).slice(0,12).join('|');
      hit.click();
      return 'picked';
    })()`;
    const r = String(await this.evalInPage(expr, 12000).catch(() => "err"));
    await sleep(900);
    return r;
  }

  /** 关掉面板（Escape + 点回输入框）—— 它盖在输入区上方，不关会挡填字/发送。 */
  async _closePanel() {
    await this.evalInPage("(() => { try { document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true})); } catch(e){} try { const ed=document.querySelector('div.ql-editor,textarea,div[contenteditable=\"true\"]'); if(ed) ed.click(); } catch(e){} return 'closed'; })()", 8000).catch(() => undefined);
    await sleep(350);
  }

  /** 面板里是否有「Models」容器项（元宝的模型子层入口）。 */
  _modelsEntryOf(items) {
    return items.find((t) => /^(models?|模型)\b/i.test(String(t).split(" | ")[0]));
  }

  /**
   * ## 探测两层菜单（2026-10-18 第三批，用户截图定案）
   *
   * 元宝结构：
   *   - 模式层：Instant / Thinking / Expert（+ Models 容器项）
   *   - 模型子层（点 Models 展开）：Hy4 preview / Hy3 / DeepSeek
   *
   * 豆包结构：
   *   - 模式层：聊天 / 工作
   *
   * @returns {Promise<{ok:boolean,modes:Array<{text:string}>,models:Array<{text:string}>,raw:object,reason?:string}>}
   */
  async detectPageModels(provider) {
    const opened = await this._openPanel();
    if (opened !== "opened" && opened !== "already") return { ok: false, reason: opened, modes: [], models: [], raw: {} };
    await sleep(900);
    const top = await this._readPanelItems();
    /** 有 Models 容器 ⇒ 展开读子层。 */
    const entry = this._modelsEntryOf(top);
    let sub = [];
    if (entry !== undefined) {
      const picked = await this._pickPanelItem(String(entry).split(" | ")[0]);
      if (String(picked).startsWith("picked")) {
        await sleep(1100);
        sub = await this._readPanelItems();
      }
    }
    await this._closePanel();
    const modes = top.filter((t) => t !== entry).map((t) => ({ text: String(t).split(" | ")[0] }));
    const models = (sub.length > 0 ? sub : top).map((t) => ({ text: String(t).split(" | ")[0] }));
    return {
      ok: modes.length > 0 || models.length > 0,
      modes,
      models,
      raw: { top, sub },
      reason: modes.length > 0 || models.length > 0 ? "" : "no-items",
    };
  }

  /**
   * 拨「页面模式」。
   *
   *   - 元宝：Instant / Thinking / Expert
   *   - 豆包：聊天 / 工作
   *
   * 失败**不阻断**（拨不到就用页面当前模式继续发）。
   */
  async applyPageMode(provider, pageMode) {
    const want = String(pageMode ?? "").trim();
    if (want === "") return { ok: false, reason: "empty" };
    const opened = await this._openPanel();
    if (opened === "no-button" || opened === "err") return { ok: false, reason: opened };
    await sleep(900);
    const picked = await this._pickPanelItem(want);
    await this._closePanel();
    if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 模式 ${want} → ${picked}`);
    return { ok: String(picked).startsWith("picked"), reason: picked };
  }

  /**
   * 拨「页面模型」（2026-10-18 起支持两层：先在模式面板里展开 Models 子层）。
   *
   * 两条原则不变：
   *   1. **找不到就不拨、不报错** —— 档位是加分项，不是发消息的前提；
   *   2. **拨完必须关掉弹层** —— 它盖在输入区上方，不关会挡住填字/发送。
   */
  async applyPageModel(provider, pageModel) {
    const want = String(pageModel ?? "").trim();
    if (want === "") return { ok: false, reason: "empty" };
    /** 不再限平台：自动识别出的档位任何平台都可能用。 */
    const opened = await this._openPanel();
    if (opened === "no-button" || opened === "err") return { ok: false, reason: opened };
    await sleep(900);
    /** 先看顶层有没有 Models 容器（元宝）——有就展开子层再选。 */
    const top = await this._readPanelItems();
    const entry = this._modelsEntryOf(top);
    if (entry !== undefined) {
      const picked = await this._pickPanelItem(String(entry).split(" | ")[0]);
      if (String(picked).startsWith("picked")) await sleep(1100);
    }
    const result = await this._pickPanelItem(want);
    await this._closePanel();
    if (this.config.verboseLog) this.log.debug?.(`[edge-driver] 模型 ${want} → ${result}`);
    return { ok: String(result).startsWith("picked"), reason: result };
  }

