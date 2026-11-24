window.addEventListener('DOMContentLoaded', async () => {
  'use strict';

  const $ = id => document.getElementById(id);
  const escapeHtml = value => String(value ?? '').replace(/[&<>'"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;' }[c]));
  const STAR = cls => `<svg class="${cls}" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M12 2L13.8 8.2L20 10L13.8 11.8L12 18L10.2 11.8L4 10L10.2 8.2L12 2Z"/></svg>`;
  const DEFAULT_PROMPT = '请保持理智、客观、有洞察力的表达。优先提供准确、有依据的回答，避免无意义的套话。';
  const isMobile = () => matchMedia('(max-width: 767px)').matches;

  // DOMPurify 钩子：强制所有新标签打开，防止跳转导致内存 Key 与对话树丢失
  if (window.DOMPurify) {
    DOMPurify.addHook('afterSanitizeAttributes', node => {
      if (node.tagName === 'A') {
        node.setAttribute('target', '_blank');
        node.setAttribute('rel', 'noopener noreferrer');
      }
    });
  }
  const md = text => DOMPurify.sanitize(marked.parse(text || ''));

  /* ============ 全局状态（纯内存） ============ */
  const state = {
    sessions: [],
    currentSessionId: 's1',
    nextId: 1,
    task: null,
    apiKey: '',
    themeMode: 'system',
    view: 'chat',
    pendingDeleteId: null,
    endpoint: 'https://api.xiaomimimo.com/v1/chat/completions',
    provider: 'mimo',
    preset: 'balanced'
  };

  function id(prefix) { return `${prefix}${Date.now().toString(36)}${(++state.nextId).toString(36)}`; }
  function current() { return state.sessions.find(s => s.id === state.currentSessionId); }
  function createSession(title = '新的对话', systemPrompt = DEFAULT_PROMPT) {
    const root = { id: id('n'), parentId: null, childrenIds: [], selectedChildId: null, role: 'root', content: '', status: 'complete', metadata: {} };
    return { id: id('s'), title, pinned: false, systemPrompt, rootId: root.id, nodes: new Map([[root.id, root]]), draft: '', promptHistory: [], historyCursor: -1, pendingAttachments: [] };
  }

  const initialSession = createSession();
  state.sessions.push(initialSession);
  state.currentSessionId = initialSession.id;


  /* ============ Provider adapters + local persistence ============
     API keys are deliberately excluded from both IndexedDB and localStorage. */
  const PROVIDERS = {
    mimo: { label: 'Xiaomi MiMo', endpoint: 'https://api.xiaomimimo.com/v1/chat/completions', auth: 'api-key', thinking: 'mimo' },
    openrouter: { label: 'OpenRouter', endpoint: 'https://openrouter.ai/api/v1/chat/completions', auth: 'bearer', thinking: 'openrouter' },
    openai: { label: 'OpenAI', endpoint: 'https://api.openai.com/v1/chat/completions', auth: 'bearer', thinking: 'none' },
    deepseek: { label: 'DeepSeek', endpoint: 'https://api.deepseek.com/chat/completions', auth: 'bearer', thinking: 'none' },
    gemini: { label: 'Google Gemini (OpenAI compatible)', endpoint: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions', auth: 'bearer', thinking: 'none' },
    custom: { label: '自定义兼容接口', endpoint: '', auth: 'bearer', thinking: 'none' }
  };
  const DB_NAME = 'mimo-studio';
  const DB_VERSION = 1;
  let dbPromise;
  function openDatabase() {
    if (!('indexedDB' in window)) return Promise.reject(new Error('浏览器不支持 IndexedDB'));
    if (!dbPromise) dbPromise = new Promise((resolve, reject) => {
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      request.onupgradeneeded = () => { if (!request.result.objectStoreNames.contains('workspace')) request.result.createObjectStore('workspace'); };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error('打开本地数据库失败'));
    });
    return dbPromise;
  }
  function sessionToRecord(session) {
    return { ...session, nodes: Array.from(session.nodes.values()) };
  }
  function recordToSession(record) {
    if (!record || typeof record.id !== 'string' || !Array.isArray(record.nodes)) return null;
    const nodes = new Map();
    for (const item of record.nodes) {
      if (!item || typeof item.id !== 'string' || nodes.has(item.id)) return null;
      nodes.set(item.id, { ...item, childrenIds: Array.isArray(item.childrenIds) ? item.childrenIds : [], metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {} });
    }
    if (!nodes.has(record.rootId)) return null;
    for (const item of nodes.values()) {
      if (item.parentId !== null && !nodes.has(item.parentId)) return null;
      if (item.childrenIds.some(childId => !nodes.has(childId))) return null;
      if (item.selectedChildId && !nodes.has(item.selectedChildId)) item.selectedChildId = null;
    }
    return { ...record, nodes, pendingAttachments: Array.isArray(record.pendingAttachments) ? record.pendingAttachments : [], promptHistory: Array.isArray(record.promptHistory) ? record.promptHistory : [] };
  }
  let persistTimer = 0;
  function schedulePersist() {
    clearTimeout(persistTimer);
    persistTimer = setTimeout(async () => {
      try {
        const db = await openDatabase();
        const tx = db.transaction('workspace', 'readwrite');
        tx.objectStore('workspace').put({
          sessions: state.sessions.map(sessionToRecord),
          currentSessionId: state.currentSessionId,
          savedAt: new Date().toISOString()
        }, 'snapshot');
      } catch (error) { console.warn('MiMo Studio 本地保存失败：', error); }
    }, 250);
  }
  async function restoreWorkspace() {
    try {
      const db = await openDatabase();
      const snapshot = await new Promise((resolve, reject) => {
        const request = db.transaction('workspace', 'readonly').objectStore('workspace').get('snapshot');
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      if (snapshot && Array.isArray(snapshot.sessions)) {
        const restored = snapshot.sessions.map(recordToSession).filter(Boolean);
        if (restored.length) {
          state.sessions = restored;
          state.currentSessionId = restored.some(s => s.id === snapshot.currentSessionId) ? snapshot.currentSessionId : restored[0].id;
        }
      }
    } catch (error) { console.warn('无法恢复本地会话，将使用空白工作区：', error); }
    try {
      const prefs = JSON.parse(localStorage.getItem('mimo-studio-preferences') || '{}');
      if (prefs && typeof prefs === 'object') {
        if (PROVIDERS[prefs.provider]) state.provider = prefs.provider;
        if (typeof prefs.endpoint === 'string' && prefs.endpoint) { state.endpoint = prefs.endpoint; $('endpointInput').value = prefs.endpoint; }
        if (typeof prefs.model === 'string') $('customModelInput').value = prefs.model;
        if (typeof prefs.themeMode === 'string') state.themeMode = prefs.themeMode;
        if (typeof prefs.temperature === 'number') $('drawerTempSlider').value = String(Math.max(0, Math.min(1.5, prefs.temperature)));
      }
    } catch (_) {}
  }
  function savePreferences() {
    try {
      localStorage.setItem('mimo-studio-preferences', JSON.stringify({
        provider: state.provider || 'mimo', endpoint: $('endpointInput').value.trim(),
        model: $('customModelInput').value.trim(), themeMode: state.themeMode,
        temperature: Number($('drawerTempSlider').value)
      }));
    } catch (error) { console.warn('偏好设置保存失败：', error); }
  }
  function providerConfig() { return PROVIDERS[state.provider] || PROVIDERS.custom; }
  function applyProvider(provider, preserveEndpoint = false) {
    if (!PROVIDERS[provider]) provider = 'custom';
    state.provider = provider;
    const config = providerConfig();
    if (!preserveEndpoint && config.endpoint) $('endpointInput').value = config.endpoint;
    state.endpoint = $('endpointInput').value.trim() || config.endpoint;
    $('providerSelector').value = provider;
    const isMiMo = provider === 'mimo';
    $('modelSelector').style.display = isMiMo ? '' : 'none';
    $('customModelInput').placeholder = isMiMo ? '自定义模型 ID（可选）' : '请输入该服务商的模型 ID（必填）';
    $('keyHelp').textContent = `${config.label} · 密钥仅保存在当前页面内存，不写入本地数据库或 Git。`;
    $('providerNote').textContent = provider === 'gemini'
      ? '使用 Google 提供的 OpenAI 兼容入口；不是 Gemini 原生 API。'
      : provider === 'custom' ? '自定义地址按 OpenAI Chat Completions 兼容协议处理。' : `认证方式：${config.auth === 'api-key' ? 'api-key' : 'Bearer Token'}。`;
    $('keyStatus').textContent = `已选择 ${config.label}；请确认模型 ID 与 API Key 对应。`;
    savePreferences();
  }

  /* ============ 树状消息结构辅助函数 ============ */
  function node(session, nodeId) { return session?.nodes.get(nodeId); }

  function addNode(session, parentId, role, content = '', extra = {}) {
    const item = {
      id: id('n'),
      parentId,
      childrenIds: [],
      selectedChildId: null,
      role,
      content,
      status: role === 'assistant' ? 'pending' : 'complete',
      metadata: {},
      ...extra
    };
    session.nodes.set(item.id, item);
    const parent = node(session, parentId);
    if (parent) {
      parent.childrenIds.push(item.id);
      parent.selectedChildId = item.id;
    }
    return item;
  }

  function selectedPath(session) {
    const result = [];
    let cursor = node(session, session.rootId);
    while (cursor) {
      let nextId = cursor.selectedChildId;
      if ((!nextId || !node(session, nextId)) && cursor.childrenIds.length > 0) {
        nextId = cursor.childrenIds[cursor.childrenIds.length - 1];
        cursor.selectedChildId = nextId;
      }
      if (!nextId) break;
      cursor = node(session, nextId);
      if (!cursor) break;
      result.push(cursor);
    }
    return result;
  }

  function siblings(session, item) {
    const parent = node(session, item.parentId);
    return parent ? parent.childrenIds.map(cid => node(session, cid)).filter(Boolean).filter(child => child.role === item.role) : [];
  }

  function branchInfo(session, item) {
    const alternatives = siblings(session, item);
    return {
      index: Math.max(0, alternatives.findIndex(x => x.id === item.id)),
      total: alternatives.length,
      alternatives
    };
  }

  function selectBranch(session, item, direction) {
    const info = branchInfo(session, item);
    if (info.total < 2) return;
    const next = info.alternatives[(info.index + direction + info.total) % info.total];
    const parent = node(session, item.parentId);
    if (parent) {
      parent.selectedChildId = next.id;
      renderView(false);
    }
  }

  function activePathForRequest(session, untilNode) {
    const path = [];
    let cursor = node(session, session.rootId);
    while (cursor) {
      let nextId = cursor.selectedChildId;
      if ((!nextId || !node(session, nextId)) && cursor.childrenIds.length > 0) {
        nextId = cursor.childrenIds[cursor.childrenIds.length - 1];
      }
      if (!nextId || (untilNode && nextId === untilNode.id)) break;
      cursor = node(session, nextId);
      if (!cursor) break;
      path.push(cursor);
    }
    return path;
  }

  function requestHistory(session, assistant) {
    return activePathForRequest(session, assistant)
      .filter(item => (item.role === 'user' || item.role === 'assistant') && item.content && item.status !== 'error')
      .map(item => {
        if (item.role === 'user' && item.metadata.attachments?.length) {
          return {
            role: item.role,
            content: [
              { type: 'text', text: item.content },
              ...item.metadata.attachments.map(attachment => ({ type: 'image_url', image_url: { url: attachment.dataUrl } }))
            ]
          };
        }
        return { role: item.role, content: item.content };
      });
  }

  /* ============ Key 管理 ============ */
  function setKeyStatus(message, type = 'info') {
    const el = $('keyStatus');
    if (el) { el.textContent = message; el.dataset.state = type; }
  }

  function updateKeyUi() {
    const saved = Boolean(state.apiKey);
    $('keyEntry').style.display = saved ? 'none' : 'block';
    $('keyBadge').style.display = saved ? 'flex' : 'none';
    $('keyMask').textContent = saved ? '已设置 · ••••••••' : '';
  }

  function saveApiKey() {
    const value = $('apiKeyInput').value.trim();
    if (!value) {
      setKeyStatus('请先粘贴 API Key。', 'error');
      $('apiKeyInput').focus();
      return;
    }
    state.apiKey = value;
    $('apiKeyInput').value = '';
    updateKeyUi();
    setKeyStatus('密钥已暂存于当前页面内存中。', 'success');
  }

  function clearApiKey(message) {
    if (state.task) {
      state.task.controller.abort();
      state.task = null;
      setStreaming(false);
    }
    state.apiKey = '';
    $('apiKeyInput').value = '';
    updateKeyUi();
    setKeyStatus(message, 'info');
  }

  /* ============ 侧栏与会话 ============ */
  function renderSidebar() {
    schedulePersist();
    const row = session => `<div data-session-id="${session.id}" class="sess group flex items-center justify-between px-3 py-1.5 rounded-lg cursor-pointer transition ${session.id === state.currentSessionId ? 'active bg-raised text-ink font-medium' : 'text-mute hover:text-ink hover:bg-raised'}">
      <span class="truncate pr-1">${escapeHtml(session.title)}</span>
      <span class="sess-act hidden items-center space-x-1 flex-shrink-0">
        <button type="button" data-session-act="rename" aria-label="重命名" class="p-1 hover:text-ink">✎</button>
        <button type="button" data-session-act="pin" aria-label="${session.pinned ? '取消置顶' : '置顶'}" class="p-1 hover:text-amber-500">${session.pinned ? '★' : '☆'}</button>
        <button type="button" data-session-act="delete" aria-label="删除" class="p-1 hover:text-red-500">×</button>
      </span></div>`;
    const query = ($('sessionSearchInput')?.value || '').trim().toLowerCase();
    const visible = state.sessions.filter(s => !query || s.title.toLowerCase().includes(query) || selectedPath(s).some(item => item.content.toLowerCase().includes(query)));
    $('pinnedList').innerHTML = visible.filter(s => s.pinned).map(row).join('');
    $('recentList').innerHTML = visible.filter(s => !s.pinned).map(row).join('');
    $('pinnedGroup').style.display = state.sessions.some(s => s.pinned) ? 'block' : 'none';
  }

  function syncPromptBox() {
    const session = current();
    if (session && $('systemPromptInput')) {
      $('systemPromptInput').value = session.systemPrompt || '';
    }
  }

  function requestDeleteSession(sessionId) {
    state.pendingDeleteId = sessionId;
    $('deleteModal').classList.add('show');
    $('confirmDeleteBtn').focus();
  }

  function closeDeleteModal() {
    state.pendingDeleteId = null;
    $('deleteModal').classList.remove('show');
  }

  function confirmDelete() {
    if (!state.pendingDeleteId) return;
    const targetId = state.pendingDeleteId;
    closeDeleteModal();

    if (state.task && state.task.session.id === targetId) {
      state.task.controller.abort();
      state.task = null;
      setStreaming(false);
    }

    state.sessions = state.sessions.filter(s => s.id !== targetId);
    if (!state.sessions.length) {
      const fresh = createSession();
      state.sessions.push(fresh);
      state.currentSessionId = fresh.id;
    } else if (state.currentSessionId === targetId) {
      state.currentSessionId = state.sessions[0].id;
    }

    syncPromptBox();
    renderSidebar();
    renderView();
  }

  /* ============ 渲染与视图 ============ */
  function messageStatus(item) {
    if (item.status === 'streaming') return '生成中…';
    if (item.status === 'stopped') return '已停止 · 可重新生成';
    if (item.status === 'error') return '请求失败 · 可重新生成';
    if (item.role === 'assistant') {
      const model = item.metadata.model || 'assistant';
      const tokens = item.metadata.totalTokens != null ? `${item.metadata.totalTokens} tokens` : 'Token 用量未返回';
      const time = item.metadata.durationMs ? `${(item.metadata.durationMs / 1000).toFixed(1)}s` : '';
      return [model, tokens, time].filter(Boolean).join(' · ');
    }
    return '';
  }

  function actionButton(action, item, label, disabled = false) {
    return `<button type="button" data-msg-act="${action}" data-node-id="${item.id}" ${disabled ? 'disabled' : ''}>${label}</button>`;
  }

  function messageHtml(session, item) {
    const info = branchInfo(session, item);
    const branch = info.total > 1 ? `<span class="branch-count">${actionButton('branch-prev', item, '‹')} ${info.index + 1}/${info.total} ${actionButton('branch-next', item, '›')}</span>` : '';
    if (item.role === 'user') {
      const attachments = item.metadata.attachments?.length ? `<div class="text-[11px] text-mute mt-2">📎 ${item.metadata.attachments.map(attachment => escapeHtml(attachment.name)).join('、')}</div>` : '';
      return `<div class="flex justify-end msg-in"><div class="user-bubble-wrap">
        <div data-node-id="${item.id}" class="bg-raised text-ink px-4 py-3 text-[15px] leading-relaxed shadow-sm whitespace-pre-wrap break-words" style="border-radius:1.25rem 1.25rem .35rem 1.25rem">${escapeHtml(item.content)}${attachments}</div>
        <div class="msg-tools justify-end">${actionButton('copy-user', item, '复制')} ${actionButton('edit', item, '编辑')} ${branch}</div>
      </div></div>`;
    }
    const body = item.error
      ? `<div class="text-red-500 text-xs bg-red-500/10 p-3 rounded-xl break-words">${escapeHtml(item.error)}</div>`
      : (!item.content && item.status === 'streaming'
          ? `<span class="clay">${STAR('star-pulse')}</span>`
          : md(item.content) + (item.status === 'streaming' ? '<span class="caret"></span>' : `<span class="sig">${STAR('')}</span>`));

    return `<div class="msg-in"><div data-node-id="${item.id}" class="md">${body}</div>
      <div class="msg-tools">${actionButton('copy-assistant', item, '复制 Markdown')} ${actionButton('regenerate', item, item.status === 'error' || item.status === 'stopped' ? '重试请求' : '重新生成', item.status === 'streaming')} ${branch} <span class="msg-status">${messageStatus(item)}</span></div>
    </div>`;
  }

  function enhanceCode(root) {
    root.querySelectorAll('pre').forEach(pre => {
      if (pre.parentElement.classList.contains('codeblock')) return;
      const code = pre.querySelector('code');
      const match = code && /language-([\w+#-]+)/.exec(code.className);
      const wrap = document.createElement('div');
      wrap.className = 'codeblock';
      wrap.innerHTML = `<div class="cb-bar"><span>${escapeHtml(match ? match[1] : 'code')}</span><button type="button" class="copy-btn">复制</button></div>`;
      pre.parentNode.insertBefore(wrap, pre);
      wrap.appendChild(pre);
    });
    root.querySelectorAll('pre code:not([data-highlighted])').forEach(el => hljs.highlightElement(el));
  }

  function renderView(forceScroll = true) {
    schedulePersist();
    const session = current();
    const path = selectedPath(session);
    const empty = path.length === 0;
    $('heroGreeting').classList.toggle('hidden', !empty);
    $('messagesContainer').classList.toggle('hidden', empty);
    $('dockedInputContainer').classList.toggle('hidden', empty || state.view !== 'chat');
    $('messagesContainer').innerHTML = path.map(item => messageHtml(session, item)).join('');
    enhanceCode($('messagesContainer'));
    const messageQuery = ($('messageSearchInput')?.value || '').trim().toLowerCase();
    $('messagesContainer').querySelectorAll('[data-node-id]').forEach(element => {
      const item = node(session, element.dataset.nodeId);
      const wrapper = element.closest('.msg-in') || element.closest('.flex.justify-end');
      if (wrapper) wrapper.style.display = !messageQuery || item?.content.toLowerCase().includes(messageQuery) ? '' : 'none';
    });
    if (forceScroll) scrollToBottom(true);
    $('dockedInput').value = session.draft;
    resizeInput($('dockedInput'));
  }

  function nearBottom() {
    const view = $('chatViewArea');
    return view.scrollHeight - view.scrollTop - view.clientHeight < 140;
  }

  function scrollToBottom(force = false) {
    const view = $('chatViewArea');
    if (force || nearBottom()) view.scrollTop = view.scrollHeight;
  }

  function copyText(text) {
    const fallback = () => new Promise((resolve, reject) => {
      const area = document.createElement('textarea');
      area.value = text;
      area.readOnly = true;
      area.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
      document.body.appendChild(area);
      area.select();
      try { document.execCommand('copy') ? resolve() : reject(new Error('复制失败')); }
      catch (err) { reject(err); }
      finally { area.remove(); }
    });
    return navigator.clipboard && window.isSecureContext ? navigator.clipboard.writeText(text).catch(fallback) : fallback();
  }

  function downloadFile(name, content, type) {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url; link.download = name; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  function exportableSession(session) {
    return {
      version: 1,
      title: session.title,
      pinned: session.pinned,
      systemPrompt: session.systemPrompt,
      rootId: session.rootId,
      draft: session.draft,
      promptHistory: session.promptHistory,
      nodes: Array.from(session.nodes.values()).map(item => ({ ...item, metadata: { ...item.metadata, paintScheduled: undefined } }))
    };
  }
  function exportJson() {
    const payload = { format: 'mimo-studio-workspace', version: 1, currentSessionId: state.currentSessionId, sessions: state.sessions.map(exportableSession) };
    downloadFile('mimo-studio-workspace.json', JSON.stringify(payload, null, 2), 'application/json');
  }
  function exportMarkdown() {
    const lines = [`# ${current().title || 'MiMo 对话'}`, '', `> 模型：${$('customModelInput').value.trim() || $('modelSelector').value}`, ''];
    selectedPath(current()).forEach(item => {
      if (item.role === 'user') lines.push(`## 用户\n\n${item.content}\n`);
      if (item.role === 'assistant') lines.push(`## Assistant\n\n${item.content || '(无正文)'}\n`);
    });
    downloadFile(`${current().title || 'mimo-session'}.md`, lines.join('\n'), 'text/markdown;charset=utf-8');
  }
  function importJsonFile(file) {
    if (!file || file.size > 50 * 1024 * 1024) { setKeyStatus('导入文件超过 50MB，已拒绝。', 'error'); return; }
    const reader = new FileReader();
    reader.onerror = () => setKeyStatus('读取会话 JSON 失败。', 'error');
    reader.onload = () => {
      try {
        const data = JSON.parse(reader.result);
        if (data?.format === 'mimo-studio-workspace' && Array.isArray(data.sessions)) {
          if (data.sessions.length > 500) throw new Error('会话数量超过安全上限');
          const restored = data.sessions.map(raw => {
            if (!raw || !Array.isArray(raw.nodes) || typeof raw.rootId !== 'string') throw new Error('工作区中存在格式错误的会话');
            const s = createSession(String(raw.title || '导入的对话').slice(0, 80), String(raw.systemPrompt || DEFAULT_PROMPT));
            s.pinned = Boolean(raw.pinned); s.rootId = raw.rootId; s.draft = String(raw.draft || '');
            s.promptHistory = Array.isArray(raw.promptHistory) ? raw.promptHistory.filter(x => typeof x === 'string').slice(-200) : [];
            s.nodes = new Map(raw.nodes.map(n => [n.id, { ...n, childrenIds: Array.isArray(n.childrenIds) ? n.childrenIds : [], metadata: n.metadata && typeof n.metadata === 'object' ? n.metadata : {} }]));
            if (!s.nodes.has(s.rootId) || s.nodes.size !== raw.nodes.length) throw new Error('会话节点缺失或重复');
            for (const n of s.nodes.values()) { if (n.parentId !== null && !s.nodes.has(n.parentId)) throw new Error('父节点引用无效'); if (n.childrenIds.some(cid => !s.nodes.has(cid))) throw new Error('子节点引用无效'); }
            return s;
          });
          state.sessions = restored; state.currentSessionId = restored.some(s => s.id === data.currentSessionId) ? data.currentSessionId : restored[0]?.id;
          syncPromptBox(); renderSidebar(); renderView(); setKeyStatus('工作区已导入。', 'success'); return;
        }
        if (!data || data.version !== 1 || !Array.isArray(data.nodes) || typeof data.rootId !== 'string') throw new Error('格式不受支持');
        const imported = createSession(String(data.title || '导入的对话').slice(0, 80), String(data.systemPrompt || DEFAULT_PROMPT));
        imported.pinned = Boolean(data.pinned);
        imported.rootId = data.rootId;
        imported.draft = String(data.draft || '');
        imported.promptHistory = Array.isArray(data.promptHistory) ? data.promptHistory.filter(item => typeof item === 'string').slice(-200) : [];
        if (data.nodes.length > 20000) throw new Error('节点数量超过安全上限');
        const importedNodes = new Map();
        for (const item of data.nodes) {
          if (!item || typeof item.id !== 'string' || importedNodes.has(item.id)) throw new Error('节点 ID 缺失或重复');
          if (!['root', 'user', 'assistant'].includes(item.role)) throw new Error('消息角色不合法');
          importedNodes.set(item.id, { ...item, childrenIds: Array.isArray(item.childrenIds) ? item.childrenIds : [], metadata: item.metadata && typeof item.metadata === 'object' ? item.metadata : {} });
        }
        imported.nodes = importedNodes;
        if (!imported.nodes.has(imported.rootId)) throw new Error('缺少根节点');
        for (const item of imported.nodes.values()) {
          if (item.id !== imported.rootId && (!item.parentId || !imported.nodes.has(item.parentId))) throw new Error('存在断裂的父节点引用');
          if (item.childrenIds.some(childId => !imported.nodes.has(childId))) throw new Error('存在不存在的子节点引用');
          if (item.selectedChildId && !item.childrenIds.includes(item.selectedChildId)) throw new Error('选中分支不属于当前节点');
          if (typeof item.content !== 'string') item.content = String(item.content ?? '');
        }
        // Parent-child symmetry and cycle detection.
        for (const item of imported.nodes.values()) {
          for (const childId of item.childrenIds) if (imported.nodes.get(childId).parentId !== item.id) throw new Error('父子节点关系不一致');
        }
        for (const item of imported.nodes.values()) {
          const seen = new Set(); let cursor = item;
          while (cursor) { if (seen.has(cursor.id)) throw new Error('消息树存在循环引用'); seen.add(cursor.id); cursor = cursor.parentId ? imported.nodes.get(cursor.parentId) : null; }
        }
        state.sessions.unshift(imported);
        state.currentSessionId = imported.id;
        syncPromptBox(); renderSidebar(); renderView();
        setKeyStatus('会话已导入当前页面内存。', 'success');
      } catch (error) {
        setKeyStatus(`导入失败：${error.message}`, 'error');
      }
    };
    reader.readAsText(file);
  }
  function renameSession(session) {
    state.pendingRenameId = session.id;
    $('renameInput').value = session.title;
    $('renameModal').style.opacity = '1';
    $('renameModal').style.pointerEvents = 'auto';
    $('renameInput').focus();
    $('renameInput').select();
  }
  function closeRenameModal() {
    state.pendingRenameId = null;
    $('renameModal').style.opacity = '0';
    $('renameModal').style.pointerEvents = 'none';
  }
  function confirmRename() {
    const session = state.sessions.find(item => item.id === state.pendingRenameId);
    const title = $('renameInput').value.trim();
    if (session && title) session.title = title.slice(0, 80);
    closeRenameModal();
    renderSidebar();
  }

  function flashButton(button, text = '已复制') {
    const original = button.textContent;
    button.textContent = '✓';
    button.setAttribute('aria-label', text);
    setTimeout(() => { button.textContent = original; button.removeAttribute('aria-label'); }, 1200);
  }

  function setStreaming(active) {
    $('dockedSendBtn').textContent = active ? '停止' : '发送';
    $('dockedSendBtn').setAttribute('aria-label', active ? '停止生成' : '发送消息');
    $('dockedSendBtn').classList.toggle('bg-red-600', active);
    $('dockedSendBtn').classList.toggle('hover:bg-red-500', active);
  }

  function schedulePaint(session, item) {
    if (item.metadata.paintScheduled) return;
    item.metadata.paintScheduled = true;
    requestAnimationFrame(() => {
      item.metadata.paintScheduled = false;
      if (session.id !== state.currentSessionId) return;
      const el = document.querySelector(`[data-node-id="${item.id}"]`);
      if (!el) return;
      const stick = nearBottom();
      el.innerHTML = item.error
        ? `<div class="text-red-500 text-xs bg-red-500/10 p-3 rounded-xl">${escapeHtml(item.error)}</div>`
        : (item.content ? md(item.content) : `<span class="clay">${STAR('star-pulse')}</span>`) + (item.status === 'streaming' ? '<span class="caret"></span>' : '');
      scrollToBottom(stick);
    });
  }

  /* ============ 流式通信与 SSE 缓冲区 Flush ============ */
  function parseSseEvents(buffer) {
    const normalized = buffer.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    const chunks = normalized.split('\n\n');
    return {
      remainder: chunks.pop() || '',
      events: chunks.filter(Boolean).map(block => {
        return block.split('\n').filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
      }).filter(Boolean)
    };
  }

  async function streamTask(task) {
    const { session, assistant, snapshot } = task;
    assistant.status = 'streaming';
    if (session.id === state.currentSessionId) renderView(false);
    const startedAt = performance.now();
    try {
      const provider = PROVIDERS[snapshot.provider] || PROVIDERS.custom;
      const headers = { 'Content-Type': 'application/json' };
      headers[provider.auth === 'api-key' ? 'api-key' : 'Authorization'] = provider.auth === 'api-key' ? snapshot.apiKey : `Bearer ${snapshot.apiKey}`;
      const requestBody = {
        model: snapshot.model,
        messages: [...(snapshot.systemPrompt ? [{ role: 'system', content: snapshot.systemPrompt }] : []), ...snapshot.history],
        stream: true
      };
      if (!snapshot.thinking) requestBody.temperature = snapshot.temperature;
      if (provider.thinking === 'mimo') requestBody.thinking = { type: snapshot.thinking ? 'enabled' : 'disabled' };
      if (snapshot.thinking && provider.thinking === 'openrouter') requestBody.reasoning = { effort: 'medium' };
      const response = await fetch(snapshot.endpoint, {
        method: 'POST', signal: task.controller.signal, headers, body: JSON.stringify(requestBody)
      });

      if (!response.ok) {
        const detail = (await response.text()).slice(0, 700);
        throw new Error(`HTTP ${response.status}${detail ? `：${detail}` : ''}`);
      }
      if (!response.body) throw new Error('当前浏览器未提供可读取的响应流。');

      const reader = response.body.getReader();
      const decoder = new TextDecoder('utf-8');
      let buffer = '';
      let doneSeen = false;

      const consume = data => {
        if (data === '[DONE]') { doneSeen = true; return; }
        let payload;
        try { payload = JSON.parse(data); } catch (err) { console.warn('MiMo SSE 解析失败', err); return; }
        const delta = payload.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') {
          assistant.content += delta;
          schedulePaint(session, assistant);
        }
        const usage = payload.usage;
        if (usage && typeof usage.total_tokens === 'number') {
          assistant.metadata.totalTokens = usage.total_tokens;
          assistant.metadata.inputTokens = usage.prompt_tokens;
          assistant.metadata.outputTokens = usage.completion_tokens;
        }
        if (typeof payload.model === 'string') assistant.metadata.model = payload.model;
      };

      while (true) {
        const part = await reader.read();
        buffer += decoder.decode(part.value || new Uint8Array(), { stream: !part.done });
        const parsed = parseSseEvents(buffer);
        buffer = parsed.remainder;
        parsed.events.forEach(consume);
        if (part.done) break;
      }

      // 尾部残存缓冲区 Flush 兜底
      buffer += decoder.decode();
      const final = parseSseEvents(buffer);
      final.events.forEach(consume);
      if (final.remainder.trim().startsWith('data:')) {
        consume(final.remainder.trim().slice(5).trim());
      }

      if (!doneSeen && !assistant.content) throw new Error('响应流提前结束，未收到有效内容。');
      if (assistant.status === 'streaming') assistant.status = 'complete';
    } catch (error) {
      if (error.name === 'AbortError') {
        assistant.status = assistant.content ? 'stopped' : 'error';
        if (!assistant.content) assistant.error = '生成已停止，尚未收到正文。';
      } else {
        assistant.status = 'error';
        assistant.error = error.message || '请求失败。';
      }
    } finally {
      assistant.metadata.durationMs = performance.now() - startedAt;
      delete assistant.metadata.paintScheduled;
      if (state.task?.requestId === task.requestId) {
        state.task = null;
        setStreaming(false);
      }
      if (session.id === state.currentSessionId) renderView(false);
    }
  }

  function startGeneration(session, assistant) {
    if (state.task) return;
    const task = {
      requestId: id('r'),
      session,
      assistant,
      controller: new AbortController(),
      snapshot: {
        apiKey: state.apiKey,
        provider: state.provider || 'mimo',
        model: state.provider === 'mimo' ? ($('customModelInput').value.trim() || $('modelSelector').value) : $('customModelInput').value.trim(),
        endpoint: $('endpointInput').value.trim() || state.endpoint,
        temperature: Number($('drawerTempSlider').value),
        thinking: $('thinkingToggle').checked,
        systemPrompt: (session.systemPrompt || '').trim(),
        history: requestHistory(session, assistant)
      }
    };
    state.task = task;
    setStreaming(true);
    streamTask(task);
  }

  function send(text) {
    if (state.task) return false;
    if (!state.apiKey) {
      toggleSettingsDrawer(true);
      setKeyStatus('请先设置 API Key，再发送消息。', 'error');
      $('apiKeyInput').focus();
      return false;
    }
    const selectedModel = state.provider === 'mimo' ? ($('customModelInput').value.trim() || $('modelSelector').value) : $('customModelInput').value.trim();
    if (!selectedModel) {
      toggleSettingsDrawer(true);
      setKeyStatus('请先填写当前服务商对应的模型 ID。', 'error');
      $('customModelInput').focus();
      return false;
    }
    const session = current();
    const parent = selectedPath(session).at(-1)?.id || session.rootId;
    const user = addNode(session, parent, 'user', text, { metadata: { attachments: session.pendingAttachments.splice(0) } });
    const assistant = addNode(session, user.id, 'assistant');
    if (text) session.promptHistory.push(text);
    if (session.title === '新的对话' && text) session.title = Array.from(text).slice(0, 14).join('');
    session.draft = '';
    renderSidebar();
    renderView();
    startGeneration(session, assistant);
    return true;
  }

  function regenerate(item) {
    if (state.task || item.role !== 'assistant') return;
    const session = current();
    const replacement = addNode(session, item.parentId, 'assistant');
    renderView();
    startGeneration(session, replacement);
  }

  function editAndRetry(item) {
    const bubble = document.querySelector(`[data-node-id="${item.id}"]`);
    if (!bubble) return;
    const parentWrap = bubble.closest('.user-bubble-wrap');
    if (!parentWrap) return;
    parentWrap.innerHTML = `
      <div class="bg-raised p-3 rounded-2xl shadow-sm border border-[var(--line)]">
        <textarea class="edit-box w-full bg-app text-ink text-[15px] p-2.5 rounded-xl outline-none resize-none leading-relaxed" rows="3">${escapeHtml(item.content)}</textarea>
        <div class="flex justify-end items-center gap-2 pt-2.5">
          <button type="button" data-msg-act="cancel-edit" class="px-3 py-1.5 text-xs text-mute hover:text-ink rounded-lg transition">取消</button>
          <button type="button" data-msg-act="submit-edit" data-node-id="${item.id}" class="btn-clay px-3.5 py-1.5 text-xs font-medium rounded-lg">发送</button>
        </div>
      </div>`;
    const ta = parentWrap.querySelector('textarea');
    ta.focus();
    ta.selectionStart = ta.selectionEnd = ta.value.length;
    ta.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        submitEdit(item, ta.value);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        renderView(false);
      }
    });
  }

  function submitEdit(item, text) {
    if (state.task) return;
    const cleanText = (text || '').trim();
    if (!cleanText) return;
    const session = current();
    const edited = addNode(session, item.parentId, 'user', cleanText);
    const assistant = addNode(session, edited.id, 'assistant');
    session.promptHistory.push(cleanText);
    renderView();
    startGeneration(session, assistant);
  }

  /* ============ 输入框自适应与历史回填 ============ */
  function resizeInput(input) {
    input.style.height = 'auto';
    input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
    input.style.overflowY = input.scrollHeight > 180 ? 'auto' : 'hidden';
  }

  const TEXT_EXTENSIONS = new Set(['txt', 'md', 'json', 'csv', 'log', 'js', 'ts', 'jsx', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'html', 'css', 'xml', 'yaml', 'yml', 'toml', 'sql', 'sh']);
  function fileExtension(name) {
    const parts = name.toLowerCase().split('.');
    return parts.length > 1 ? parts.pop() : '';
  }
  function readAttachment(file, inputEl) {
    const ext = fileExtension(file.name);
    const isImage = /^image\/(png|jpeg|webp)$/.test(file.type) || ['png', 'jpg', 'jpeg', 'webp'].includes(ext);
    const maxBytes = isImage ? 5 * 1024 * 1024 : 2 * 1024 * 1024;
    if (file.size > maxBytes) {
      setKeyStatus(`文件 ${file.name} 超过 ${isImage ? '5' : '2'}MB，已拒绝。`, 'error');
      return;
    }
    if (!isImage && !TEXT_EXTENSIONS.has(ext) && file.type && !file.type.startsWith('text/')) {
      setKeyStatus(`不支持读取 ${file.name}：仅允许文本、源码、JSON 和 PNG/JPEG/WebP 图片。`, 'error');
      return;
    }
    const reader = new FileReader();
    reader.onerror = () => setKeyStatus(`读取文件 ${file.name} 失败。`, 'error');
    reader.onload = event => {
      const session = current();
      if (isImage) {
        session.pendingAttachments.push({ name: file.name, type: file.type || `image/${ext === 'jpg' ? 'jpeg' : ext}`, dataUrl: event.target.result });
        schedulePersist();
        setKeyStatus(`已添加图片附件：${file.name}`, 'success');
      } else {
        const content = String(event.target.result || '');
        const block = `\n\n\`\`\`${ext || 'text'}\n// [文件: ${file.name}]\n${content}\n\`\`\`\n`;
        inputEl.value = (inputEl.value ? inputEl.value + '\n' : '') + block;
        session.draft = inputEl.value;
        schedulePersist();
        resizeInput(inputEl);
        setKeyStatus(`已读取文本文件：${file.name}`, 'success');
      }
      inputEl.focus();
    };
    if (!isImage) {
      reader.onload = event => {
        const session = current();
        const content = String(event.target.result || '');
        const block = `\n\n\`\`\`${ext || 'text'}\n// [文件: ${file.name}]\n${content}\n\`\`\`\n`;
        inputEl.value = (inputEl.value ? inputEl.value + '\n' : '') + block;
        session.draft = inputEl.value;
        schedulePersist();
        resizeInput(inputEl);
        setKeyStatus(`已读取文本文件：${file.name}`, 'success');
        inputEl.focus();
      };
      reader.readAsText(file);
    } else {
      reader.readAsDataURL(file);
    }
  }

  function bindInput(id, submit) {
    const input = $(id);
    input.addEventListener('input', () => {
      resizeInput(input);
      current().draft = input.value;
      current().historyCursor = -1;
      schedulePersist();
    });
    input.addEventListener('keydown', event => {
      if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        submit();
      }
      if ((event.key === 'ArrowUp' || event.key === 'ArrowDown') && !input.value) {
        const session = current();
        const pathPrompts = selectedPath(session).filter(item => item.role === 'user').map(item => item.content);
        const prompts = [...pathPrompts, ...session.promptHistory.filter(item => !pathPrompts.includes(item))];
        if (!prompts.length) return;
        event.preventDefault();
        const direction = event.key === 'ArrowUp' ? -1 : 1;
        session.historyCursor = Math.max(0, Math.min(prompts.length - 1, (session.historyCursor < 0 ? prompts.length : session.historyCursor) + direction));
        input.value = prompts[session.historyCursor];
        resizeInput(input);
      }
    });
  }

  /* ============ 本地文件拖拽读取 (FileReader) ============ */
  function bindDropUpload(areaEl, inputEl) {
    if (!areaEl || !inputEl) return;
    ['dragenter', 'dragover'].forEach(name => {
      areaEl.addEventListener(name, e => {
        e.preventDefault();
        e.stopPropagation();
        areaEl.classList.add('ring-2', 'ring-orange-500/50');
      });
    });
    ['dragleave', 'drop'].forEach(name => {
      areaEl.addEventListener(name, e => {
        e.preventDefault();
        e.stopPropagation();
        areaEl.classList.remove('ring-2', 'ring-orange-500/50');
      });
    });
    areaEl.addEventListener('drop', e => {
      const files = Array.from(e.dataTransfer?.files || []);
      if (!files.length) return;
      files.forEach(file => readAttachment(file, inputEl));
    });
  }

  /* ============ 抽屉、主题与问候语 ============ */
  function toggleSettingsDrawer(force) {
    const drawer = $('settingsDrawer');
    const open = typeof force === 'boolean' ? force : !drawer.classList.contains('open');
    drawer.classList.toggle('open', open);
    drawer.inert = !open;
    if (open) setTimeout(() => (state.apiKey ? $('modelSelector') : $('apiKeyInput')).focus(), 60);
  }

  function applyTheme(mode) {
    state.themeMode = mode;
    savePreferences();
    const darkQuery = matchMedia('(prefers-color-scheme: dark)');
    document.documentElement.dataset.theme = mode === 'system' ? (darkQuery.matches ? 'dark' : 'light') : mode;
    document.querySelectorAll('#themeSeg button').forEach(button => button.classList.toggle('active', button.dataset.themeMode === mode));
  }

  function switchView(view) {
    state.view = view;
    $('chatViewArea').classList.toggle('hidden', view !== 'chat');
    $('skillsViewArea').classList.toggle('hidden', view !== 'skills');
    renderView(false);
    if (isMobile()) closeSidebar();
  }

  function updateGreeting() {
    const h = new Date().getHours();
    const text = h >= 5 && h < 12 ? 'Morning reflections'
      : h < 18 && h >= 12 ? 'Afternoon thoughts'
      : h >= 18 && h < 23 ? 'Evening thoughts'
      : 'Midnight whispers';
    const el = $('timeGreetingText');
    if (el) el.textContent = text;
  }

  /* ============ 事件绑定 ============ */
  $('sessionLists').addEventListener('click', event => {
    const row = event.target.closest('[data-session-id]');
    if (!row) return;
    const session = state.sessions.find(item => item.id === row.dataset.sessionId);
    if (!session) return;
    if (event.target.closest('[data-session-act="pin"]')) {
      session.pinned = !session.pinned;
      renderSidebar();
      return;
    }
    if (event.target.closest('[data-session-act="rename"]')) {
      renameSession(session);
      return;
    }
    if (event.target.closest('[data-session-act="delete"]')) {
      requestDeleteSession(session.id);
      return;
    }
    if (state.task && state.task.session !== session) state.task.controller.abort();
    state.currentSessionId = session.id;
    syncPromptBox();
    renderSidebar();
    renderView();
  });

  $('messagesContainer').addEventListener('click', event => {
    const button = event.target.closest('[data-msg-act]');
    if (button) {
      const session = current();
      const item = node(session, button.dataset.nodeId);
      const action = button.dataset.msgAct;
      if (!item && action !== 'cancel-edit') return;
      if (action === 'copy-user' || action === 'copy-assistant') {
        copyText(item.content).then(() => flashButton(button)).catch(() => setKeyStatus('复制失败。', 'error'));
      } else if (action === 'regenerate') {
        regenerate(item);
      } else if (action === 'edit') {
        editAndRetry(item);
      } else if (action === 'cancel-edit') {
        renderView(false);
      } else if (action === 'submit-edit') {
        const ta = button.closest('.user-bubble-wrap')?.querySelector('textarea');
        if (ta) submitEdit(item, ta.value);
      } else if (action === 'branch-prev') {
        selectBranch(session, item, -1);
      } else if (action === 'branch-next') {
        selectBranch(session, item, 1);
      }
      return;
    }
    const codeButton = event.target.closest('.copy-btn');
    if (codeButton) {
      copyText(codeButton.closest('.codeblock').querySelector('code').innerText).then(() => flashButton(codeButton)).catch(() => {});
    }
  });

  $('confirmDeleteBtn').addEventListener('click', confirmDelete);
  $('confirmRenameBtn').addEventListener('click', confirmRename);
  $('cancelRenameBtn').addEventListener('click', closeRenameModal);
  $('renameInput').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); confirmRename(); }
    if (event.key === 'Escape') { event.preventDefault(); closeRenameModal(); }
  });
  $('keySaveBtn').addEventListener('click', saveApiKey);
  $('apiKeyInput').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); saveApiKey(); } });
  $('keyChangeBtn').addEventListener('click', () => clearApiKey('旧密钥已移除，请输入新密钥。'));
  $('keyClearBtn').addEventListener('click', () => clearApiKey('密钥已清除。'));

  $('drawerTempSlider').addEventListener('input', event => {
    $('drawerTempVal').textContent = event.target.value;
    $('currentTempBadge').textContent = `温度 ${event.target.value}`; savePreferences();
  });
  $('modelSelector').addEventListener('change', event => { $('currentModelBadge').textContent = event.target.value; });
  $('thinkingToggle').addEventListener('change', event => {
    const disabled = event.target.checked;
    $('drawerTempSlider').disabled = disabled;
    $('temperatureNote').textContent = disabled ? '思考模式下温度由服务端控制。' : '范围 0–1.5；每次请求会保存当前设置快照。';
  });

  $('systemPromptInput').addEventListener('input', event => {
    const session = current();
    if (session) session.systemPrompt = event.target.value;
  });

  $('themeSeg').addEventListener('click', event => {
    const button = event.target.closest('[data-theme-mode]');
    if (button) applyTheme(button.dataset.themeMode);
  });

  $('dockedSendBtn').addEventListener('click', () => {
    if (state.task) state.task.controller.abort();
    else if (current().draft.trim() || current().pendingAttachments.length) send(current().draft.trim());
  });
  $('sessionSearchInput').addEventListener('input', renderSidebar);
  $('messageSearchInput').addEventListener('input', () => renderView(false));
  $('exportJsonBtn').addEventListener('click', exportJson);
  $('exportMarkdownBtn').addEventListener('click', exportMarkdown);
  $('importJsonBtn').addEventListener('click', () => $('importJsonInput').click());
  $('importJsonInput').addEventListener('change', event => {
    importJsonFile(event.target.files?.[0]);
    event.target.value = '';
  });
  $('dockedFileInput').addEventListener('change', event => {
    Array.from(event.target.files || []).forEach(file => readAttachment(file, $('dockedInput')));
    event.target.value = '';
  });
  $('providerSelector').addEventListener('change', event => {
    applyProvider(event.target.value);
    $('modelSelector').value = 'mimo-v2.6-flash';
    $('customModelInput').value = '';
    $('currentModelBadge').textContent = state.provider === 'mimo' ? $('modelSelector').value : '请填写模型 ID';
  });
  $('endpointInput').addEventListener('change', event => {
    try {
      const url = new URL(event.target.value);
      if (!['http:', 'https:'].includes(url.protocol)) throw new Error('协议必须为 HTTP 或 HTTPS');
      state.endpoint = url.href;
      savePreferences();
      setKeyStatus('Endpoint 已更新；下一次请求生效。', 'success');
    } catch (error) {
      event.target.value = state.endpoint;
      setKeyStatus(`Endpoint 无效：${error.message}`, 'error');
    }
  });
  $('customModelInput').addEventListener('input', event => {
    $('currentModelBadge').textContent = event.target.value.trim() || $('modelSelector').value; savePreferences();
  });
  $('presetSelector').addEventListener('change', event => {
    const presets = {
      balanced: { temperature: 0.7, thinking: false },
      precise: { temperature: 0.2, thinking: true },
      creative: { temperature: 1.2, thinking: false },
      coding: { temperature: 0.3, thinking: false }
    };
    const preset = presets[event.target.value];
    if (!preset) return;
    $('drawerTempSlider').value = String(preset.temperature);
    $('drawerTempVal').textContent = String(preset.temperature);
    $('currentTempBadge').textContent = `温度 ${preset.temperature}`;
    $('thinkingToggle').checked = preset.thinking;
    $('thinkingToggle').dispatchEvent(new Event('change'));
  });

  bindInput('heroInput', () => {
    const text = $('heroInput').value.trim();
    if ((text || current().pendingAttachments.length) && send(text)) $('heroInput').value = '';
  });
  bindInput('dockedInput', () => {
    const text = $('dockedInput').value.trim();
    if ((text || current().pendingAttachments.length) && send(text)) $('dockedInput').value = '';
  });

  // 绑定拖拽
  bindDropUpload($('heroInput').closest('.hero-card'), $('heroInput'));
  bindDropUpload($('dockedInput').closest('.shadow-soft'), $('dockedInput'));

  document.querySelectorAll('.quick').forEach(button => {
    button.addEventListener('click', () => {
      $('heroInput').value = button.dataset.q;
      resizeInput($('heroInput'));
    });
  });

  // 全局快捷键
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      if ($('deleteModal').classList.contains('show')) closeDeleteModal();
      else if ($('renameModal').style.pointerEvents === 'auto') closeRenameModal();
      else if ($('settingsDrawer').classList.contains('open')) toggleSettingsDrawer(false);
      else if (isMobile() && $('sidebar').classList.contains('open')) closeSidebar();
    }
    if (event.altKey && event.key.toLowerCase() === 'n') {
      event.preventDefault();
      window.createNewSession();
    }
  });

  /* ============ 全局暴露函数 ============ */
  window.createNewSession = () => {
    if (state.task) state.task.controller.abort();
    const session = createSession();
    state.sessions.unshift(session);
    state.currentSessionId = session.id;
    syncPromptBox();
    renderSidebar();
    renderView();
    $('heroInput').focus();
  };
  window.toggleSettingsDrawer = toggleSettingsDrawer;
  window.switchMainView = switchView;
  window.openSidebar = () => { $('sidebar').classList.add('open'); $('scrim').classList.add('show'); };
  window.closeSidebar = () => { $('sidebar').classList.remove('open'); $('scrim').classList.remove('show'); };
  window.sidebarBtn = () => {
    if (isMobile()) return closeSidebar();
    $('sidebar').dataset.collapsed = $('sidebar').dataset.collapsed === 'true' ? 'false' : 'true';
  };
  window.activateSkill = index => {
    const skill = window.SKILLS?.[index];
    if (skill) {
      if (state.task) state.task.controller.abort();
      const session = createSession(skill.title, skill.prompt);
      session.pinned = true;
      state.sessions.unshift(session);
      state.currentSessionId = session.id;
      syncPromptBox();
      renderSidebar();
      renderView();
    }
  };
  window.closeDeleteModal = closeDeleteModal;
  window.handleHeroSubmit = () => {
    const text = $('heroInput').value.trim();
    if ((text || current().pendingAttachments.length) && send(text)) $('heroInput').value = '';
  };
  window.handleDockedSubmit = () => {
    if (state.task) state.task.controller.abort();
    else {
      const text = $('dockedInput').value.trim();
      if ((text || current().pendingAttachments.length) && send(text)) $('dockedInput').value = '';
    }
  };

  /* ============ 预设技能数据与渲染 ============ */
  const SKILLS = [
    { glyph: '金', tag: '金融 / 计算', title: '金融与宏观周期专家', desc: '擅长政治经济学、可变资本推演、宏观周期与财务分析，拒绝宏大叙事，专讲现实逻辑与真实概率。',
      prompt: '你是一位精通宏观经济学与现代金融计算的分析专家。请立足严谨的微观与宏观逻辑，不讲浮夸的大话空话，用具体数据、规则和概率做严肃推导与辩驳。' },
    { glyph: 'C++', tag: '系统 / 算法', title: 'C++ 底层与算法导师', desc: '专注内存布局、指针寻址、RAII 异常安全与逆向汇编拆解，崇尚“最小可运行示例 → 原理解析”。',
      prompt: '你是一位资深系统软件与 C++ 工程师。遵循代码第一、平视技术的原则，解析底层内存模型、指针、编译和汇编机制，给出清晰的最小验证代码，严禁玄学修辞。' },
    { glyph: '戏', tag: '同人与叙事', title: '角色张力与心理对峙实验室', desc: '擅长强强对峙、极限推拉、冷感角色心理破防与高压情境博弈，注重动作细节与情绪爆发逻辑。',
      prompt: '你是一位精通深度人物塑造与情感张力构建的创作顾问。专注强强对峙、极限推拉与冷感角色的微妙心理防线崩解，用精准动作和潜台词表达冲突，拒绝扁平套路。' },
    { glyph: '析', tag: '精读 / 提炼', title: '硬核事实与去水提取器', desc: '剥除任何宏大叙事、赞美与公关套话，只提取核心矛盾点、技术事实、因果推导与代码证据。',
      prompt: '请对输入的内容做极端客观的结构化解构：剥离所有的情绪宣泄、修辞夸大与公关虚词，仅提炼出核心事实链条、真实前提限制与底层逻辑漏洞。' }
  ];
  window.SKILLS = SKILLS;

  $('skillGrid').innerHTML = SKILLS.map((k, i) => `
    <div class="skill-card bg-surf p-5 rounded-2xl flex flex-col justify-between" style="border:1px solid var(--line)">
      <div class="space-y-3">
        <div class="flex justify-between items-center">
          <div class="glyph font-serif-claude">${k.glyph}</div>
          <span class="text-[11px] text-faint">${k.tag}</span>
        </div>
        <h3 class="font-serif-claude text-lg text-ink" style="font-weight:500">${k.title}</h3>
        <p class="text-[13px] text-mute leading-relaxed">${k.desc}</p>
      </div>
      <div class="pt-5 flex justify-end">
        <button onclick="activateSkill(${i})" class="px-3.5 py-1.5 bg-raised hover:bg-[rgb(var(--clay))] hover:text-white text-ink text-xs font-medium rounded-xl transition active:scale-95">试用此技能</button>
      </div>
    </div>`).join('');

  $('skillGrid').addEventListener('pointermove', e => {
    const card = e.target.closest('.skill-card');
    if (!card) return;
    const r = card.getBoundingClientRect();
    card.style.setProperty('--mx', `${e.clientX - r.left}px`);
    card.style.setProperty('--my', `${e.clientY - r.top}px`);
  });

  /* ============ 初始化 ============ */
  await restoreWorkspace();
  applyProvider(state.provider || 'mimo', true);
  if (state.endpoint) $('endpointInput').value = state.endpoint;
  $('drawerTempVal').textContent = $('drawerTempSlider').value;
  $('currentTempBadge').textContent = `温度 ${$('drawerTempSlider').value}`;
  updateGreeting();
  applyTheme(state.themeMode || 'system');
  syncPromptBox();
  updateKeyUi();
  renderSidebar();
  renderView();
  setStreaming(false);
});
