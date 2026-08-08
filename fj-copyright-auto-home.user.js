// ==UserScript==
// @name         福建省作品自愿登记系统 - 强制PC版+自动登录+直达首页
// @namespace    http://tampermonkey.net/
// @version      18
// @description  v18：在v17.15基础上进一步加固——降低resize屏蔽日志刷屏、阻止站点手动dispatch resize/orientationchange绕过、优化FormKeeper提交后清空逻辑；事件源防火墙屏蔽resize/orientationchange/matchMedia让站点感知不到窗口变小；FormKeeper实时备份表单、首页弹窗恢复；自动登录+自动首页；自动处理"[DID]登录状态已过期"弹窗；过期后默认跳转登录页，加 ?nojump 改为原地重登；心跳默认开启（2分钟一次保活），网址加 ?noheartbeat 可关闭
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

  console.log('[登记助手] v18 已加载，unsafeWindow=', W === window ? 'same' : 'got');

  // ============================================================
  // 第零阶段：把"强制PC版+导航防火墙"注入页面真实上下文
  // ============================================================
  // 原因：v17.9 及之前只在 Tampermonkey 的 unsafeWindow 上改 location/history，
  //       但页面自身脚本跑在真实 window 上下文，可能根本不经过那层包装，
  //       所以缩窗时站点调 location.reload()/href=... 还是生效，表单继续丢。
  // 做法：把一段 <script> 插进页面 DOM，让它在页面真实 window 上跑，
  //       从源头覆盖 innerWidth/Height、matchMedia 和所有导航 API。
  // ============================================================
  function injectIntoPage(fn) {
    const code = '(' + fn.toString() + ')();';
    function tryAppend() {
      if (!document.documentElement) return false;
      const s = document.createElement('script');
      s.textContent = code;
      document.documentElement.appendChild(s);
      if (s.parentNode) s.parentNode.removeChild(s);
      return true;
    }
    if (tryAppend()) return;
    // document-start 时 <html> 可能还没出现，轮询到出现再插（仍早于页面脚本）
    const poll = setInterval(function () {
      if (tryAppend()) clearInterval(poll);
    }, 0);
    // 保险：最多等 1 秒，避免死循环
    setTimeout(function () { clearInterval(poll); }, 1000);
  }

  function pageGuard() {
    (function () {
      'use strict';
      const W = window;
      const D = W.document;
      const FAKE_W = 1920, FAKE_H = 1080;
      function log(m) { console.log('[强制PC版·页内]', m); }
      function stack() { try { return new Error().stack.split('\n').slice(2, 8).join(' | '); } catch (e) { return ''; } }

      // ---------- 1. 强制 PC 尺寸 ----------
      function defineGet(obj, prop, getter) {
        try { Object.defineProperty(obj, prop, { get: getter, configurable: true }); }
        catch (e) {}
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
      if (W.visualViewport) {
        defineGet(W.visualViewport, 'width', () => FAKE_W);
        defineGet(W.visualViewport, 'height', () => FAKE_H);
      }

      // ---------- 2. 事件源防火墙（核心） ----------
      // 站点缩窗时之所以刷新，是因为它在 resize/orientationchange/matchMedia 里写了切换逻辑。
      // Chrome 禁止修改 location，但我们可以在事件源头阻止站点收到"窗口变了"的通知。
      const BLOCKED_EVENTS = ['resize', 'orientationchange'];
      const realAddEventListener = W.addEventListener.bind(W);
      const realRemoveEventListener = W.removeEventListener.bind(W);
      const fakeListeners = {};
      const logCounters = {};
      function logOnce(key, msg) {
        // 降低日志噪音：每类事件最多打印 3 次，避免控制台刷屏
        const n = (logCounters[key] || 0) + 1;
        logCounters[key] = n;
        if (n <= 3) log(msg + (n === 3 ? '（后续同类日志已抑制）' : ''));
      }
      W.addEventListener = function (type, listener, options) {
        if (BLOCKED_EVENTS.indexOf(type) !== -1) {
          logOnce(type, '屏蔽 ' + type + ' 事件监听');
          if (!fakeListeners[type]) fakeListeners[type] = [];
          fakeListeners[type].push({ listener: listener, options: options });
          return;
        }
        return realAddEventListener(type, listener, options);
      };
      W.removeEventListener = function (type, listener, options) {
        if (BLOCKED_EVENTS.indexOf(type) !== -1) {
          const list = fakeListeners[type] || [];
          for (let i = list.length - 1; i >= 0; i--) {
            if (list[i].listener === listener) { list.splice(i, 1); break; }
          }
          return;
        }
        return realRemoveEventListener(type, listener, options);
      };

      // 屏蔽 onresize / onorientationchange：站点直接读取/调用时必须返回函数，
      // 否则像 autoMinWidthOnResize 这类代码调用 window.onresize() 会崩溃。
      const noopFn = function () {};
      ['onresize', 'onorientationchange'].forEach(function (prop) {
        try {
          Object.defineProperty(W, prop, {
            get() { return noopFn; },
            set(v) { logOnce(prop, '屏蔽 ' + prop); },
            configurable: true
          });
        } catch (e) {}
      });

      // 屏蔽 matchMedia 的 addListener / addEventListener
      const fakeMediaQueryList = {
        matches: false, media: '', addListener() {}, removeListener() {},
        addEventListener() {}, removeEventListener() {}, dispatchEvent() { return false; }
      };
      try {
        const realMatchMedia = W.matchMedia.bind(W);
        W.matchMedia = function (q) {
          if (typeof q === 'string' && /max(-device)?-width\s*:\s*\d+px/i.test(q)) {
            logOnce('matchMedia', '屏蔽 matchMedia(' + q + ')');
            return fakeMediaQueryList;
          }
          return realMatchMedia(q);
        };
      } catch (e) {}

      // 阻止站点手动 dispatch resize/orientationchange 事件绕过防火墙
      try {
        const realDispatch = W.EventTarget.prototype.dispatchEvent;
        W.EventTarget.prototype.dispatchEvent = function (event) {
          if (event && BLOCKED_EVENTS.indexOf(event.type) !== -1) {
            logOnce('dispatch:' + event.type, '阻止手动 dispatch ' + event.type);
            return true;
          }
          return realDispatch.call(this, event);
        };
      } catch (e) {}

      // ---------- 3. 拦截键盘刷新 ----------
      W.addEventListener('keydown', function (e) {
        if (e.key === 'F5' || ((e.ctrlKey || e.metaKey) && (e.key === 'r' || e.key === 'R'))) {
          log('拦截键盘刷新');
          e.preventDefault();
          e.stopPropagation();
        }
      }, true);

      // ---------- 4. beforeunload 挽留（仅当有未保存草稿时才弹，避免正常操作打扰） ----------
      const FK_KEY = '__fjCopyrightFormDraft_v17';
      function hasFormDraft() {
        try {
          const raw = W.sessionStorage.getItem(FK_KEY);
          if (!raw) return false;
          const draft = JSON.parse(raw);
          if (!draft || !draft.data || !draft.data.length) return false;
          return (Date.now() - draft.savedAt) < 30 * 60 * 1000;
        } catch (e) { return false; }
      }
      W.addEventListener('beforeunload', function (e) {
        if (!hasFormDraft()) return;
        log('beforeunload 触发，有未保存草稿，尝试挽留 @ ' + stack());
        e.preventDefault();
        e.returnValue = '页面即将刷新/跳转，表单数据可能丢失。确定要离开吗？';
        return e.returnValue;
      });

      // ---------- 5. click / submit 拦截 /h5/ 和自刷新 ----------
      const BLOCK = '/h5';
      function isSelfNav(u) {
        try {
          const cur = W.location.origin + W.location.pathname + W.location.search;
          let target;
          if (u === '' || u == null) target = cur;
          else { const a = D.createElement('a'); a.href = u; target = a.origin + a.pathname + a.search; }
          return target === cur;
        } catch (e) { return false; }
      }
      function blocked(u) {
        if (typeof u !== 'string') return false;
        const s = u.toLowerCase();
        return s.indexOf(BLOCK) !== -1 || isSelfNav(u);
      }
      D.addEventListener('click', function (e) {
        const a = e.target && e.target.closest ? e.target.closest('a') : null;
        if (a) {
          const h = a.getAttribute ? a.getAttribute('href') : '';
          if (blocked(h)) { log('拦截 a 跳转 -> ' + h); e.preventDefault(); e.stopPropagation(); }
        }
      }, true);
      D.addEventListener('submit', function (e) {
        const action = e.target.getAttribute('action') || W.location.href;
        if (blocked(action)) { log('拦截 form submit -> ' + action); e.preventDefault(); e.stopPropagation(); }
      }, true);

      // ---------- 6. history.pushState/replaceState 拦 /h5/ ----------
      ['pushState', 'replaceState'].forEach(function (fn) {
        try {
          const orig = W.history[fn];
          W.history[fn] = function (state, title, url) {
            if (typeof url === 'string' && url.toLowerCase().indexOf(BLOCK) !== -1) {
              log('拦截 history.' + fn + ' -> ' + url); return;
            }
            return orig.apply(this, arguments);
          };
        } catch (e) {}
      });

      // ---------- 7. 移除 meta refresh ----------
      function killMetaRefresh() {
        D.querySelectorAll('meta[http-equiv="refresh"]').forEach(function (m) { log('移除 meta refresh'); m.remove(); });
      }
      if (D.readyState !== 'loading') killMetaRefresh();
      else D.addEventListener('DOMContentLoaded', killMetaRefresh);

      // ---------- 8. 注入 CSS 强制 min-width ----------
      function injectCSS() {
        try {
          const style = D.createElement('style');
          style.textContent = 'html, body { min-width: 1920px !important; overflow-x: auto !important; }';
          if (D.head) D.head.appendChild(style);
          else if (D.documentElement) D.documentElement.appendChild(style);
        } catch (e) {}
      }
      if (D.readyState !== 'loading') injectCSS();
      else D.addEventListener('DOMContentLoaded', injectCSS);

      // ---------- 9. H5 检测拉回 ----------
      function isOnH5() { try { return W.location.pathname.indexOf('/h5/') === 0; } catch (e) { return false; } }
      function pullBackFromH5() {
        if (isOnH5()) {
          log('检测到 H5 URL，自动拉回 /indexPage');
          try { W.location.replace('/indexPage'); } catch (e) {}
        }
      }
      W.setInterval(pullBackFromH5, 1000);

      W.__fjCopyrightGuardInjected = 'v18';
      log('v18 事件源防火墙已注入（屏蔽 resize/orientationchange/matchMedia/dispatchEvent）');
    })();
  }

  injectIntoPage(pageGuard);

  // ============================================================
  // 阶段 0.5：FormKeeper 表单保险柜
  // 原因：Chrome 对 Location 对象保护极严，某些整页重载可能终究无法
  //       100% 阻止。与其让用户丢数据，不如把填写的表单实时备份到
  //       sessionStorage，刷新/被踢回首页后再回到原页面时自动回填。
  // 触发保存：input / change / blur（节流 300ms）。
  // 自动恢复：DOM 稳定后，如果当前页与保存的 path 一致则回填。
  // 自动清除：检测到提交成功（按钮文案含"提交"/"保存"/"确定"且页面跳转/弹成功）。
  // ============================================================
  const FormKeeper = (function () {
      const KEY = '__fjCopyrightFormDraft_v17';
      const MAX_AGE_MS = 30 * 60 * 1000; // 30 分钟过期
      const SUBMITTED_FLAG = '__fjCopyrightSubmitted_v17';
      let saveTimer = null;
      const restoredPaths = new Set(); // 按 path 记录已恢复过的页面，避免重复恢复

    function currentPath() { return W.location.pathname + W.location.search; }

    function isEditablePage() {
      // 只在登记/填报相关页面保存，避免在登录页/首页乱存
      const p = W.location.pathname.toLowerCase();
      return /(register|apply|edit|fill|work|copyright|登记|填报|作品)/i.test(p);
    }

    function hasFormDraft() {
      try {
        const raw = W.sessionStorage.getItem(KEY);
        if (!raw) return false;
        const draft = JSON.parse(raw);
        if (!draft || !draft.data || !draft.data.length) return false;
        return (Date.now() - draft.savedAt) < MAX_AGE_MS;
      } catch (e) { return false; }
    }

    function getSelector(el) {
      if (el.name) return 'name:' + el.name;
      if (el.id) return 'id:' + el.id;
      return null;
    }

    function gather() {
      const data = [];
      const seen = new Set();
      const inputs = W.document.querySelectorAll('input, textarea, select');
      for (const el of inputs) {
        const sel = getSelector(el);
        if (!sel || seen.has(sel)) continue;
        if (el.type === 'password' || el.name === 'password' || el.type === 'hidden' || el.disabled) continue;
        seen.add(sel);
        let v;
        if (el.type === 'checkbox') v = { t: 'cb', v: el.checked };
        else if (el.type === 'radio') v = { t: 'radio', v: el.checked ? el.value : null };
        else if (el.tagName === 'SELECT' && el.multiple) v = { t: 'select-m', v: Array.from(el.selectedOptions).map(o => o.value) };
        else v = { t: 'text', v: el.value };
        data.push({ sel, tag: el.tagName, type: el.type || '', v });
      }
      return { path: currentPath(), savedAt: Date.now(), url: W.location.href, data };
    }

    function save(force) {
      try {
        if (!force && !isEditablePage()) return;
        const draft = gather();
        if (!draft.data.length) return;
        W.sessionStorage.setItem(KEY, JSON.stringify(draft));
      } catch (e) { console.log('[FormKeeper] 保存失败:', e.message); }
    }

    function debouncedSave() {
      if (saveTimer) W.clearTimeout(saveTimer);
      saveTimer = W.setTimeout(save, 300);
    }

    function forceSaveNow() {
      if (saveTimer) W.clearTimeout(saveTimer);
      save(true);
    }

    function restore() {
      const cp = currentPath();
      if (restoredPaths.has(cp)) return false;
      try {
        const raw = W.sessionStorage.getItem(KEY);
        if (!raw) return false;
        const draft = JSON.parse(raw);
        if (!draft || !draft.data) { W.sessionStorage.removeItem(KEY); return false; }
        if (draft.path !== cp) return false;
        if (Date.now() - draft.savedAt > MAX_AGE_MS) { W.sessionStorage.removeItem(KEY); return false; }

        let restoredCount = 0;
        for (const item of draft.data) {
          let el = null;
          if (item.sel.indexOf('name:') === 0) {
            el = W.document.querySelector('[name="' + item.sel.slice(5).replace(/"/g, '\\"') + '"]');
          } else if (item.sel.indexOf('id:') === 0) {
            el = W.document.getElementById(item.sel.slice(3));
          }
          if (!el) continue;
          try {
            if (item.v.t === 'cb') el.checked = item.v.v;
            else if (item.v.t === 'radio') {
              if (item.v.v != null) {
                const r = W.document.querySelector('[name="' + (item.sel.slice(5).replace(/"/g, '\\"')) + '"][value="' + String(item.v.v).replace(/"/g, '\\"') + '"]');
                if (r) r.checked = true;
              }
            }
            else if (item.v.t === 'select-m') {
              Array.from(el.options).forEach(o => o.selected = item.v.v.includes(o.value));
            }
            else {
              el.value = item.v.v;
              // 触发 React/Vue 绑定的输入事件，让组件状态同步
              const ev1 = new W.Event('input', { bubbles: true });
              const ev2 = new W.Event('change', { bubbles: true });
              el.dispatchEvent(ev1);
              el.dispatchEvent(ev2);
            }
            restoredCount++;
          } catch (e) {}
        }
        restoredPaths.add(cp);
        console.log('[FormKeeper] 已自动恢复 ' + restoredCount + '/' + draft.data.length + ' 个字段');
        // 恢复成功后，如果首页有“恢复刚才的登记”浮动按钮，移除它
        const oldBtn = W.document.getElementById('__fjRestoreBtn');
        if (oldBtn) oldBtn.remove();
        return restoredCount > 0;
      } catch (e) {
        console.log('[FormKeeper] 恢复失败:', e.message);
        return false;
      }
    }

    function isHomePage() {
      const p = W.location.pathname.toLowerCase();
      if (p === '/' || p === '/indexpage' || p === '/index' || p === '/home') return true;
      const bodyText = (W.document.body && W.document.body.textContent || '').replace(/\s+/g, ' ');
      return /首页|工作台|快捷菜单|作品总数|待审核作品/.test(bodyText) && !/(在线填报|作品登记|在线登记)/.test(bodyText);
    }

    function offerRestoreIfHome() {
      if (!isHomePage()) return;
      try {
        const raw = W.sessionStorage.getItem(KEY);
        if (!raw) return;
        const draft = JSON.parse(raw);
        if (!draft || !draft.data || !draft.data.length) return;
        if (Date.now() - draft.savedAt > MAX_AGE_MS) { clear(); return; }
        if (draft.path === currentPath()) return; // 已经在目标页
        if (W.document.getElementById('__fjRestoreBtn')) return;

        const container = W.document.createElement('div');
        container.id = '__fjRestoreBtn';
        container.style.cssText = 'position:fixed;z-index:99999;left:50%;top:50%;transform:translate(-50%,-50%);background:#fff;border:2px solid #1677ff;border-radius:12px;padding:24px;box-shadow:0 8px 32px rgba(0,0,0,.2);font-family:sans-serif;max-width:360px;text-align:center;';
        const title = W.document.createElement('div');
        title.textContent = '检测到未完成的登记草稿';
        title.style.cssText = 'font-size:18px;font-weight:bold;color:#1677ff;margin-bottom:12px;';
        const desc = W.document.createElement('div');
        desc.textContent = '刚才填写的内容已自动保存（' + draft.data.length + ' 项）。是否回到原页面继续填写？';
        desc.style.cssText = 'font-size:14px;color:#333;margin-bottom:20px;line-height:1.6;';
        const btnRow = W.document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:12px;justify-content:center;';
        const okBtn = W.document.createElement('button');
        okBtn.textContent = '继续填写';
        okBtn.style.cssText = 'padding:10px 20px;background:#1677ff;color:#fff;border:none;border-radius:6px;cursor:pointer;font-size:14px;';
        okBtn.onclick = function () {
          W.sessionStorage.setItem('__fjCopyrightRestorePending', '1');
          W.location.href = draft.url;
        };
        const cancelBtn = W.document.createElement('button');
        cancelBtn.textContent = '丢弃草稿';
        cancelBtn.style.cssText = 'padding:10px 20px;background:#f0f0f0;color:#555;border:none;border-radius:6px;cursor:pointer;font-size:14px;';
        cancelBtn.onclick = function () { clear(); container.remove(); };
        btnRow.appendChild(okBtn);
        btnRow.appendChild(cancelBtn);
        container.appendChild(title);
        container.appendChild(desc);
        container.appendChild(btnRow);

        // 加一个遮罩，确保用户一定看得到
        const mask = W.document.createElement('div');
        mask.id = '__fjRestoreMask';
        mask.style.cssText = 'position:fixed;z-index:99998;left:0;top:0;right:0;bottom:0;background:rgba(0,0,0,.45);';

        if (W.document.body) {
          W.document.body.appendChild(mask);
          W.document.body.appendChild(container);
        }
        console.log('[FormKeeper] 在首页显示恢复弹窗:', draft.url);
      } catch (e) {}
    }

    function clear() {
      try {
        W.sessionStorage.removeItem(KEY);
        restoredPaths.clear();
        const btn = W.document.getElementById('__fjRestoreBtn');
        const mask = W.document.getElementById('__fjRestoreMask');
        if (btn) btn.remove();
        if (mask) mask.remove();
      } catch (e) {}
    }

    function watchInputs() {
      if (!W.document.body) return;
      // 监听输入事件（节流保存）
      W.document.body.addEventListener('input', debouncedSave, true);
      W.document.body.addEventListener('change', debouncedSave, true);
      W.document.body.addEventListener('blur', debouncedSave, true);
      // 页面隐藏前强制保存
      W.document.addEventListener('visibilitychange', function () {
        if (W.document.visibilityState === 'hidden') forceSaveNow();
      });
      // 监听提交成功：点提交/保存类按钮后，把草稿标记为"已提交待确认"，
      // 后续检测到成功提示、页面离开或一段时间无错误则清空。
      W.document.body.addEventListener('click', function (e) {
        const el = e.target;
        if (!el || el.nodeType !== 1) return;
        const t = (el.textContent || el.innerText || el.value || '').replace(/\s+/g, '');
        if (/提交|保存|确定|立即提交|确认提交|保存草稿/i.test(t)) {
          forceSaveNow();
          // 标记"已提交"，并把当前草稿也保存一份副本作为比对基线
          try { W.sessionStorage.setItem(SUBMITTED_FLAG, JSON.stringify({ path: currentPath(), time: Date.now() })); } catch (e) {}
          // 3 秒后如果还在本页且没有错误提示/成功提示未触发清空，兜底清空
          W.setTimeout(checkSubmitResult, 3000);
          // 10 秒后再检查一次（给 SPA 跳转/弹窗留足时间）
          W.setTimeout(checkSubmitResult, 10000);
        }
      }, true);

      // 在页面中扫描"成功"提示：保存成功、提交成功、操作成功等
      function detectSuccess() {
        if (!W.document.body) return false;
        const bodyText = (W.document.body.textContent || '').replace(/\s+/g, ' ');
        return /保存成功|提交成功|操作成功|保存草稿成功|提交申请成功|数据已保存/.test(bodyText);
      }
      function detectError() {
        if (!W.document.body) return false;
        const bodyText = (W.document.body.textContent || '').replace(/\s+/g, ' ');
        return /失败|错误|异常|请重试|不能为空|校验未通过|提交失败|保存失败/.test(bodyText);
      }
      function checkSubmitResult() {
        try {
          const submitted = W.sessionStorage.getItem(SUBMITTED_FLAG);
          if (!submitted) return;
          const info = JSON.parse(submitted);
          if (info.path !== currentPath()) {
            // 页面已离开原填报页，认为提交流程已结束，清空草稿
            clear();
            return;
          }
          if (detectSuccess()) {
            console.log('[FormKeeper] 检测到成功提示，清空草稿');
            clear();
            return;
          }
          // 兜底：提交 10 秒后无错误也清空（如果还在原页，可能是保存草稿在原页，也可清）
          if (Date.now() - info.time > 9000 && !detectError()) {
            console.log('[FormKeeper] 提交后无错误提示，清空草稿（兜底）');
            clear();
          }
        } catch (e) {}
      }
    }

    function init() {
      if (!W.sessionStorage) return;
      function onReady() {
        watchInputs();
        restore();
        offerRestoreIfHome();
      }
      if (W.document.readyState === 'loading') {
        W.document.addEventListener('DOMContentLoaded', onReady);
      } else {
        onReady();
      }
      // beforeunload 时强制同步保存（关键：确保最后一刻数据不丢）
      W.addEventListener('beforeunload', function () {
        forceSaveNow();
        // 如果之前点了提交按钮且页面现在要离开了，清空草稿避免旧数据复活
        try {
          const submitted = W.sessionStorage.getItem(SUBMITTED_FLAG);
          if (submitted) {
            const info = JSON.parse(submitted);
            if (info.path && info.path !== currentPath()) clear();
          }
        } catch (e) {}
      });
      // 页面可见性变化：切走前保存；切回后检查是否提交成功
      W.document.addEventListener('visibilitychange', function () {
        if (W.document.visibilityState === 'hidden') forceSaveNow();
        else if (W.document.visibilityState === 'visible') {
          checkSubmitResult();
        }
      });
      // 每 5 秒再尝试恢复一次（应对 SPA 异步渲染），但按 path 去重
      W.setInterval(function () { restore(); }, 5000);
      // 每 3 秒检查一次是否在首页且有可恢复草稿
      W.setInterval(offerRestoreIfHome, 3000);
      // URL 变化监听（hashchange/popstate）
      W.addEventListener('hashchange', function () {
        W.setTimeout(function () { restore(); offerRestoreIfHome(); checkSubmitResult(); }, 0);
      });
      W.addEventListener('popstate', function () {
        W.setTimeout(function () { restore(); offerRestoreIfHome(); checkSubmitResult(); }, 0);
      });
    }

    return { init, save, restore, clear, gather };
  })();

  FormKeeper.init();

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

  // ============================================================
  // 第二阶段·补：userscript 层辅助拦截
  // 说明：Chrome 对 location 对象保护极严，直接修改 location.reload / href / assign / replace
  //       都会报"Cannot assign to read only property"而失败。这部分只保留不会报错的事件拦截：
  //       - a 标签点击跳 /h5/ 或自刷新
  //       - history.go(0)
  //       真正的缩窗刷新源头已在 pageGuard 里用"事件源防火墙"处理（屏蔽 resize/orientationchange/matchMedia）。
  // ============================================================
  (function setupNavGuard() {
    const BLOCK = '/h5';
    function isSelfNav(u) {
      try {
        const cur = W.location.origin + W.location.pathname + W.location.search;
        let target;
        if (u === '' || u == null) target = cur;
        else {
          const a = W.document.createElement('a'); a.href = u;
          target = a.origin + a.pathname + a.search;
        }
        return target === cur;
      } catch (e) { return false; }
    }
    function blocked(u) {
      if (typeof u !== 'string') return false;
      const s = u.toLowerCase();
      return s.indexOf(BLOCK) !== -1 || isSelfNav(u);
    }
    // history.go(0) 拦截
    try {
      const og = W.history.go.bind(W.history);
      W.history.go = function (n) { if (n === 0 || n == null) { console.log('[强制PC版] 拦截 history.go(0) 刷新'); return; } return og(n); };
    } catch (e) { console.log('[强制PC版] history.go 拦截失败:', e.message); }
    // a 标签点击跳转
    function onDoc() {
      try {
        W.document.addEventListener('click', function (e) {
          const t = e.target;
          const a = (t && t.closest) ? t.closest('a') : null;
          if (a) {
            const h = a.getAttribute ? a.getAttribute('href') : '';
            if (blocked(h)) { e.preventDefault(); e.stopPropagation(); console.log('[强制PC版] 拦截 a 跳转 ->', h); }
          }
        }, true);
      } catch (e) { console.log('[强制PC版] a 标签拦截失败:', e.message); }
    }
    if (W.document && W.document.readyState !== 'loading') onDoc();
    else W.addEventListener('DOMContentLoaded', onDoc);
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
