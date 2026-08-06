// ==UserScript==
// @name         福建省作品自愿登记系统 - 强制PC版+自动登录+直达首页
// @namespace    http://tampermonkey.net/
// @version      17.7
// @description  覆盖宽度/媒体查询拦截h5；自动登录+自动首页；自动处理"[DID]登录状态已过期"弹窗；过期后默认跳转登录页，加 ?nojump 改为原地重登；v17.5 心跳默认开启（2分钟一次保活），网址加 ?noheartbeat 可关闭
// @author       Heyden Lin
// @license      MIT
// @copyright    Copyright (c) 2026 Heyden Lin
// 首次发布于 2026-08-07 by Heyden Lin（本作品原创作者；衍生作品须保留署名，禁止冒领为本人原创软件著作权）
// @match        http://copyright.fjxuanchuan.cn/*
// @match        https://copyright.fjxuanchuan.cn/*
// @run-at       document-start
// @grant        unsafeWindow
// ==/UserScript==

(function () {
  'use strict';

  const W = (typeof unsafeWindow !== 'undefined' && unsafeWindow) ? unsafeWindow : window;

  const CONFIG = {
    HOME_CANDIDATES: ['首页', '工作台', '概况', '主页', '概览', '个人中心', '首页概览'],
    LOGIN_CANDIDATES: ['登录', '重新登录', '确认登录', '立即登录', '点击登录', '去登录', '登 录'],
    EXPIRED_CANDIDATES: ['登录状态已过期', '[DID]登录状态已过期', '会话已过期', '登录已过期', '会话超时'],
    OK_CANDIDATES: ['确定', '确认', '好的', 'OK', '知道了'],
    // 用于判断"当前是不是已经在首页"，避免多余点击
    HOME_PAGE_INDICATORS: ['作品总数', '待审核作品数量', '待修改作品数量', '您好，', '快捷菜单', '首页概览'],
    // 用于判断"当前是不是在填报页/我的作品页"，只有这些页面才需要自动点首页
    UNWANTED_PAGE_INDICATORS: ['在线填报', '我的作品在线填报', '作品登记', '在线登记'],
    AUTO_WINDOW_MS: 30000,
    DISABLE_HOME_FLAG: 'nohome',
    DISABLE_LOGIN_FLAG: 'nologin',
    HEARTBEAT_INTERVAL_MS: 120000, // 2 分钟发一次（比 3 分钟更稳）
    HEARTBEAT_FLAG: 'heartbeat',
    NO_HEARTBEAT_FLAG: 'noheartbeat', // 网址加 ?noheartbeat 可关闭心跳
    JUMP_TO_LOGIN_FLAG: 'jump',       // 过期弹窗点确定后自动跳转登录页（当前默认即跳转）
    NO_JUMP_TO_LOGIN_FLAG: 'nojump',  // 过期弹窗点确定后不跳转，改为原地重登
    LOGIN_PATH: '/login',             // 跳转目标路径，若站点不同可改
  };

  const SKIP_TAGS = new Set(['SCRIPT','STYLE','HEAD','TITLE','META','HTML','BODY','LINK','NOSCRIPT','IFRAME']);

  console.log('[登记助手] v17.7 已加载，unsafeWindow=', W === window ? 'same' : 'got');

  // ============================================================
  // 第一阶段：覆盖宽度 / 媒体查询
  // ============================================================
  (function setupWidth() {
    const FAKE_W = 1920, FAKE_H = 1080;
    function defineGet(obj, prop, getter) {
      try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); }
      catch (e) { console.log('[强制PC版] ' + prop + ' 覆盖失败:', e.message); }
    }
    defineGet(W, 'innerWidth', () => FAKE_W);
    defineGet(W, 'innerHeight', () => FAKE_H);
    defineGet(W, 'outerWidth', () => FAKE_W);
    defineGet(W, 'outerHeight', () => FAKE_H);
    if (W.screen) {
      defineGet(W.screen, 'width', () => FAKE_W);
      defineGet(W.screen, 'height', () => FAKE_H);
      defineGet(W.screen, 'availWidth', () => FAKE_W);
      defineGet(W.screen, 'availHeight', () => FAKE_H);
    }
    try {
      const om = W.matchMedia;
      W.matchMedia = function (q) {
        if (typeof q === 'string' && /max-width\s*:\s*\d+px/i.test(q)) {
          return { matches: false, media: q, addListener(){}, removeListener(){}, addEventListener(){}, removeEventListener(){}, dispatchEvent(){return false;} };
        }
        return om.call(W, q);
      };
    } catch (e) { console.log('[强制PC版] matchMedia 覆盖失败:', e.message); }
  })();

  // ============================================================
  // 第二阶段：拦截 history.pushState/replaceState 与 window.open 中跳 /h5/ 的调用
  // ============================================================
  (function setupHistoryOpen() {
    const BLOCK = '/h5/';
    ['pushState', 'replaceState'].forEach(function (fn) {
      try {
        const orig = W.history[fn];
        W.history[fn] = function (state, title, url) {
          if (typeof url === 'string' && url.indexOf(BLOCK) !== -1) { console.log('[强制PC版] 拦截 history.' + fn + ':', url); return; }
          return orig.apply(this, arguments);
        };
      } catch (e) { console.log('[强制PC版] history.' + fn + ' 失败:', e.message); }
    });
    try {
      const origOpen = W.open;
      W.open = function (url, t, f) {
        if (typeof url === 'string' && url.indexOf(BLOCK) !== -1) { console.log('[强制PC版] 拦截 window.open:', url); return null; }
        return origOpen.apply(this, arguments);
      };
    } catch (e) { console.log('[强制PC版] window.open 失败:', e.message); }
  })();

  if (W.location.pathname.indexOf('/h5/') === 0) {
    console.log('[强制PC版] 已在H5版，拉回 /indexPage');
    W.location.replace('/indexPage');
  }

  // ============================================================
  // 第三阶段：自动登录 + 自动点首页 + 自动处理过期弹窗
  // ============================================================
  function isRealButton(el) {
    if (!el || el.nodeType !== 1) return false;
    const tag = el.tagName;
    if (tag === 'BUTTON' || tag === 'A') return true;
    const role = el.getAttribute && el.getAttribute('role');
    if (role === 'button' || role === 'link') return true;
    return false;
  }

  function isClickableContainer(el) {
    if (!el || el.nodeType !== 1) return false;
    const cls = (el.className || '').toString().toLowerCase();
    if (cls.indexOf('btn') !== -1 || cls.indexOf('button') !== -1) return true;
    if (typeof el.onclick === 'function') return true;
    if (el.getAttribute && el.getAttribute('role') === 'menuitem') return true;
    return false;
  }

  function findBestClickable(startEl) {
    let el = startEl;
    let firstRealBtn = null;
    let firstContainer = null;
    while (el && el !== W.document.body && el !== W.document.documentElement) {
      if (!firstRealBtn && isRealButton(el)) firstRealBtn = el;
      if (!firstContainer && isClickableContainer(el)) firstContainer = el;
      el = el.parentElement;
    }
    return firstRealBtn || firstContainer || startEl;
  }

  function findClickableByText(matchFn, debugName) {
    const doc = W.document;
    if (!doc) return null;
    let best = null;
    let bestScore = -1;
    const debugList = [];
    for (const el of doc.querySelectorAll('*')) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      const t = (el.textContent || '').trim();
      if (!t) continue;
      if (matchFn(t)) {
        const clickable = findBestClickable(el);
        let score = 0;
        if (isRealButton(clickable)) score += 20;
        else if (isClickableContainer(clickable)) score += 10;
        if (clickable && clickable.offsetParent !== null) score += 1;
        debugList.push({ text: t, tag: el.tagName, cls: (el.className||'').slice(0,60), clickableTag: clickable && clickable.tagName, clickableCls: clickable && (clickable.className||'').slice(0,60), score: score });
        if (score > bestScore) { bestScore = score; best = clickable; }
      }
    }
    if (debugList.length) console.log('[登记助手] 找到', debugName, '候选:', debugList.slice(0, 8));
    return best;
  }

  function normalizeText(t) {
    return (t || '').replace(/\s+/g, ' ').trim();
  }

  function isVisible(el) {
    if (!el || typeof el.getBoundingClientRect !== 'function') return false;
    const rect = el.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function textMatchesOk(t) {
    const nt = normalizeText(t);
    if (!nt) return false;
    return CONFIG.OK_CANDIDATES.some(ok => nt === ok || nt.includes(ok));
  }

  function getPseudoText(el) {
    let out = '';
    if (!el || typeof W.getComputedStyle !== 'function') return out;
    try {
      const after = W.getComputedStyle(el, '::after').content;
      if (after && after !== 'none') out += ' ' + after;
    } catch (e) {}
    try {
      const before = W.getComputedStyle(el, '::before').content;
      if (before && before !== 'none') out += ' ' + before;
    } catch (e) {}
    return normalizeText(out);
  }

  function getOkText(el) {
    if (!el) return '';
    const tc = normalizeText(el.textContent);
    const it = typeof el.innerText !== 'undefined' ? normalizeText(el.innerText) : tc;
    const val = el.getAttribute ? normalizeText(el.getAttribute('value')) : '';
    const pseudo = getPseudoText(el);
    return it || tc || val || pseudo;
  }

  function elementMatchesOk(el) {
    if (!el) return false;
    if (textMatchesOk(el.textContent)) return true;
    if (textMatchesOk(el.innerText)) return true;
    if (el.getAttribute && textMatchesOk(el.getAttribute('value'))) return true;
    if (textMatchesOk(getPseudoText(el))) return true;
    return false;
  }

  function okButtonScore(el) {
    let score = 0;
    if (!el) return score;
    if (el.tagName === 'BUTTON') score += 30;
    else if (el.tagName === 'INPUT' && /button|submit/i.test(el.type || '')) score += 28;
    else if (el.getAttribute && el.getAttribute('role') === 'button') score += 25;
    else {
      const cls = (el.className || '').toString().toLowerCase();
      if (cls.indexOf('ant-btn') !== -1) score += 20;
      else if (cls.indexOf('btn') !== -1) score += 15;
      else if (typeof el.onclick === 'function') score += 10;
    }
    if (isVisible(el)) score += 5;
    const okTxt = getOkText(el);
    if (CONFIG.OK_CANDIDATES.some(ok => okTxt === ok)) score += 3;
    return score;
  }

  function findOkButtonInPopup(popupEl) {
    if (!popupEl) return null;
    const okSelectors = 'button, input[type="button"], input[type="submit"], a, [role="button"], .ant-btn, .ant-btn-primary, [class*="ant-btn"], [class*="confirm-btns"], [class*="modal-footer"]'
    // 1. 在弹窗自身内部找真正的按钮 / 链接 / role=button / Ant Design 的 .ant-btn
    let btns = popupEl.querySelectorAll(okSelectors);
    for (const btn of btns) {
      if (elementMatchesOk(btn)) return btn;
    }
    // 2. 退而求其次：弹窗内任何文本匹配的元素，向上找可点击祖先
    for (const el of popupEl.querySelectorAll('*')) {
      if (SKIP_TAGS.has(el.tagName)) continue;
      if (elementMatchesOk(el)) return findBestClickable(el);
    }
    // 3. Ant Design 弹窗常见结构：body 和 footer（含按钮）是并列的，按钮可能在兄弟/祖先里
    let ancestor = popupEl.parentElement;
    while (ancestor && ancestor !== W.document.body && ancestor !== W.document.documentElement) {
      btns = ancestor.querySelectorAll(okSelectors);
      for (const btn of btns) {
        if (elementMatchesOk(btn)) return btn;
      }
      ancestor = ancestor.parentElement;
    }
    return null;
  }

  function findPrimaryButtonByClass(popupEl) {
    // 当文本匹配全部失败时，按 Ant Design 类名结构直接找主按钮
    let ancestor = popupEl;
    while (ancestor && ancestor !== W.document.body && ancestor !== W.document.documentElement) {
      const btnsContainer = ancestor.querySelector('.ant-modal-confirm-btns, .ant-confirm-btns, [class*="confirm-btns"]');
      if (btnsContainer) {
        const primary = btnsContainer.querySelector('.ant-btn-primary');
        if (primary && isVisible(primary)) return primary;
        const buttons = btnsContainer.querySelectorAll('button, input, a, .ant-btn');
        for (let i = buttons.length - 1; i >= 0; i--) {
          if (isVisible(buttons[i])) return buttons[i];
        }
      }
      ancestor = ancestor.parentElement;
    }
    // 全局兜底：任意可见的 .ant-btn-primary
    for (const btn of W.document.querySelectorAll('.ant-btn-primary')) {
      if (isVisible(btn)) return btn;
    }
    return null;
  }

  function findAnyOkButton() {
    const doc = W.document;
    if (!doc) return null;
    let best = null;
    let bestScore = -1;
    const candidates = [];
    const okSelectors = 'button, input[type="button"], input[type="submit"], a, [role="button"], .ant-btn, .ant-btn-primary, [class*="ant-btn"], [class*="btn"], [class*="confirm-btns"], [class*="modal-footer"]'
    // 1. 先按明确选择器找
    for (const el of doc.querySelectorAll(okSelectors)) {
      if (!elementMatchesOk(el)) continue;
      const score = okButtonScore(el);
      const t = getOkText(el);
      candidates.push({ text: t.slice(0, 20), tag: el.tagName, cls: (el.className || '').slice(0, 60), score, visible: isVisible(el) });
      if (score > bestScore) { bestScore = score; best = el; }
    }
    // 2. 兜底：遍历所有元素（包括非按钮标签），同时检查 textContent / innerText / value / 伪元素
    if (!best) {
      console.log('[登记助手] 明确选择器未找到确定按钮，开始遍历所有元素...');
      let checked = 0;
      for (const el of doc.querySelectorAll('*')) {
        if (SKIP_TAGS.has(el.tagName)) continue;
        checked++;
        if (!elementMatchesOk(el)) continue;
        const clickable = findBestClickable(el);
        const target = clickable || el;
        let score = okButtonScore(target);
        if (score <= 0) score = 1; // 文本匹配就给最低分，确保能返回
        const t = getOkText(target);
        candidates.push({ text: t.slice(0, 20), tag: target.tagName, cls: (target.className || '').slice(0, 60), score, visible: isVisible(target) });
        if (score > bestScore) { bestScore = score; best = target; }
      }
      console.log('[登记助手] 遍历元素总数:', checked);
    }
    if (candidates.length) {
      candidates.sort((a, b) => b.score - a.score);
      console.log('[登记助手] 全局确定按钮候选（前8）:', candidates.slice(0, 8));
    } else {
      console.log('[登记助手] 全局确定按钮候选：无（页面中没有任何元素文本匹配 OK 候选词）');
    }
    return best;
  }

  function containsExpiredText(el) {
    if (!el) return false;
    const tc = (el.textContent || '').replace(/\s+/g, ' ');
    const it = typeof el.innerText !== 'undefined' ? (el.innerText || '').replace(/\s+/g, ' ') : tc;
    return CONFIG.EXPIRED_CANDIDATES.some(k => tc.includes(k) || it.includes(k));
  }

  function findExpiredPopup() {
    const doc = W.document;
    if (!doc) return null;
    const candidates = [];
    const selectors = [
      '.ant-modal-wrap', '.ant-modal-content', '.ant-modal-confirm', '.ant-modal-confirm-confirm',
      '.ant-modal-confirm-body-wrapper', '.ant-modal-confirm-body', '.ant-modal-confirm-btns',
      '.ant-modal-body', '[class*="modal"]', '[class*="dialog"]', '[class*="popup"]',
      '[role="dialog"]', '[role="alertdialog"]'
    ];
    const seen = new Set();
    for (const sel of selectors) {
      for (const el of doc.querySelectorAll(sel)) {
        if (seen.has(el)) continue;
        seen.add(el);
        if (containsExpiredText(el)) candidates.push(el);
      }
    }
    if (!candidates.length) {
      for (const el of doc.querySelectorAll('*')) {
        if (SKIP_TAGS.has(el.tagName)) continue;
        if (el.children.length > 10) continue;
        if (containsExpiredText(el)) candidates.push(el);
      }
    }
    if (!candidates.length) return null;
    // 优先选择：既包含过期文案、又包含确定按钮的元素（避免只选中 .ant-modal-body 而按钮在 footer 里）
    candidates.sort((a, b) => {
      const aHasOk = !!findOkButtonInPopup(a);
      const bHasOk = !!findOkButtonInPopup(b);
      if (aHasOk && !bHasOk) return -1;
      if (!aHasOk && bHasOk) return 1;
      const ta = (a.textContent || '').length;
      const tb = (b.textContent || '').length;
      return (ta - tb) || (a === b ? 0 : 1);
    });
    return candidates[0];
  }

  function pageContainsAny(keywords) {
    const body = W.document.body;
    if (!body) return false;
    const text = (body.textContent || '').replace(/\s+/g, ' ');
    return keywords.some(k => text.includes(k));
  }

  function isOnHomePage() {
    return pageContainsAny(CONFIG.HOME_PAGE_INDICATORS);
  }

  function isOnUnwantedPage() {
    return pageContainsAny(CONFIG.UNWANTED_PAGE_INDICATORS);
  }

  function runAfterDOM() {
    let startTime = Date.now();
    let loginDone = false;
    let homeDone = false;
    let scheduled = false;
    let timer = null;
    let stopped = false;
    let phase = 'active'; // 'active' 前 30s 主动点登录/首页；'watch' 之后只监听过期弹窗
    let lastMutationTime = Date.now();
    let expiredPopupInstance = null;
    const STABLE_MS = 300; // DOM 稳定 300ms 即可点首页（原 800ms，过慢；300ms 已足够避免初始化硬点）

    function shouldJumpToLogin() {
      // 用户已明确选择"跳出去"，默认跳转；只有显式加 ?nojump 才原地重登
      return !W.location.search.includes(CONFIG.NO_JUMP_TO_LOGIN_FLAG);
    }

    function tryLogin() {
      if (loginDone || W.location.search.includes(CONFIG.DISABLE_LOGIN_FLAG)) return;
      if (Date.now() - startTime > CONFIG.AUTO_WINDOW_MS) return;
      const btn = findClickableByText((t) => CONFIG.LOGIN_CANDIDATES.includes(t), '登录');
      if (btn) {
        console.log('[登记助手] 自动点击登录:', btn.tagName, (btn.className||'').slice(0,60), JSON.stringify(btn.textContent.trim()));
        loginDone = true;
        btn.click();
        console.log('[登记助手] 登录按钮 click() 已调用');
        schedule(); // 登录后立即唤醒首页尝试（不等 MutationObserver 自然触发）
      }
    }

    function tryHome() {
      if (homeDone || W.location.search.includes(CONFIG.DISABLE_HOME_FLAG)) return;
      if (Date.now() - startTime > CONFIG.AUTO_WINDOW_MS) {
        console.log('[登记助手] 超时未找到首页导航，停止');
        return;
      }
      // 已经在首页了：无需点击，直接标记完成
      if (isOnHomePage()) {
        console.log('[登记助手] 当前已在首页，跳过自动点击');
        homeDone = true;
        return;
      }
      // 如果当前页面连"在线填报/我的作品"都不是，说明还在加载中，先别点
      if (!isOnUnwantedPage()) {
        console.log('[登记助手] 当前不在目标跳转页，暂不点首页');
        return;
      }
      // 等 DOM 稳定，避免页面初始化时硬点导致异常重载
      if (Date.now() - lastMutationTime < STABLE_MS) {
        console.log('[登记助手] DOM 未稳定，暂不点首页');
        return;
      }
      for (const name of CONFIG.HOME_CANDIDATES) {
        const link = findClickableByText((t) => t === name || (t.includes(name) && t.length <= name.length + 4), '首页');
        if (link) {
          console.log('[登记助手] 已点击导航:', name, link.tagName, (link.className||'').slice(0,60));
          homeDone = true;
          link.click();
          return;
        }
      }
    }

    function clearExpiredPopupInstanceIfGone() {
      if (expiredPopupInstance && !W.document.contains(expiredPopupInstance)) {
        expiredPopupInstance = null;
      }
    }

    function tryExpirePopup() {
      clearExpiredPopupInstanceIfGone();
      const popup = findExpiredPopup();
      if (!popup) return;
      if (popup === expiredPopupInstance) return;

      console.log('[登记助手] 发现登录过期弹窗，弹窗元素:', popup.tagName, (popup.className || '').slice(0, 80));

      let okBtn = findOkButtonInPopup(popup);
      let searchScope = '弹窗内';
      if (!okBtn) {
        console.log('[登记助手] 弹窗内/祖先链未找到确定按钮，尝试全局搜索...');
        okBtn = findAnyOkButton();
        searchScope = '全局';
      }
      if (!okBtn) {
        console.log('[登记助手] 文本匹配全部失败，尝试按 Ant Design 类名直接找主按钮...');
        okBtn = findPrimaryButtonByClass(popup);
        searchScope = '类名兜底';
      }
      if (!okBtn) {
        console.log('[登记助手] 仍未找到确定按钮。弹窗HTML（前600字符）:', popup.outerHTML ? popup.outerHTML.slice(0, 600) : 'N/A');
        // 调试：列出所有文本里带"确"字的元素（不管是不是按钮）
        const ques = [];
        for (const el of W.document.querySelectorAll('*')) {
          if (SKIP_TAGS.has(el.tagName)) continue;
          const t = getOkText(el);
          if (t.indexOf('确') !== -1) {
            ques.push({ tag: el.tagName, cls: (el.className || '').slice(0, 60), text: t.slice(0, 40), value: el.getAttribute ? el.getAttribute('value') : null });
          }
        }
        console.log('[登记助手] 调试：文本含"确"字的元素（前20）:', ques.slice(0, 20));
        return;
      }

      const btnText = getOkText(okBtn);
      console.log('[登记助手] 发现登录过期弹窗，' + searchScope + '找到确定按钮:', okBtn.tagName, (okBtn.className || '').slice(0, 80), JSON.stringify(btnText), 'visible=', isVisible(okBtn), 'tc=', JSON.stringify(normalizeText(okBtn.textContent)), 'it=', JSON.stringify(normalizeText(okBtn.innerText)), 'value=', JSON.stringify(okBtn.getAttribute ? okBtn.getAttribute('value') : null), 'pseudo=', JSON.stringify(getPseudoText(okBtn)));

      try {
        okBtn.click();
        console.log('[登记助手] 确定按钮 click() 已调用');
        // React/Vue 某些实现只响应合成事件，补发一个 MouseEvent
        const ev = new W.MouseEvent('click', { bubbles: true, cancelable: true, view: W });
        okBtn.dispatchEvent(ev);
        console.log('[登记助手] 确定按钮 dispatchEvent(click) 已调用');
      } catch (e) {
        console.log('[登记助手] 点击确定按钮异常:', e && e.message ? e.message : e);
      }
      expiredPopupInstance = popup;

      if (shouldJumpToLogin()) {
        const jumpUrl = W.location.origin + CONFIG.LOGIN_PATH;
        console.log('[登记助手] 已选择“过期后跳转登录页”，正在跳转:', jumpUrl);
        W.setTimeout(function () { W.location.href = jumpUrl; }, 500);
        return;
      }

      console.log('[登记助手] 已选择“过期后不跳转”，重置登录/首页状态并重新尝试');
      loginDone = false;
      homeDone = false;
      phase = 'active';
      // 重新给 30 秒主动窗口
      startTime = Date.now();
      lastMutationTime = Date.now();
      schedule();
      W.setTimeout(function () { tryLogin(); }, 800);
    }

    // 关键改动 v17.2：扫描改为节流，最多每 300ms 跑一次，
    // 不再因 SPA 加载期大量 DOM 变动而频繁全页扫描拖慢加载。
    // v17.6：过期弹窗改为持久监听，防止 30 秒后出现弹窗没人点。
    function tick() {
      if (stopped) return;
      tryExpirePopup();
      if (phase === 'active') {
        tryLogin();
        tryHome();
        // 超过主动窗口后进入持久弹窗监听，降低频率
        if (Date.now() - startTime > CONFIG.AUTO_WINDOW_MS) {
          phase = 'watch';
          console.log('[登记助手] 进入持久弹窗监听模式（每 1 秒检测一次过期弹窗）');
          if (timer) {
            W.clearInterval(timer);
            timer = W.setInterval(schedule, 1000);
          }
        }
      }
    }

    function schedule() {
      if (scheduled || stopped) return;
      scheduled = true;
      const delay = phase === 'active' ? 150 : 1000;
      W.setTimeout(function () { scheduled = false; tick(); }, delay);
    }

    function stop() {
      stopped = true;
      if (timer) W.clearInterval(timer);
    }

    const root = W.document.getElementById('root') || W.document.body;
    if (root) {
      new W.MutationObserver(function () {
        lastMutationTime = Date.now();
        schedule();
      }).observe(root, { childList: true, subtree: true });
    }
    // 兜底轮询（同样走节流），确保变动静止后仍能触发
    timer = W.setInterval(schedule, 150);
    tick(); // 立即跑一次（不进入 150ms 节流）
    W.setTimeout(stop, 24 * 60 * 60 * 1000); // 24 小时后彻底停止，避免内存泄漏
  }

  // ============================================================
  // 第四阶段：心跳保活（默认开启）
  // 原理：每 HEARTBEAT_INTERVAL_MS 向同域首页发一个带登录凭证的请求，
  // 让服务端认为你"还在操作"，从而持续续期会话（对付"闲置超时"）。
  // 对"绝对超时"（到点必踢，无论动没动）无效，那种只能掉线后自动重登。
  // 默认开启；若想关闭，在网址后加 ?noheartbeat。
  // ============================================================
  (function setupHeartbeat() {
    if (W.location.search.includes(CONFIG.NO_HEARTBEAT_FLAG)) {
      console.log('[登记助手] 已手动关闭心跳（?noheartbeat）');
      return;
    }
    let capturedApiUrl = null;
    let consecutiveFailures = 0;
    const MAX_FAILURES = 999; // 不再因失败停止，持续重试
    let stopped = false;

    function findApiUrl() {
      try {
        const entries = W.performance.getEntriesByType('resource');
        for (let i = entries.length - 1; i >= 0; i--) {
          const u = entries[i].name;
          if (/api/i.test(u) && /^https?:\/\//.test(u)) return u;
        }
      } catch (e) {}
      return null;
    }

    function getHeartbeatUrl() {
      // 优先用同域首页（最可靠保活），其次用抓到的普通 api
      const api = capturedApiUrl || findApiUrl();
      if (api && !/checktoken|checksession|auth/i.test(api)) return api;
      return W.location.origin + '/';
    }

    function heartbeat() {
      if (stopped) return;
      // 登录弹窗出现时不发
      const loginVisible = !!findClickableByText((t) => CONFIG.LOGIN_CANDIDATES.includes(t), '心跳-登录检测');
      if (loginVisible) {
        console.log('[登记助手] 心跳跳过：当前处于登录界面');
        return;
      }
      // 正在输入表单时不发，避免打断
      const active = W.document.activeElement;
      if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) {
        console.log('[登记助手] 心跳跳过：用户正在输入');
        return;
      }
      const url = getHeartbeatUrl();
      // 用 no-cors + 带 cookie，同域访问首页，服务器几乎必然刷新会话活动时间
      W.fetch(url, { method: 'GET', cache: 'no-store', credentials: 'include', mode: 'no-cors' })
        .then(function () {
          consecutiveFailures = 0;
          console.log('[登记助手] 心跳请求已发送（保活）');
        })
        .catch(function (e) {
          consecutiveFailures++;
          console.log('[登记助手] 心跳发送失败:', e.message, '（持续重试中）');
        });
    }

    // 每隔一段时间刷新一次 capturedApiUrl（performance 条目会滚动）
    W.setInterval(function () {
      const u = findApiUrl();
      if (u) capturedApiUrl = u;
    }, 30000);

    console.log('[登记助手] 心跳已启动，间隔', CONFIG.HEARTBEAT_INTERVAL_MS / 1000, '秒');
    W.setInterval(heartbeat, CONFIG.HEARTBEAT_INTERVAL_MS);
    // 首次延迟 30 秒再开始，尽快进入保活
    W.setTimeout(heartbeat, 30000);
  })();

  if (W.document.readyState === 'loading') {
    W.document.addEventListener('DOMContentLoaded', runAfterDOM);
  } else {
    runAfterDOM();
  }
})();
