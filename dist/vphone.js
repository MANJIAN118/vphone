// ═══════════════════════════════════════════════════════════════
// VPhone · 虚拟手机系统 v1.1
// 通用型 · 零配置 · 基于聊天变量持久化
// ═══════════════════════════════════════════════════════════════

(async () => {
  'use strict';

  // ┌─────────────────────────────────────────────┐
  // │  0. 等待环境就绪 & 自动获取配置               │
  // └─────────────────────────────────────────────┘
  const waitFor = (checkFn, timeout = 8000) => new Promise((resolve, reject) => {
    if (checkFn()) return resolve();
    const start = Date.now();
    const iv = setInterval(() => {
      if (checkFn()) { clearInterval(iv); resolve(); }
      else if (Date.now() - start > timeout) { clearInterval(iv); reject(new Error('[VPhone] 环境初始化超时')); }
    }, 200);
  });

  try {
    await waitFor(() =>
      typeof triggerSlash === 'function' &&
      typeof getChatMessages === 'function' &&
      typeof eventOn === 'function' &&
      typeof get_chat_variable === 'function' &&
      typeof set_chat_variable === 'function'
    );
  } catch (e) {
    console.error(e.message);
    return;
  }

  // 自动获取用户名（通过酒馆宏解析）
  let USER_NAME = '我';
  try {
    const resolved = await triggerSlash('/echo {{user}}');
    // /echo 会弹提示但也会返回内容，我们用更安静的方式
  } catch (_) {}
  // 更可靠的方式：从酒馆助手宏获取
  try {
    const nameFromMacro = '{{user}}';
    // 酒馆助手会在脚本执行前替换宏，如果被替换了就用替换后的值
    if (nameFromMacro && nameFromMacro !== '{' + '{user}}') {
      USER_NAME = nameFromMacro;
    }
  } catch (_) {}

  const CONFIG = {
    userName: USER_NAME,
    varKey: 'vphone_data',
    debounce: 1000,
    containerId: 'vphone-root',
    styleId: 'vphone-styles',
  };

  // ┌─────────────────────────────────────────────┐
  // │  1. 工具函数                                  │
  // └─────────────────────────────────────────────┘
  const escapeForST = (str) => {
    if (typeof str !== 'string') return str;
    return str.replace(/(\\+)?([|{}])/g, (m, s, c) => (s || '') + (s || '') + '\\' + c);
  };
  const sanitizeCoT = (text) => {
    if (!text) return '';
    return text.replace(/^[\s\S]*<\/(?:think|thinking)>/i, '').trim();
  };
  const getNow = () => new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
  const genId = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

  // ┌─────────────────────────────────────────────┐
  // │  2. 数据持久化层（聊天变量）                   │
  // └─────────────────────────────────────────────┘
  const Store = {
    _data: { chat: {}, social: { posts: [] }, memo: { notes: [] } },
    _timer: null,
    _dirty: false,

    load() {
      try {
        const raw = get_chat_variable(CONFIG.varKey);
        if (raw && typeof raw === 'object') {
          // get_chat_variable 直接返回对象（如果之前存的是对象）
          this._data.chat   = raw.chat   || {};
          this._data.social = raw.social || { posts: [] };
          this._data.memo   = raw.memo   || { notes: [] };
        } else if (raw && typeof raw === 'string') {
          const p = JSON.parse(raw);
          if (p && typeof p === 'object') {
            this._data.chat   = p.chat   || {};
            this._data.social = p.social || { posts: [] };
            this._data.memo   = p.memo   || { notes: [] };
          }
        }
      } catch (e) {
        console.warn('[VPhone] 数据加载失败，使用空数据:', e);
      }
      return this._data;
    },

    get data() { return this._data; },

    save() {
      this._dirty = true;
      if (this._timer) clearTimeout(this._timer);
      this._timer = setTimeout(() => this._flush(), CONFIG.debounce);
    },

    forceSave() {
      if (this._timer) { clearTimeout(this._timer); this._timer = null; }
      if (this._dirty) this._flush();
    },

    _flush() {
      this._dirty = false;
      try {
        set_chat_variable(CONFIG.varKey, JSON.parse(JSON.stringify(this._data)));
      } catch (e) {
        console.error('[VPhone] 数据保存失败:', e);
        this._dirty = true;
      }
    },
  };

  // ┌─────────────────────────────────────────────┐
  // │  3. 消息解析引擎                              │
  // └─────────────────────────────────────────────┘
  const Parser = {
    extract(rawText) {
      const cleaned = sanitizeCoT(rawText);
      const results = [];
      const re = /<phone_data>([\s\S]*?)<\/phone_data>/gi;
      let m;
      while ((m = re.exec(cleaned)) !== null) {
        const entry = {};
        const fre = /\[(\w+):([\s\S]*?)\]/g;
        let fm;
        while ((fm = fre.exec(m[1])) !== null) {
          entry[fm[1].toLowerCase()] = fm[2].trim();
        }
        if (entry.app) results.push(entry);
      }
      return results;
    },

    dispatch(entries) {
      let changed = false;
      const d = Store.data;
      for (const e of entries) {
        if (e.app === 'chat') {
          const from = e.from || '未知';
          if (!d.chat[from]) d.chat[from] = { messages: [], unread: 0 };
          // 去重检查：防止重新生成/滑动时重复添加
          const lastMsg = d.chat[from].messages[d.chat[from].messages.length - 1];
          if (lastMsg && lastMsg.sender === from && lastMsg.content === (e.msg || '') && lastMsg.time === (e.time || getNow())) {
            continue;
          }
          d.chat[from].messages.push({
            sender: from,
            content: e.msg || '',
            time: e.time || getNow(),
          });
          d.chat[from].unread = (d.chat[from].unread || 0) + 1;
          changed = true;
        } else if (e.app === 'social') {
          // 去重
          const newContent = e.content || '';
          const newPoster = e.poster || '匿名';
          if (d.social.posts.some(p => p.poster === newPoster && p.content === newContent)) {
            continue;
          }
          d.social.posts.unshift({
            id: genId(),
            poster: newPoster,
            content: newContent,
            image: e.image || '',
            time: e.time || getNow(),
            likes: Math.floor(Math.random() * 80) + 3,
            liked: false,
          });
          changed = true;
        }
      }
      if (changed) {
        Store.save();
        eventEmit('vphone:data_changed');
      }
    },
  };

  // ┌─────────────────────────────────────────────┐
  // │  4. 消息监听                                  │
  // └─────────────────────────────────────────────┘
  eventOn(tavern_events.MESSAGE_RECEIVED, (msgId, type) => {
    if (!['normal', 'regenerate', 'swipe'].includes(type)) return;
    try {
      const msgs = getChatMessages(msgId);
      if (!msgs || !msgs.length) return;
      const entries = Parser.extract(msgs[0].message || '');
      if (entries.length) Parser.dispatch(entries);
    } catch (e) {
      console.error('[VPhone] 监听处理出错:', e);
    }
  });

  // ┌─────────────────────────────────────────────┐
  // │  5. DOM注入与UI引擎                           │
  // └─────────────────────────────────────────────┘
  const hostDoc = window.parent.document;

  // 清理旧实例
  const oldC = hostDoc.getElementById(CONFIG.containerId);
  if (oldC) oldC.remove();
  const oldS = hostDoc.getElementById(CONFIG.styleId);
  if (oldS) oldS.remove();

  // ── CSS ──
  const CSS = `
/* ═══ VPhone · 全局重置与变量 ═══ */
#vphone-root {
  all: initial;
  position: fixed;
  bottom: 24px;
  right: 24px;
  z-index: 100000;
  font-family: -apple-system, BlinkMacSystemFont, "SF Pro Text", "Helvetica Neue", Arial, sans-serif;
  font-size: 14px;
  line-height: 1.45;
  color: var(--vp-c-text-1);
  -webkit-font-smoothing: antialiased;
  pointer-events: none;

  --vp-phone-w: 350px;
  --vp-phone-h: 700px;

  --vp-c-bg-1: #f2f2f7;
  --vp-c-bg-2: #ffffff;
  --vp-c-bg-3: #e5e5ea;
  --vp-c-bg-hover: #d1d1d6;
  --vp-c-text-1: #1c1c1e;
  --vp-c-text-2: #636366;
  --vp-c-text-3: #aeaeb2;
  --vp-c-text-inv: #ffffff;
  --vp-c-accent: #007aff;
  --vp-c-accent-h: #005ecb;
  --vp-c-green: #34c759;
  --vp-c-orange: #ff9500;
  --vp-c-red: #ff3b30;
  --vp-c-purple: #af52de;
  --vp-c-teal: #5ac8fa;
  --vp-c-separator: rgba(60,60,67,0.12);

  --vp-r-xs: 6px;
  --vp-r-sm: 10px;
  --vp-r-md: 14px;
  --vp-r-lg: 22px;
  --vp-r-pill: 50px;

  --vp-shadow-soft: 0 2px 8px rgba(0,0,0,0.06);
  --vp-shadow-card: 0 4px 14px rgba(0,0,0,0.08);
  --vp-shadow-phone: 0 20px 60px rgba(0,0,0,0.28), 0 0 0 0.5px rgba(0,0,0,0.08);

  --vp-t-fast: 0.15s ease;
  --vp-t-base: 0.25s ease;
  --vp-t-spring: 0.4s cubic-bezier(0.32, 0.72, 0, 1);

  container-type: inline-size;
}

#vphone-root *, #vphone-root *::before, #vphone-root *::after {
  box-sizing: border-box; margin: 0; padding: 0;
}

/* ═══ Shell ═══ */
.vp-shell {
  pointer-events: auto;
  width: var(--vp-phone-w);
  height: var(--vp-phone-h);
  background: var(--vp-c-bg-1);
  border-radius: 48px;
  border: 3px solid #1a1a1c;
  box-shadow: var(--vp-shadow-phone);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  position: relative;
  transition: transform var(--vp-t-spring), opacity var(--vp-t-spring);
  transform-origin: bottom right;
}
.vp-shell[data-state="hidden"] {
  transform: scale(0.35) translateY(80px);
  opacity: 0;
  pointer-events: none;
}
.vp-shell[data-state="visible"] {
  transform: scale(1) translateY(0);
  opacity: 1;
}

/* ═══ Close ═══ */
.vp-close {
  position: absolute; top: 10px; right: 16px; z-index: 30;
  background: rgba(120,120,128,0.16); border: none; border-radius: 50%;
  width: 26px; height: 26px;
  display: flex; align-items: center; justify-content: center;
  color: var(--vp-c-text-2); font-size: 10px; cursor: pointer;
  transition: background var(--vp-t-fast);
}
.vp-close:hover { background: rgba(120,120,128,0.32); }
.vp-close:active { transform: scale(0.88); }

/* ═══ Notch ═══ */
.vp-notch {
  position: absolute; top: 0; left: 50%; transform: translateX(-50%);
  width: 126px; height: 30px;
  background: #1a1a1c; border-radius: 0 0 20px 20px; z-index: 20;
}
.vp-notch::after {
  content: ''; position: absolute; top: 9px; left: 50%; transform: translateX(-50%);
  width: 11px; height: 11px;
  background: radial-gradient(circle, #3a3a3c 40%, #2c2c2e 100%);
  border-radius: 50%;
}

/* ═══ Status Bar ═══ */
.vp-statusbar {
  display: flex; justify-content: space-between; align-items: center;
  padding: 6px 30px 2px; height: 42px; flex-shrink: 0; z-index: 10;
  font-size: 13px; font-weight: 600; color: var(--vp-c-text-1);
}
.vp-statusbar-icons { display: flex; gap: 5px; font-size: 11px; }

/* ═══ Screen ═══ */
.vp-screen {
  flex: 1; display: flex; flex-direction: column; overflow: hidden; position: relative;
}

/* ═══ Desktop ═══ */
.vp-desktop {
  flex: 1; display: flex; flex-direction: column;
  padding: 24px 18px 0; overflow-y: auto;
}
.vp-desktop-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 22px 8px;
  padding: 8px 0 20px;
}
.vp-appicon {
  display: flex; flex-direction: column; align-items: center; gap: 6px;
  cursor: pointer; position: relative;
  transition: transform var(--vp-t-fast);
  -webkit-tap-highlight-color: transparent;
}
.vp-appicon:hover { transform: scale(1.06); }
.vp-appicon:active { transform: scale(0.90); }

.vp-appicon-img {
  width: 58px; height: 58px; border-radius: 15px;
  display: flex; align-items: center; justify-content: center;
  font-size: 26px; color: var(--vp-c-text-inv);
  box-shadow: var(--vp-shadow-soft);
  position: relative;
}
.vp-appicon-img.c-green  { background: linear-gradient(145deg, #43d160, #28a745); }
.vp-appicon-img.c-blue   { background: linear-gradient(145deg, #5ac8fa, #007aff); }
.vp-appicon-img.c-orange { background: linear-gradient(145deg, #ffb340, #ff9500); }
.vp-appicon-img.c-gray   { background: linear-gradient(145deg, #8e8e93, #636366); }
.vp-appicon-img.c-purple { background: linear-gradient(145deg, #c77dff, #af52de); }
.vp-appicon-img.c-red    { background: linear-gradient(145deg, #ff6b6b, #ff3b30); }

.vp-appicon-name {
  font-size: 11px; color: var(--vp-c-text-1); text-align: center; line-height: 1.15;
}
.vp-badge {
  position: absolute; top: -5px; right: -5px;
  background: var(--vp-c-red); color: var(--vp-c-text-inv);
  font-size: 10px; font-weight: 700; font-style: normal;
  min-width: 19px; height: 19px; border-radius: 10px;
  display: none; align-items: center; justify-content: center;
  padding: 0 5px; line-height: 1;
  border: 2px solid var(--vp-c-bg-1);
}

/* ═══ App View ═══ */
.vp-appview {
  position: absolute; inset: 0;
  display: flex; flex-direction: column;
  background: var(--vp-c-bg-1);
  transition: transform var(--vp-t-spring), opacity var(--vp-t-base);
  transform: translateX(100%);
  opacity: 0;
  z-index: 5;
}
.vp-appview[data-active="true"] {
  transform: translateX(0);
  opacity: 1;
}
.vp-appview-header {
  display: flex; align-items: center; gap: 4px;
  padding: 8px 12px; min-height: 44px; flex-shrink: 0;
  background: var(--vp-c-bg-2);
  border-bottom: 0.5px solid var(--vp-c-separator);
}
.vp-back {
  background: none; border: none; color: var(--vp-c-accent);
  font-size: 18px; cursor: pointer; padding: 4px 6px;
  display: flex; align-items: center;
  transition: opacity var(--vp-t-fast);
}
.vp-back:hover { opacity: 0.55; }
.vp-back:active { opacity: 0.35; }

.vp-appview-title {
  flex: 1; text-align: center;
  font-size: 16px; font-weight: 600; color: var(--vp-c-text-1);
}
.vp-appview-title-spacer { width: 34px; }

.vp-appview-body {
  flex: 1; overflow-y: auto; -webkit-overflow-scrolling: touch;
}

/* ═══ Home Bar ═══ */
.vp-homebar {
  height: 22px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;
}
.vp-homebar-pill {
  width: 110px; height: 4px;
  background: var(--vp-c-text-3); border-radius: 2px; opacity: 0.35;
}

/* ═══ Placeholder ═══ */
.vp-empty {
  display: flex; flex-direction: column; align-items: center; justify-content: center;
  height: 100%; min-height: 200px; gap: 10px; color: var(--vp-c-text-3);
}
.vp-empty i { font-size: 36px; opacity: 0.35; }
.vp-empty p { font-size: 13px; }

/* ═══ Scrollbar ═══ */
#vphone-root ::-webkit-scrollbar { width: 0px; }

/* ═══════════════════════════════════════════ */
/* ═══ Chat APP                           ═══ */
/* ═══════════════════════════════════════════ */

.vp-chat-list { display: flex; flex-direction: column; }

.vp-chat-item {
  display: flex; align-items: center; gap: 12px;
  padding: 12px 16px;
  cursor: pointer;
  transition: background var(--vp-t-fast);
  border-bottom: 0.5px solid var(--vp-c-separator);
  background: var(--vp-c-bg-2);
}
.vp-chat-item:hover { background: var(--vp-c-bg-3); }
.vp-chat-item:active { background: var(--vp-c-bg-hover); }

.vp-chat-avatar {
  width: 48px; height: 48px; border-radius: 50%;
  display: flex; align-items: center; justify-content: center;
  font-size: 20px; flex-shrink: 0;
  background: var(--vp-c-accent);
  color: var(--vp-c-text-inv);
  overflow: hidden;
}
.vp-chat-avatar img { width: 100%; height: 100%; object-fit: cover; }

.vp-chat-info {
  flex: 1; min-width: 0;
  display: flex; flex-direction: column; gap: 3px;
}
.vp-chat-info-top {
  display: flex; justify-content: space-between; align-items: center;
}
.vp-chat-name {
  font-size: 15px; font-weight: 500; color: var(--vp-c-text-1);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vp-chat-time {
  font-size: 11px; color: var(--vp-c-text-3); flex-shrink: 0;
}
.vp-chat-preview {
  font-size: 13px; color: var(--vp-c-text-2);
  overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.vp-chat-item-badge {
  background: var(--vp-c-red); color: var(--vp-c-text-inv);
  font-size: 11px; font-weight: 600;
  min-width: 20px; height: 20px; border-radius: 10px;
  display: flex; align-items: center; justify-content: center;
  padding: 0 5px; flex-shrink: 0;
}

/* ── Chat Room ── */
.vp-chatroom {
  display: flex; flex-direction: column; height: 100%;
  background: var(--vp-c-bg-1);
}
.vp-chatroom-messages {
  flex: 1; overflow-y: auto; padding: 12px 12px 8px;
  display: flex; flex-direction: column; gap: 6px;
  -webkit-overflow-scrolling: touch;
}
.vp-msg-row {
  display: flex; gap: 8px; max-width: 88%;
  animation: vp-msg-in 0.25s ease both;
}
@keyframes vp-msg-in {
  from { opacity: 0; transform: translateY(8px); }
  to { opacity: 1; transform: translateY(0); }
}
.vp-msg-row.is-self {
  align-self: flex-end; flex-direction: row-reverse;
}
.vp-msg-avatar-sm {
  width: 32px; height: 32px; border-radius: 50%; flex-shrink: 0;
  background: var(--vp-c-accent); color: var(--vp-c-text-inv);
  display: flex; align-items: center; justify-content: center;
  font-size: 13px; overflow: hidden;
}
.vp-msg-avatar-sm img { width: 100%; height: 100%; object-fit: cover; }

.vp-msg-bubble {
  padding: 9px 13px; border-radius: 18px;
  font-size: 14px; line-height: 1.45;
  word-break: break-word; position: relative;
}
.vp-msg-row:not(.is-self) .vp-msg-bubble {
  background: var(--vp-c-bg-2); color: var(--vp-c-text-1);
  border-top-left-radius: 6px;
  box-shadow: var(--vp-shadow-soft);
}
.vp-msg-row.is-self .vp-msg-bubble {
  background: var(--vp-c-accent); color: var(--vp-c-text-inv);
  border-top-right-radius: 6px;
}
.vp-msg-time-tip {
  text-align: center; font-size: 11px; color: var(--vp-c-text-3);
  padding: 6px 0 2px;
}

/* ── Input Bar ── */
.vp-chat-inputbar {
  display: flex; align-items: flex-end; gap: 8px;
  padding: 8px 12px 10px;
  background: var(--vp-c-bg-2);
  border-top: 0.5px solid var(--vp-c-separator);
  flex-shrink: 0;
}
.vp-chat-input {
  flex: 1; border: none; outline: none; resize: none;
  background: var(--vp-c-bg-1); color: var(--vp-c-text-1);
  border-radius: var(--vp-r-lg);
  padding: 9px 14px;
  font-size: 14px; font-family: inherit; line-height: 1.4;
  max-height: 88px; min-height: 36px; overflow-y: auto;
}
.vp-chat-input::placeholder { color: var(--vp-c-text-3); }

.vp-chat-send {
  width: 34px; height: 34px; border-radius: 50%;
  background: var(--vp-c-accent); border: none;
  color: var(--vp-c-text-inv); font-size: 14px;
  cursor: pointer; flex-shrink: 0;
  display: flex; align-items: center; justify-content: center;
  transition: background var(--vp-t-fast), transform var(--vp-t-fast);
}
.vp-chat-send:hover { background: var(--vp-c-accent-h); }
.vp-chat-send:active { transform: scale(0.88); }
.vp-chat-send:disabled {
  background: var(--vp-c-bg-3); color: var(--vp-c-text-3);
  cursor: not-allowed; transform: none;
}

/* ═══ New Chat FAB ═══ */
.vp-chat-fab {
  position: absolute; bottom: 16px; right: 16px;
  width: 48px; height: 48px; border-radius: 50%;
  background: var(--vp-c-accent); color: var(--vp-c-text-inv);
  border: none; font-size: 20px; cursor: pointer;
  box-shadow: 0 4px 12px rgba(0,122,255,0.35);
  display: flex; align-items: center; justify-content: center;
  transition: transform var(--vp-t-fast), box-shadow var(--vp-t-fast);
}
.vp-chat-fab:hover { transform: scale(1.08); box-shadow: 0 6px 18px rgba(0,122,255,0.4); }
.vp-chat-fab:active { transform: scale(0.92); }

/* ═══ Dialog ═══ */
.vp-dialog-overlay {
  position: absolute; inset: 0; z-index: 50;
  background: rgba(0,0,0,0.3);
  display: flex; align-items: center; justify-content: center;
  animation: vp-fade-in 0.2s ease;
}
@keyframes vp-fade-in { from { opacity: 0; } to { opacity: 1; } }
.vp-dialog {
  background: var(--vp-c-bg-2); border-radius: var(--vp-r-md);
  padding: 20px; width: 80%; max-width: 260px;
  box-shadow: var(--vp-shadow-card);
  display: flex; flex-direction: column; gap: 14px;
  animation: vp-dialog-pop 0.25s ease both;
}
@keyframes vp-dialog-pop {
  from { transform: scale(0.85); opacity: 0; }
  to { transform: scale(1); opacity: 1; }
}
.vp-dialog h3 {
  font-size: 16px; font-weight: 600; color: var(--vp-c-text-1); text-align: center;
}
.vp-dialog input[type="text"] {
  width: 100%; border: 1px solid var(--vp-c-bg-3);
  border-radius: var(--vp-r-sm); padding: 9px 12px;
  font-size: 14px; font-family: inherit; color: var(--vp-c-text-1);
  background: var(--vp-c-bg-1); outline: none;
  transition: border-color var(--vp-t-fast);
}
.vp-dialog input[type="text"]:focus { border-color: var(--vp-c-accent); }
.vp-dialog input[type="text"]::placeholder { color: var(--vp-c-text-3); }
.vp-dialog-btns { display: flex; gap: 8px; justify-content: flex-end; }
.vp-dialog-btns button {
  padding: 7px 16px; border-radius: var(--vp-r-sm);
  border: none; font-size: 14px; font-family: inherit;
  cursor: pointer; transition: background var(--vp-t-fast), transform var(--vp-t-fast);
}
.vp-dialog-btns button:active { transform: scale(0.95); }
.vp-dialog-btn-cancel { background: var(--vp-c-bg-3); color: var(--vp-c-text-1); }
.vp-dialog-btn-cancel:hover { background: var(--vp-c-bg-hover); }
.vp-dialog-btn-ok { background: var(--vp-c-accent); color: var(--vp-c-text-inv); }
.vp-dialog-btn-ok:hover { background: var(--vp-c-accent-h); }
`;

  // ── HTML ──
  const HTML = `
<div class="vp-shell" data-state="hidden">
  <button class="vp-close" title="收起"><i class="fas fa-chevron-down"></i></button>
  <div class="vp-notch"></div>
  <div class="vp-statusbar">
    <span class="vp-statusbar-time">${getNow()}</span>
    <span class="vp-statusbar-icons">
      <i class="fas fa-signal"></i>
      <i class="fas fa-wifi"></i>
      <i class="fas fa-battery-three-quarters"></i>
    </span>
  </div>
  <div class="vp-screen">
    <div class="vp-desktop">
      <div class="vp-desktop-grid" id="vp-desktop-grid"></div>
    </div>
    <div class="vp-appview" id="vp-appview" data-active="false">
      <div class="vp-appview-header">
        <button class="vp-back" id="vp-back-btn"><i class="fas fa-chevron-left"></i></button>
        <span class="vp-appview-title" id="vp-appview-title"></span>
        <span class="vp-appview-title-spacer"></span>
      </div>
      <div class="vp-appview-body" id="vp-appview-body"></div>
    </div>
  </div>
  <div class="vp-homebar"><div class="vp-homebar-pill"></div></div>
</div>`;

  // ── 注入 ──
  const styleEl = hostDoc.createElement('style');
  styleEl.id = CONFIG.styleId;
  styleEl.textContent = CSS;
  hostDoc.head.appendChild(styleEl);

  const rootEl = hostDoc.createElement('div');
  rootEl.id = CONFIG.containerId;
  rootEl.innerHTML = HTML;
  hostDoc.body.appendChild(rootEl);

  // ┌─────────────────────────────────────────────┐
  // │  6. 路由 & APP注册                            │
  // └─────────────────────────────────────────────┘
  const _$ = (sel, ctx) => (ctx || rootEl).querySelector(sel);
  const _$$ = (sel, ctx) => [...(ctx || rootEl).querySelectorAll(sel)];

  const shell      = _$('.vp-shell');
  const desktop    = _$('.vp-desktop');
  const grid       = _$('#vp-desktop-grid');
  const appview    = _$('#vp-appview');
  const appTitle   = _$('#vp-appview-title');
  const appBody    = _$('#vp-appview-body');
  const backBtn    = _$('#vp-back-btn');
  const closeBtn   = _$('.vp-close');
  const timeEl     = _$('.vp-statusbar-time');

  let currentApp = null;
  const apps = {};

  function registerApp(id, cfg) { apps[id] = cfg; }

  function renderDesktop() {
    grid.innerHTML = '';
    for (const [id, app] of Object.entries(apps)) {
      const el = hostDoc.createElement('div');
      el.className = 'vp-appicon';
      el.innerHTML = `
        <div class="vp-appicon-img ${app.color || 'c-gray'}">
          <i class="fas ${app.icon}"></i>
          <i class="vp-badge" data-badge-for="${id}"></i>
        </div>
        <span class="vp-appicon-name">${app.name}</span>`;
      el.addEventListener('click', () => openApp(id));
      grid.appendChild(el);
    }
    updateBadges();
  }

  function openApp(id) {
    const app = apps[id];
    if (!app) return;
    currentApp = id;
    appTitle.textContent = app.name;
    appBody.innerHTML = '';
    if (typeof app.onOpen === 'function') app.onOpen(appBody, Store.data);
    appview.setAttribute('data-active', 'true');
  }

  function closeApp() {
    appview.setAttribute('data-active', 'false');
    if (currentApp && apps[currentApp] && typeof apps[currentApp].onClose === 'function') {
      apps[currentApp].onClose();
    }
    currentApp = null;
  }

  function refreshApp() {
    if (currentApp && apps[currentApp] && typeof apps[currentApp].onOpen === 'function') {
      appBody.innerHTML = '';
      apps[currentApp].onOpen(appBody, Store.data);
    }
  }

  // 返回按钮的默认行为
  let _backHandler = closeApp;
  backBtn.addEventListener('click', () => _backHandler());

  function setBackHandler(fn) { _backHandler = fn; }
  function resetBackHandler() { _backHandler = closeApp; }

  closeBtn.addEventListener('click', () => {
    shell.setAttribute('data-state', 'hidden');
  });

  setInterval(() => { timeEl.textContent = getNow(); }, 30000);

  function updateBadges() {
    let chatTotal = 0;
    for (const t of Object.values(Store.data.chat)) chatTotal += (t.unread || 0);
    const cBadge = rootEl.querySelector('[data-badge-for="chat"]');
    if (cBadge) {
      if (chatTotal > 0) {
        cBadge.style.display = 'flex';
        cBadge.textContent = chatTotal > 99 ? '99+' : chatTotal;
      } else {
        cBadge.style.display = 'none';
      }
    }
  }

  eventOn('vphone:data_changed', () => {
    updateBadges();
    // 仅在聊天室视图时增量刷新，其他视图全量刷新
    if (currentApp === 'chat' && ChatApp._currentContact) {
      ChatApp._incrementalRefresh();
    } else if (currentApp) {
      refreshApp();
    }
  });

  // ┌─────────────────────────────────────────────┐
  // │  7. 聊天APP                                   │
  // └─────────────────────────────────────────────┘
  const ChatApp = {
    _currentContact: null,
    _sending: false,

    onOpen(container, data) {
      this._currentContact = null;
      resetBackHandler();
      this._renderContactList(container, data);
    },

    onClose() {
      this._currentContact = null;
      resetBackHandler();
    },

    _renderContactList(container, data) {
      const wrapper = hostDoc.createElement('div');
      wrapper.style.cssText = 'position:relative;height:100%;';

      const listEl = hostDoc.createElement('div');
      listEl.className = 'vp-chat-list';

      const contacts = Object.entries(data.chat);
      if (contacts.length === 0) {
        listEl.innerHTML = '<div class="vp-empty"><i class="fas fa-comment-dots"></i><p>暂无聊天记录</p></div>';
      } else {
        contacts
          .sort((a, b) => {
            const la = a[1].messages[a[1].messages.length - 1];
            const lb = b[1].messages[b[1].messages.length - 1];
            return (lb?.time || '').localeCompare(la?.time || '');
          })
          .forEach(([name, thread]) => {
            const last = thread.messages[thread.messages.length - 1];
            const item = hostDoc.createElement('div');
            item.className = 'vp-chat-item';

            const initial = name.charAt(0);
            const seed = encodeURIComponent(name);

            let badgeHtml = '';
            if (thread.unread > 0) {
              badgeHtml = `<span class="vp-chat-item-badge">${thread.unread > 99 ? '99+' : thread.unread}</span>`;
            }

            item.innerHTML = `
              <div class="vp-chat-avatar">
                <img src="https://api.dicebear.com/9.x/thumbs/svg?seed=${seed}" alt="${initial}"
                     onerror="this.style.display='none';this.parentElement.textContent='${initial}'">
              </div>
              <div class="vp-chat-info">
                <div class="vp-chat-info-top">
                  <span class="vp-chat-name">${name}</span>
                  <span class="vp-chat-time">${last?.time || ''}</span>
                </div>
                <span class="vp-chat-preview">${last ? (last.sender === CONFIG.userName ? '我：' : '') + this._escapeHtml(last.content) : ''}</span>
              </div>
              ${badgeHtml}`;

            item.addEventListener('click', () => {
              this._openChatRoom(container, name);
            });
            listEl.appendChild(item);
          });
      }
      wrapper.appendChild(listEl);

      // FAB
      const fab = hostDoc.createElement('button');
      fab.className = 'vp-chat-fab';
      fab.innerHTML = '<i class="fas fa-pen"></i>';
      fab.addEventListener('click', () => this._showNewChatDialog(container));
      wrapper.appendChild(fab);

      container.innerHTML = '';
      container.appendChild(wrapper);
    },

    _openChatRoom(container, contactName) {
      this._currentContact = contactName;
      const data = Store.data;
      const thread = data.chat[contactName];
      if (!thread) return;

      thread.unread = 0;
      Store.save();
      updateBadges();

      appTitle.textContent = contactName;

      const room = hostDoc.createElement('div');
      room.className = 'vp-chatroom';

      const msgArea = hostDoc.createElement('div');
      msgArea.className = 'vp-chatroom-messages';
      msgArea.id = 'vp-chatroom-msgs';

      let lastTime = '';
      thread.messages.forEach((msg) => {
        if (msg.time && msg.time !== lastTime) {
          const tip = hostDoc.createElement('div');
          tip.className = 'vp-msg-time-tip';
          tip.textContent = msg.time;
          msgArea.appendChild(tip);
          lastTime = msg.time;
        }
        msgArea.appendChild(this._createMsgBubble(msg, contactName));
      });

      room.appendChild(msgArea);

      // 输入栏
      const inputBar = hostDoc.createElement('div');
      inputBar.className = 'vp-chat-inputbar';

      const textarea = hostDoc.createElement('textarea');
      textarea.className = 'vp-chat-input';
      textarea.placeholder = '输入消息…';
      textarea.rows = 1;
      textarea.addEventListener('input', function () {
        this.style.height = 'auto';
        this.style.height = Math.min(this.scrollHeight, 88) + 'px';
      });

      const sendBtn = hostDoc.createElement('button');
      sendBtn.className = 'vp-chat-send';
      sendBtn.innerHTML = '<i class="fas fa-arrow-up"></i>';

      const doSend = async () => {
        const text = textarea.value.trim();
        if (!text || this._sending) return;
        this._sending = true;
        sendBtn.disabled = true;

        const time = getNow();
        const myMsg = { sender: CONFIG.userName, content: text, time };
        thread.messages.push(myMsg);
        msgArea.appendChild(this._createMsgBubble(myMsg, contactName));
        textarea.value = '';
        textarea.style.height = 'auto';
        this._scrollToBottom(msgArea);

        Store.save();

        try {
          const safeName = escapeForST(contactName);
          const safeText = escapeForST(text);
          await triggerSlash(`/send [手机-聊天][发给:${safeName}] ${safeText} | /trigger`);
        } catch (e) {
          console.error('[VPhone Chat] 发送失败:', e);
        }

        this._sending = false;
        sendBtn.disabled = false;
      };

      sendBtn.addEventListener('click', doSend);
      textarea.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          doSend();
        }
      });

      inputBar.appendChild(textarea);
      inputBar.appendChild(sendBtn);
      room.appendChild(inputBar);

      // 覆盖返回按钮：回到联系人列表
      setBackHandler(() => {
        appTitle.textContent = '消息';
        this._currentContact = null;
        resetBackHandler();
        container.innerHTML = '';
        this._renderContactList(container, Store.data);
      });

      container.innerHTML = '';
      container.appendChild(room);

      requestAnimationFrame(() => this._scrollToBottom(msgArea));
    },

    _incrementalRefresh() {
      const contact = this._currentContact;
      if (!contact) return;
      const thread = Store.data.chat[contact];
      if (!thread) return;

      const msgArea = rootEl.querySelector('#vp-chatroom-msgs');
      if (!msgArea) return;

      const rendered = msgArea.querySelectorAll('.vp-msg-row').length;

      if (thread.messages.length > rendered) {
        const newMsgs = thread.messages.slice(rendered);
        newMsgs.forEach((msg) => {
          msgArea.appendChild(this._createMsgBubble(msg, contact));
        });
        this._scrollToBottom(msgArea);

        thread.unread = 0;
        Store.save();
        updateBadges();
      }
    },

    _createMsgBubble(msg, contactName) {
      const isSelf = (msg.sender === CONFIG.userName);
      const row = hostDoc.createElement('div');
      row.className = 'vp-msg-row' + (isSelf ? ' is-self' : '');

      const seed = encodeURIComponent(isSelf ? CONFIG.userName : msg.sender);
      const initial = (isSelf ? CONFIG.userName : msg.sender).charAt(0);

      row.innerHTML = `
        <div class="vp-msg-avatar-sm">
          <img src="https://api.dicebear.com/9.x/thumbs/svg?seed=${seed}" alt="${initial}"
               onerror="this.style.display='none';this.parentElement.textContent='${initial}'">
        </div>
        <div class="vp-msg-bubble">${this._escapeHtml(msg.content)}</div>`;
      return row;
    },

    _scrollToBottom(el) {
      requestAnimationFrame(() => { el.scrollTop = el.scrollHeight; });
    },

    _escapeHtml(str) {
      const d = hostDoc.createElement('div');
      d.textContent = str;
      return d.innerHTML;
    },

    _showNewChatDialog(container) {
      const existing = rootEl.querySelector('.vp-dialog-overlay');
      if (existing) existing.remove();

      const overlay = hostDoc.createElement('div');
      overlay.className = 'vp-dialog-overlay';
      overlay.innerHTML = `
        <div class="vp-dialog">
          <h3>新建对话</h3>
          <input type="text" class="vp-dialog-input" placeholder="输入联系人名称…" maxlength="30">
          <div class="vp-dialog-btns">
            <button class="vp-dialog-btn-cancel">取消</button>
            <button class="vp-dialog-btn-ok">确定</button>
          </div>
        </div>`;

      const input = overlay.querySelector('.vp-dialog-input');
      const cancelBtn = overlay.querySelector('.vp-dialog-btn-cancel');
      const okBtn = overlay.querySelector('.vp-dialog-btn-ok');

      const close = () => overlay.remove();
      cancelBtn.addEventListener('click', close);
      overlay.addEventListener('click', (e) => { if (e.target === overlay) close(); });

      okBtn.addEventListener('click', () => {
        const name = input.value.trim();
        if (!name) return;
        if (!Store.data.chat[name]) {
          Store.data.chat[name] = { messages: [], unread: 0 };
          Store.save();
        }
        close();
        this._openChatRoom(container, name);
      });

      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); okBtn.click(); }
      });

      const screen = rootEl.querySelector('.vp-screen');
      screen.appendChild(overlay);
      requestAnimationFrame(() => input.focus());
    },
  };

  // ┌─────────────────────────────────────────────┐
  // │  8. APP注册                                   │
  // └─────────────────────────────────────────────┘
  registerApp('chat', {
    name: '消息',
    icon: 'fa-comment-dots',
    color: 'c-green',
    onOpen: (c, d) => ChatApp.onOpen(c, d),
    onClose: () => ChatApp.onClose(),
  });

  registerApp('social', {
    name: '动态',
    icon: 'fa-globe',
    color: 'c-blue',
    onOpen: (c) => { c.innerHTML = '<div class="vp-empty"><i class="fas fa-globe"></i><p>动态模块即将上线</p></div>'; },
  });

  registerApp('memo', {
    name: '备忘录',
    icon: 'fa-sticky-note',
    color: 'c-orange',
    onOpen: (c) => { c.innerHTML = '<div class="vp-empty"><i class="fas fa-sticky-note"></i><p>备忘录模块即将上线</p></div>'; },
  });

  registerApp('settings', {
    name: '设置',
    icon: 'fa-cog',
    color: 'c-gray',
    onOpen: (c) => { c.innerHTML = '<div class="vp-empty"><i class="fas fa-cog"></i><p>设置（预留）</p></div>'; },
  });

  // ┌─────────────────────────────────────────────┐
  // │  9. 启动                                      │
  // └─────────────────────────────────────────────┘
  Store.load();
  renderDesktop();

  // 按钮注册
  appendInexistentScriptButtons([{ name: '📱 手机', visible: true }]);
  eventOn(getButtonEvent('📱 手机'), () => {
    const s = shell.getAttribute('data-state');
    shell.setAttribute('data-state', s === 'visible' ? 'hidden' : 'visible');
  });

  // 脚本关闭时清理
  $(window).on('pagehide', () => {
    Store.forceSave();
    const c = hostDoc.getElementById(CONFIG.containerId);
    if (c) c.remove();
    const s = hostDoc.getElementById(CONFIG.styleId);
    if (s) s.remove();
  });

  console.log('[VPhone] v1.1 系统启动完毕 ✓ (聊天变量持久化)');
})();
