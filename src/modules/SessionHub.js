/**
 * SessionHub.js
 * =============================================================================
 * 세션 허브 창 (가로 세 칸)
 *
 *   ┌ 세션 목록 ──┬──── 마인드맵 (전체 / 폴더 중심 / 세션 중심) ────┬ 대화창 ─────┐
 *   │ 최근·폴더별 │  가운데를 고른 폴더나 세션으로 바꿔 사방으로 펼침 │ 고른 세션의  │
 *   │ 검색, 새 세션│                                                 │ 대화 + 입력  │
 *   └────────────┴────────────────────────────────────────────────┴─────────────┘
 *
 * IPC (main.js):
 *   sessions:index            → sessions:index-result        세션 목록
 *   sessions:transcript       → sessions:transcript-result   고른 세션의 대화
 *   sessions:send             → sessions:run-event / sessions:run-exit   메시지 보내기 (claude -p)
 *   sessions:stop                                             보내기 멈추기
 *   sessions:pick-folder      → sessions:pick-folder-result  새 세션 폴더 고르기
 */

class SessionHub {
    constructor(options = {}) {
        this.ipc = options.ipc !== undefined ? options.ipc : SessionMindMap._defaultIpc();
        this.now = options.now || (() => Date.now());
        this.el = id => document.getElementById(id);

        this.data = null;
        this.group = 'folder';     // folder(가지·줄기로 묶음) | recent — 고른 것은 기억
        try { if (localStorage.getItem('hub.group') === 'recent') this.group = 'recent'; } catch { /* 미리보기 */ }
        this.listQuery = '';
        this.center = 'all';       // all | project | session
        this.sel = null;           // { root, id? }
        this.transcript = null;    // { file, messages, truncated, mtimeMs }
        this.run = null;           // { runId, text, events[], sessionId, root }
        this.newFolder = null;     // 새 세션을 열 폴더
        this.permission = 'default';
        this.answerMode = SessionHub._loadAnswerMode(); // result | summary | detail
        this.openChains = new Set();  // 왼쪽 목록에서 "이전 N" 을 펼친 줄기 ("root::맨 끝 id")
        this.toonStart = true;      // 새 세션: 툰 허브를 읽고 시작
        this.newTopic = '';         // 새 세션: 주제 허브
        this.previewTranscripts = options.transcripts || null; // 미리보기: 세션 id → 메시지 목록
        this.previewHubs = options.hubs || null;
        this.previewUsage = options.usage || null;              // 미리보기: 사용량               // 미리보기: root → { text, topics: { 이름: text } }
        this.hubView = null;                                    // 열린 툰 허브 { root, topic, ... }

        this.map = new SessionMindMap('hub-mindmap', {
            ipc: this.ipc,
            now: this.now,
            infoKinds: ['project', 'file'],
            compact: true,
            onAddSession: (root, meta) => this.newSessionIn(root, meta),
            onDropSession: (src, target) => this._onDrop(src, target),
            onSelect: n => this._onMapSelect(n)
        });
        this.attachments = [];     // 대화창에 첨부한 파일 경로
        this.leftTab = 'sessions';
        this._bind();
        this._bindFiles();
        this._bindListDrag();
        this.finder = typeof HubFinder !== 'undefined' && document.getElementById('finder-body') ? new HubFinder(this, { previewFs: options.previewFs }) : null;
        this.memos = typeof HubMemos !== 'undefined' && document.getElementById('memo-body') ? new HubMemos(this, { previewMemos: options.previewMemos }) : null;
        this.github = typeof HubGitHub !== 'undefined' && document.getElementById('gh-body') ? new HubGitHub(this) : null;
        this.browser = typeof HubBrowser !== 'undefined' && document.getElementById('br-body') ? new HubBrowser(this) : null;
    }

    // ---------------------------------------------------------------------
    // 왼쪽 탭 (세션 · 파인더 · 메모)
    // ---------------------------------------------------------------------
    setLeftTab(tab) {
        this.leftTab = tab;
        document.querySelectorAll('.hub-tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
        document.querySelectorAll('.hub-left .hub-panel').forEach(p => { p.hidden = p.id !== `panel-${tab}`; });
        if (tab === 'finder' && this.finder) this.finder.show();
        if (tab === 'memos' && this.memos) this.memos.show();
        if (tab === 'github' && this.github) this.github.show();
        if (tab === 'browser' && this.browser) this.browser.show();
    }

    // ---------------------------------------------------------------------
    // 첨부 · 입력창에 넣기
    // ---------------------------------------------------------------------
    addAttachments(paths) {
        const s = this._selSession();
        if (!s && !this.newFolder) { this.map._toast('먼저 세션을 고르거나 새 세션을 시작하세요'); return; }
        for (const p of paths) if (p && !this.attachments.includes(p)) this.attachments.push(p);
        this._renderAttachments();
        this._renderComposer();
        this.map._toast(`첨부했어요 (${this.attachments.length}개)`);
    }

    _renderAttachments() {
        const box = this.el('hub-attach');
        if (!box) return;
        const esc = SessionMindMap._esc;
        box.hidden = !this.attachments.length;
        box.innerHTML = this.attachments.map((p, i) => `<span class="hub-chip" title="${esc(p)}"><span>📎 ${esc(SessionMindMap._base(p))}</span><button data-i="${i}" aria-label="첨부 빼기">×</button></span>`).join('');
    }

    /** 입력창 내용을 이 글로 바꿔 바로 보낸다 (세션을 안 골랐으면 안내만) */
    sendNow(text) {
        const input = this.el('hub-input');
        if (!input || input.disabled) { this.map._toast('먼저 세션을 고르거나 새 세션을 시작하세요'); return; }
        if (this.run && !this.run.done) { this.map._toast('보내는 중이에요. 끝나면 다시 눌러 주세요'); return; }
        input.value = text;
        this.send();
    }

    insertText(text) {
        const input = this.el('hub-input');
        if (!input) return;
        if (input.disabled) { this.map._toast('먼저 세션을 고르거나 새 세션을 시작하세요'); return; }
        const a = input.selectionStart ?? input.value.length, b = input.selectionEnd ?? input.value.length;
        input.value = input.value.slice(0, a) + text + input.value.slice(b);
        input.selectionStart = input.selectionEnd = a + text.length;
        input.focus();
    }

    // 파인더 항목 또는 맥 Finder 의 파일을 끌어다 놓기: 대화창 = 첨부, 세션(목록·맵) = 그 세션을 고르고 첨부
    _bindFiles() {
        const pathsOf = dt => {
            const raw = dt.getData(typeof MINDMAP_PATHS !== 'undefined' ? MINDMAP_PATHS : 'application/x-mindmap-paths');
            if (raw) { try { return JSON.parse(raw); } catch { return []; } }
            const out = [];
            let webUtils = null;
            try { webUtils = typeof require === 'function' ? require('electron').webUtils : null; } catch { /* 브라우저 */ }
            for (const f of dt.files || []) {
                const p = (webUtils && webUtils.getPathForFile ? webUtils.getPathForFile(f) : '') || f.path || '';
                if (p) out.push(p);
            }
            return out;
        };
        const isFileDrag = dt => dt && [...(dt.types || [])].some(t => t === 'Files' || t === 'application/x-mindmap-paths');
        const targetOf = e => {
            const el = e.target.closest ? e.target : e.target.parentElement;
            if (!el) return null;
            if (el.closest('#hub-composer') || el.closest('#hub-messages')) return { kind: 'composer', el: this.el('hub-composer') };
            const item = el.closest('.hub-item');
            if (item) return { kind: 'session', el: item, root: item.dataset.root, id: item.dataset.id };
            const g = el.closest('.smm-session');
            if (g) {
                const n = this.map.byKey.get(g.dataset.key);
                if (n) return { kind: 'session', el: g, root: n.project.root, id: n.data.id };
            }
            return null;
        };
        let marked = null;
        const unmark = () => { if (marked) marked.classList.remove('hub-drop-target'); marked = null; };
        document.addEventListener('dragover', e => {
            if (!isFileDrag(e.dataTransfer)) return;
            e.preventDefault(); // 이게 없으면 Electron 이 파일을 창에 열어 버린다
            const t = targetOf(e);
            e.dataTransfer.dropEffect = t ? 'copy' : 'none';
            if (!t || t.el !== marked) { unmark(); if (t) { marked = t.el; marked.classList.add('hub-drop-target'); } }
        });
        document.addEventListener('dragleave', e => { if (!e.relatedTarget) unmark(); });
        document.addEventListener('drop', e => {
            if (!isFileDrag(e.dataTransfer)) return;
            e.preventDefault();
            unmark();
            document.body.classList.remove('hub-dragging-file');
            const t = targetOf(e);
            const paths = pathsOf(e.dataTransfer);
            if (!t || !paths.length) return;
            if (t.kind === 'session') this.selectSession(t.root, t.id);
            this.addAttachments(paths);
        });
        this.el('hub-attach').addEventListener('click', e => {
            const b = e.target.closest('button[data-i]');
            if (!b) return;
            this.attachments.splice(+b.dataset.i, 1);
            this._renderAttachments();
            this._renderComposer();
        });
        document.querySelectorAll('.hub-tabs [role=tab]').forEach(b => b.addEventListener('click', () => this.setLeftTab(b.dataset.tab)));
    }

    /** 보낼 글에 첨부 경로를 붙인다 */
    static withAttachments(text, paths) {
        if (!paths || !paths.length) return text;
        const body = text && text.trim() ? text : '첨부한 파일을 봐줘.';
        return `${body}\n\n첨부 파일:\n${paths.map(p => `- ${p}`).join('\n')}`;
    }

    // ---------------------------------------------------------------------
    // 시작, 데이터
    // ---------------------------------------------------------------------
    start() {
        this.map._build();
        if (this.ipc) {
            this.ipc.on('sessions:index-result', (e, data) => this._onIndex(data));
            this.ipc.on('sessions:transcript-result', (e, r) => this._onTranscript(r));
            this.ipc.on('sessions:run-event', (e, r) => this._onRunEvent(r));
            this.ipc.on('sessions:run-exit', (e, r) => this._onRunExit(r));
            this.ipc.on('sessions:hub-result', (e, r) => this._onHub(r));
            this.ipc.on('sessions:changed', (e, r) => this._onChanged(r));
            this.ipc.on('usage:result', (e, r) => { this.usage = r; this._renderUsage(); });
            // 고른(또는 새로 만든) 폴더: 목록을 다시 읽어 폴더가 보이게 하고 그 폴더에 새 세션 자리를 연다
            this.ipc.on('sessions:pick-folder-result', (e, r) => {
                if (!r || !r.path) return;
                this.newFolder = r.path;
                this._afterIndex = () => this.newSessionIn(r.path);
                this.refresh();
            });
            this.refresh();
            this._poll = setInterval(() => this._pollTranscript(), 4000);
            // 사용량: 2분마다, 창으로 돌아올 때, 보내기가 끝날 때
            this.readUsage();
            this._cachePoll = setInterval(() => this._tickCache(), 15000);
            this._usagePoll = setInterval(() => { if (!document.hidden) this.readUsage(); }, 120000);
            window.addEventListener('focus', () => { if (!this.usage || Date.now() - this.usage.at > 30000) this.readUsage(); });
        }
    }

    refresh() {
        if (this.ipc) this.ipc.send('sessions:index', {});
    }

    readUsage() {
        if (this.ipc) this.ipc.send('usage:read');
        else if (this.previewUsage) { this.usage = this.previewUsage; this._renderUsage(); }
    }

    // 가운데 칸 오른쪽 위: 세션(5시간) · 주간 한도, 남은 % 막대
    _renderUsage() {
        const el = this.el('hub-usage');
        if (!el) return;
        const u = this.usage;
        if (!u) { el.innerHTML = '<span class="u-err">사용량 읽는 중…</span>'; return; }
        if (!u.ok) { el.innerHTML = `<span class="u-err">사용량: ${SessionMindMap._esc(u.error || '알 수 없음')}</span>`; el.title = '눌러서 다시 읽기'; return; }
        const now = this.now();
        const when = ms => {
            if (!ms) return '';
            const d = new Date(ms), p = v => String(v).padStart(2, '0');
            const same = new Date(now).toDateString() === d.toDateString();
            return same ? `${p(d.getHours())}:${p(d.getMinutes())}` : `${'일월화수목금토'[d.getDay()]} ${p(d.getHours())}:${p(d.getMinutes())}`;
        };
        const row = (label, b) => {
            if (!b) return '';
            const tone = b.left < 20 ? 'u-low' : b.left < 50 ? 'u-mid' : '';
            return `<span class="u-row ${tone}" title="${label}: ${b.used}% 사용${b.resetsAt ? ` · ${new Date(b.resetsAt).toLocaleString()} 초기화` : ''}">
                <span class="u-label">${label}</span><span class="u-bar"><span class="u-fill" style="width:${b.left}%"></span></span>
                <span class="u-text"><b>${Math.round(b.left)}%</b> 남음${b.resetsAt ? ` <span class="u-reset">· ${when(b.resetsAt)}</span>` : ''}</span></span>`;
        };
        el.innerHTML = row('세션', u.session) + row('주간', u.week);
        el.title = `Claude 사용량 · ${SessionMindMap._ago(u.at, now)} 기준 · 눌러서 새로고침`;
    }

    setData(data) { this._onIndex(data); if (!this.ipc) this.readUsage(); }

    _onIndex(data) {
        if (!data || data.success === false) {
            this.el('hub-list-body').innerHTML = `<p class="hub-empty">세션 기록을 읽지 못했어요${data && data.error ? `: ${SessionMindMap._esc(data.error)}` : ''}</p>`;
            return;
        }
        this.data = data;
        // 맵은 허브가 직접 데이터를 넣는다 (맵 자체 IPC 응답은 같은 데이터라 무해)
        this.map.loading = false;
        this.map.data = data;
        this.map._fitPending = true;
        if (this.sel && !this._selProject()) this.sel = null;
        this._applyCenter(false);
        this._renderList();
        this._renderChat();
        if (this._afterIndex) { const f = this._afterIndex; this._afterIndex = null; f(); }
        if (this.sel && this.sel.id) this._loadTranscript(true);
    }

    _selProject() { return this.sel && this.data && this.data.projects.find(p => p.root === this.sel.root); }
    _selSession() {
        const p = this._selProject();
        return p && this.sel.id ? p.sessions.find(s => s.id === this.sel.id) : null;
    }

    // ---------------------------------------------------------------------
    // 고르기
    // ---------------------------------------------------------------------
    selectSession(root, id) {
        if (this.map.pendingRoot && !(this.run && !this.run.done && !this.run.sessionId)) this.map.pendingRoot = null;
        const changed = !this.sel || this.sel.root !== root || this.sel.id !== id;
        this.sel = { root, id };
        if (changed) { this.transcript = null; this.newFolder = null; this.toonAsk = false; this.newMeta = null; }
        if (this.center === 'all') this.center = 'session';
        this._applyCenter(true);
        this._renderList();
        this._renderChat();
        this._loadTranscript(true);
        if (this.leftTab === 'github' && this.github) this.github.show();
    }

    selectFolder(root) {
        this.sel = { root };
        this.newMeta = null;
        this.transcript = null;
        this.newFolder = root;
        this.center = 'project';
        this._applyCenter(true);
        this._renderList();
        this._renderChat();
    }

    newSession() {
        const p = this._selProject();
        const root = p ? p.root : (this.data && this.data.projects[0] ? this.data.projects[0].root : null);
        if (root) this.newSessionIn(root);
    }

    /**
     * ⊕ : 새 세션 자리를 만들고 입력창으로 간다. 첫 메시지를 보내면 claude 가 세션을 만든다.
     * meta = 폴더 ⊕ 는 없음, 주제 가지 ⊕ 는 { topic }, 세션 ⊕ 는 { parentId, topic } (하위 세션)
     */
    newSessionIn(root, meta) {
        this.newMeta = meta && (meta.topic || meta.parentId) ? { ...meta } : null;
        if (this.newMeta && this.newMeta.topic) { this.newTopic = this.newMeta.topic; this.toonStart = true; }
        this.newFolder = root;
        this.sel = { root };
        this.transcript = null;
        this.map.pendingRoot = root;
        this.map.pendingMeta = this.newMeta;
        if (this.center === 'session') this.center = 'project';
        this._applyCenter(true);
        this._renderList();
        this._renderChat();
        const input = this.el('hub-input');
        if (input) input.focus();
    }

    _onMapSelect(n) {
        // 가운데 원: 툰 허브 보기
        if (n.isRoot) {
            if (n.kind === 'all') this.showHubList();
            else this.showHub(n.kind === 'project' ? n.data.root : n.project.root);
            return true;
        }
        if (n.kind === 'session') {
            this.selectSession(n.project.root, n.data.id);
            return true;
        }
        if (n.kind === 'project' && !n.isRoot) {
            this.selectFolder(n.data.root);
            return true;
        }
        if (n.kind === 'topic') { // 주제 가지: 그 주제 허브 보기
            this.showHub(n.project.root, n.topic);
            return true;
        }
        return false; // 파일, 가운데 노드는 맵의 정보 패널이 맡는다
    }

    setCenter(mode) {
        this.center = mode;
        this._applyCenter(true);
    }

    _applyCenter(fit) {
        const s = this._selSession();
        let mode = this.center;
        if (mode === 'session' && !s) mode = this.sel ? 'project' : 'all';
        if (mode === 'project' && !this.sel) mode = 'all';
        if (mode === 'all') this.map.setFocus('all');
        else if (mode === 'project') this.map.setFocus('project', this.sel.root);
        else this.map.setFocus('session', this.sel.root, s.id);
        if (!fit) this.map._fitPending = true;
        document.querySelectorAll('.hub-seg button').forEach(b => {
            b.setAttribute('aria-pressed', String(b.dataset.center === mode));
            b.disabled = (b.dataset.center === 'session' && !s) || (b.dataset.center === 'project' && !this.sel);
        });
        const p = this._selProject();
        this.el('hub-map-caption').textContent =
            mode === 'session' ? `세션 중심 · ${s.title}` : mode === 'project' ? `폴더 중심 · ${p.name}` : '전체 · 모든 폴더';
    }

    // ---------------------------------------------------------------------
    // 왼쪽: 세션 목록
    // ---------------------------------------------------------------------
    _renderList() {
        const esc = SessionMindMap._esc;
        const body = this.el('hub-list-body');
        if (!this.data) { body.innerHTML = '<p class="hub-empty">세션 기록 읽는 중…</p>'; return; }
        const q = this.listQuery;
        const now = this.now();
        const rows = [];
        for (const p of this.data.projects) {
            for (const s of p.sessions) {
                if (q && !s.title.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q)) continue;
                rows.push({ p, s });
            }
        }
        // 폴더별 보기에서는 세션이 없는 폴더(새로 더한 폴더)도 보인다
        const emptyFolders = this.group === 'folder' ? this.data.projects.filter(p => !p.sessions.length && !p.remoteOnly && (!q || p.name.toLowerCase().includes(q))) : [];
        if (!rows.length && !emptyFolders.length) { body.innerHTML = `<p class="hub-empty">${q ? '찾는 세션이 없어요' : '아직 세션 기록이 없어요'}</p>`; return; }

        const item = ({ p, s, depth, prevCount, isPrev }) => {
            const on = this.sel && this.sel.root === p.root && this.sel.id === s.id;
            const chainKey = `${p.root}::${s.id}`;
            const chain = prevCount ? `<span class="hub-chain-toggle" role="button" tabindex="0" data-chain="${esc(chainKey)}" title="툰으로 이어진 이전 세션">${this.openChains.has(chainKey) ? '▾' : '▸'} 이전 ${prevCount}</span>` : '';
            const alarm = SessionMindMap.alarm(s, now);
            const ctx = SessionMindMap.contextInfo(s);
            return `<button class="hub-item${on ? ' is-on' : ''}${alarm ? ' is-alarm' : ''}${isPrev ? ' is-prev' : ''}"${s.remote ? '' : ' draggable="true"'} data-root="${esc(p.root)}" data-id="${esc(s.id)}" title="${esc(s.title)}"${depth ? ` style="padding-left:${8 + depth * 16}px"` : ''}>
                <i class="hub-dot hub-${s.status}" style="--c:${this.map._colorOf(p)}"></i>
                <span class="hub-item-title">${isPrev ? '↑ ' : ''}${esc(s.title)}</span>
                <span class="hub-item-sub">${chain}${this.group === 'recent' ? `${esc(p.name)} · ` : ''}${SessionMindMap._ago(s.lastAt, now)}${s.kind === 'chat' ? ' · <b class="hub-kind-chat">대화</b>' : ''}${ctx ? ` · <b class="hub-ctx-${ctx.phase}">${Math.round(ctx.pct * 100)}%</b>` : ''}${s.git ? ` · <b class="smm-git-${s.git}">${SessionMindMap.GIT[s.git]}</b>` : ''}${s.remote ? ` · ${esc(s.machine)}` : ''}</span>
            </button>`;
        };

        let html = '';
        if (this.group === 'folder') {
            const byRoot = new Map();
            for (const p of this.data.projects) if (emptyFolders.includes(p) || rows.some(r => r.p === p)) byRoot.set(p, []); // 폴더 순서는 최근 순 그대로
            rows.forEach(r => { if (!byRoot.has(r.p)) byRoot.set(r.p, []); byRoot.get(r.p).push(r); });
            for (const [p, flat] of byRoot) {
                const on = this.sel && this.sel.root === p.root && !this.sel.id;
                const { branches, loose, empty, count } = SessionHub.listTree(p, flat.map(r => r.s), this.openChains, !!q);
                const rowsHtml = list => list.map(x => item({ p, ...x })).join('');
                let body = '';
                for (const b of branches) {
                    const tOn = this.hubView && this.hubView.root === p.root && this.hubView.topic === b.topic;
                    body += `<div class="hub-branch">
                        <div class="hub-topic-row"><button class="hub-topic${tOn ? ' is-on' : ''}" data-root="${esc(p.root)}" data-topic="${esc(b.topic)}" title="${esc(b.title)} 주제 허브 보기">${esc(b.title)}<span class="hub-count">${b.count}</span></button>
                        <button class="hub-topic-add" data-root="${esc(p.root)}" data-topic="${esc(b.topic)}" title="${esc(b.title)} 가지에 새 세션" aria-label="${esc(b.title)} 가지에 새 세션">+</button></div>
                        ${rowsHtml(b.rows)}</div>`;
                }
                if (loose.length) body += `${branches.length ? '<div class="hub-loose">가지 없음</div>' : ''}${rowsHtml(loose)}`;
                if (empty.length) body += `<div class="hub-empty-branches">빈 가지 ${empty.map(b => `<button class="hub-topic-add hub-chip-btn" data-root="${esc(p.root)}" data-topic="${esc(b.topic)}" title="${esc(b.title)} 가지에 첫 세션">${esc(b.title)} +</button>`).join('')}</div>`;
                html += `<div class="hub-group">
                    <button class="hub-folder${on ? ' is-on' : ''}" data-folder="${esc(p.root)}" title="${esc(p.root)}">
                      <i class="hub-swatch" style="background:${this.map._colorOf(p)}"></i>${esc(p.name)}<span class="hub-count">${count}</span>
                    </button><button class="hub-add" data-add="${esc(p.root)}" title="이 폴더에 새 세션" aria-label="${esc(p.name)} 폴더에 새 세션">+</button>${body}</div>`;
            }
        } else {
            const day = 864e5;
            const start = new Date(now); start.setHours(0, 0, 0, 0);
            const t0 = start.getTime();
            const buckets = [['오늘', t0], ['어제', t0 - day], ['이번 주', t0 - 6 * day], ['그 전', -Infinity]];
            rows.sort((a, b) => b.s.lastAt - a.s.lastAt);
            let bi = -1;
            for (const r of rows) {
                let k = buckets.findIndex(([, from]) => r.s.lastAt >= from);
                if (k !== bi) { html += `<div class="hub-bucket">${buckets[k][0]}</div>`; bi = k; }
                html += item(r);
            }
        }
        body.innerHTML = html;
    }

    // ---------------------------------------------------------------------
    // 오른쪽: 대화창
    // ---------------------------------------------------------------------
    _loadTranscript(force) {
        const s = this._selSession();
        if (s && s.remote) return; // 다른 기기 세션: 대화 기록은 그 기기에만 있다
        if (s && !this.ipc && this.previewTranscripts) {
            const messages = this.previewTranscripts[s.id] || [];
            this._onTranscript({ file: s.file, messages, truncated: false, mtimeMs: 0 });
            return;
        }
        if (!s || !this.ipc) return;
        this.ipc.send('sessions:transcript', { file: s.file, sinceMtime: force ? 0 : (this.transcript && this.transcript.file === s.file ? this.transcript.mtimeMs : 0) });
    }

    _pollTranscript() {
        if (document.hidden) return;
        if (this._selSession()) this._loadTranscript(false);
    }

    _onTranscript(r) {
        const s = this._selSession();
        if (!r || !s || r.file !== s.file) return;
        if (r.unchanged) return;
        if (r.error) { this.transcript = { file: r.file, messages: [], error: r.error }; this._renderChat(); return; }
        const box = this.el('hub-messages');
        const atBottom = !box || box.scrollHeight - box.scrollTop - box.clientHeight < 40;
        this.transcript = r;
        this._renderMessages(atBottom);
    }

    _renderChat() {
        const esc = SessionMindMap._esc;
        const s = this._selSession();
        const p = this._selProject();
        const head = this.el('hub-chat-head');
        if (s) {
            const resume = `cd ${SessionMindMap._shellQuote(s.cwd)} && claude --resume ${s.id}`;
            head.innerHTML = `<div class="hub-chat-title">${esc(s.title)}</div>
              <div class="hub-chat-meta"><span class="hub-pill hub-${s.status}">${SessionMindMap.STATUS[s.status]}</span>${SessionMindMap.contextInfo(s) ? `<span class="hub-ctxbar hub-ctx-${SessionMindMap.contextInfo(s).phase}" title="세션 분량 ${SessionMindMap._k(SessionMindMap.contextInfo(s).tokens)} / ${SessionMindMap._k(SessionMindMap.contextInfo(s).window)} 토큰 (마지막 답 기준)"><i style="width:${Math.min(100, SessionMindMap.contextInfo(s).pct * 100).toFixed(0)}%"></i><b>${Math.round(SessionMindMap.contextInfo(s).pct * 100)}%</b></span>` : ''}${s.remote ? '' : '<span id="hub-cache" class="hub-cache"></span>'}
                <span>${esc(p.name)}</span>${s.gitBranch ? `<span class="hub-mono">${esc(s.gitBranch)}</span>` : ''}
                ${s.git ? `<span class="smm-git-pill smm-git-${s.git}" title="${SessionMindMap.GIT_LONG[s.git]}">${SessionMindMap.GIT[s.git]}</span>` : ''}
                ${s.costUSD != null ? `<span>$${s.costUSD.toFixed(2)}</span>` : ''}
                ${s.remote ? '' : `<button class="hub-link" data-act="kind" title="대화 세션 / 코드 세션 바꾸기 (지도 모양이 바뀌어요)">${s.kind === 'chat' ? '대화 → 코드로' : '코드 → 대화로'}</button>`}
                <button class="hub-link" data-copy="${esc(resume)}" title="${esc(resume)}">${s.remote ? `${esc(s.machine)} 에서 열기 (명령 복사)` : '터미널 명령 복사'}</button></div>
              ${this.ipc && !s.remote ? `<div class="hub-toon-row"><button class="btn hub-toon" data-act="toon-ask"${this.run && !this.run.done ? ' disabled' : ''} title="툰 저장 후 새 세션에서 이어가기">툰 → 이어가기</button></div>` : ''}
              ${this.toonAsk ? `<div class="hub-confirm" role="group" aria-label="툰 저장 후 이어가기 확인">
                <p>이 세션에 <b>툰 저장</b>을 시키고, 저장 결과의 시작 메시지로 <b>같은 폴더에 새 세션</b>을 열어 이어가요. 툰 저장은 파일을 써야 해서 최소 "파일 수정 자동 허용"으로 실행해요.</p>
                <div class="row"><button class="btn btn-primary" data-act="toon-go">시작</button><button class="btn" data-act="toon-cancel">취소</button></div></div>` : ''}`;
        } else if (this.newFolder) {
            const folders = this.data ? this.data.projects.map(x => x.root) : [];
            if (!folders.includes(this.newFolder)) folders.unshift(this.newFolder);
            const parent = this.newMeta && this.newMeta.parentId && this._selProject() ? this._selProject().sessions.find(x => x.id === this.newMeta.parentId) : null;
            head.innerHTML = `<div class="hub-chat-title">${parent ? `하위 세션 <span class="hub-sub-of">⤷ ${esc(parent.title)}</span>` : '새 세션'}</div>
              <div class="hub-chat-meta"><label for="hub-folder">폴더</label>
                <select id="hub-folder">${folders.map(f => `<option value="${esc(f)}"${f === this.newFolder ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select>
                ${this.ipc ? '<button class="hub-link" data-act="pick-folder">다른 폴더…</button>' : ''}</div>
              ${this._newHub() ? `<div class="hub-chat-meta">
                <label><input type="checkbox" id="hub-toonstart"${this.toonStart ? ' checked' : ''}> 툰 허브 읽고 시작</label>
                ${this._newHub().topics.length ? `<label for="hub-topic">주제</label><select id="hub-topic"><option value="">(프로젝트 허브)</option>${this._newHub().topics.map(t => `<option value="${esc(t)}"${t === this.newTopic ? ' selected' : ''}>${esc((this._newHub().titles || {})[t] || t)}</option>`).join('')}</select>` : ''}
              </div>` : ''}`;
        } else {
            head.innerHTML = `<div class="hub-chat-title">대화</div><div class="hub-chat-meta">왼쪽에서 세션을 고르거나 새 세션을 시작하세요</div>`;
        }
        this._renderMessages(true);
        this._renderComposer();
        this._tickCache();
    }

    _renderMessages(scroll) {
        const box = this.el('hub-messages');
        const s = this._selSession();
        let html = '';
        if (s && s.remote) {
            const resume = `cd ${SessionMindMap._shellQuote(s.cwd)} && claude --resume ${s.id}`;
            html = `<div class="hub-welcome"><p><b>${SessionMindMap._esc(s.machine)}</b> 의 세션이에요. 대화 기록은 그 기기에만 있어서 여기서는 목록만 보여요.</p>
              <p>그 기기 터미널에서 이어서 하세요: <code>${SessionMindMap._esc(resume)}</code></p></div>`;
        } else if (s) {
            if (!this.transcript || this.transcript.file !== s.file) html = '<p class="hub-empty">대화 불러오는 중…</p>';
            else if (this.transcript.error) html = `<p class="hub-empty">대화를 읽지 못했어요: ${SessionMindMap._esc(this.transcript.error)}</p>`;
            else {
                if (this.transcript.truncated) html += '<p class="hub-note">앞부분은 생략했어요 (최근 메시지만 보여요)</p>';
                const modes = SessionHub.answerModes(this.transcript.messages, SessionHub._answerLog()[s.id]);
                html += this.transcript.messages.map((m, i) => this._msgHtml(m, modes[i])).join('');
            }
        } else if (!this.newFolder) {
            html = `<div class="hub-welcome"><p>세션을 고르면 여기서 대화를 보고 이어서 말할 수 있어요.</p>
              <p>보낸 메시지는 그 세션을 <code>claude --resume</code> 으로 이어서 실행해요.</p></div>`;
        }
        const msgs = this.transcript && s && this.transcript.file === s.file ? this.transcript.messages || [] : [];
        // 끝난 실행이 기록 파일에 이미 들어왔으면 실시간 칸은 빼서 같은 답이 두 번 안 보이게
        const live = this.run && this._runBelongsHere() && !SessionHub.runRecorded(this.run, msgs);
        if (live) html += this._runHtml();
        // 마지막 답 아래 "자세히": 짧게 받은 답을 다시 풀어 달라고 한다
        const lastIsAnswer = live ? this.run.done && !this.run.stopped : msgs.length && msgs[msgs.length - 1].role === 'assistant';
        if (s && !s.remote && this.ipc && lastIsAnswer) html += '<button class="btn hub-more" data-act="more" title="방금 답을 자세히 다시 설명해 달라고 보내요">자세히 설명해 줘</button>';
        box.innerHTML = html || '<p class="hub-empty">첫 메시지를 보내면 새 세션이 시작돼요</p>';
        if (scroll) box.scrollTop = box.scrollHeight;
    }

    /**
     * 끝난 실행이 세션 기록에 들어왔는지: 보낸 시각 뒤(5초 여유)의 사람 메시지와 그 뒤 Claude 답이 있으면 들어온 것.
     * 오류(stderr)가 있으면 기록에 없는 정보라 실시간 칸을 남긴다.
     */
    static runRecorded(run, messages) {
        if (!run || !run.done || !messages || !messages.length) return false;
        if (run.events.some(e => e.type === 'stderr' && String(e.text || '').trim())) return false;
        const i = messages.findIndex(m => m.role === 'user' && m.at && m.at >= run.sentAt - 5000);
        return i >= 0 && messages.slice(i + 1).some(m => m.role === 'assistant');
    }

    _runBelongsHere() {
        const s = this._selSession();
        return (s && this.run.sessionId === s.id) || (!this.run.sessionId && this.sel && this.run.root === this.sel.root && !this.sel.id) ||
            (this.run.newSessionId && s && this.run.newSessionId === s.id);
    }

    _msgHtml(m, mode) {
        const esc = SessionMindMap._esc;
        const MAX = 6;
        const shown = (m.tools || []).slice(0, MAX);
        const more = (m.tools || []).length - shown.length;
        const tools = shown.length
            ? `<div class="hub-tools">${shown.map(t => `<span class="hub-tool" title="${esc(t.target)}"><b>${esc(t.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, ''))}</b> ${esc(SessionMindMap._base(t.target) || '')}</span>`).join('')}${more > 0 ? `<span class="hub-tool-more">도구 ${more}개 더</span>` : ''}</div>` : '';
        const time = m.at ? `<time>${SessionMindMap._fmt(m.at)}</time>` : '';
        const tag = mode && m.role === 'assistant' ? `<span class="hub-mode" title="${SessionHub.ANSWER_LABEL[mode]} 버튼으로 받은 답">${SessionHub.ANSWER_LABEL[mode]}</span>` : '';
        return `<div class="hub-msg hub-${m.role}">${tag}${m.text ? `<div class="hub-bubble">${SessionHub.md(m.text)}</div>` : ''}${tools}${time}</div>`;
    }

    _runHtml() {
        const r = this.run;
        const parts = [{ role: 'user', text: r.text, tools: [] }];
        const a = { role: 'assistant', text: '', tools: [] };
        for (const e of r.events) {
            if (e.type === 'assistant' && e.message && Array.isArray(e.message.content)) {
                for (const b of e.message.content) {
                    if (b.type === 'text' && b.text) a.text += (a.text ? '\n\n' : '') + b.text;
                    if (b.type === 'tool_use') a.tools.push({ name: b.name, target: (b.input && (b.input.file_path || b.input.command || b.input.pattern || b.input.path)) || '' });
                }
            }
        }
        const err = r.events.filter(e => e.type === 'stderr').map(e => e.text).join('').trim();
        const res = r.events.find(e => e.type === 'result');
        let status = r.done ? (r.stopped ? '멈췄어요' : res && res.is_error ? '오류로 끝났어요' : '끝났어요') : '실행 중…';
        if (r.done && !res && !r.stopped) status = '응답 없이 끝났어요';
        return `<div class="hub-live">${r.label ? `<div class="hub-step">${SessionMindMap._esc(r.label)}</div>` : ''}${this._msgHtml(parts[0])}${a.text || a.tools.length ? this._msgHtml(a, r.answerMode) : ''}
            <div class="hub-runstate${r.done ? '' : ' is-running'}">${status}${res && res.total_cost_usd != null ? ` · $${res.total_cost_usd.toFixed(2)}` : ''}</div>
            ${err && (r.done || !a.text) ? `<pre class="hub-err">${SessionMindMap._esc(err.slice(-1500))}</pre>` : ''}</div>`;
    }

    // 새 세션을 열 폴더의 툰 허브 (없으면 null)
    _newHub() {
        if (this._selSession() || !this.data) return null;
        const p = this.data.projects.find(x => x.root === this.newFolder || x.root === (this.sel && this.sel.root));
        return p && p.hub ? p.hub : null;
    }

    /** 새 세션 첫 메시지: 툰 허브를 읽게 하고, 쓴 글은 이번 할 일(hub_task)로 넘긴다 */
    static toonStartPrompt(cwd, topic, task) {
        return `툰 불러와 — 하위 세션, root: ${cwd}${topic ? `, topic: ${topic}` : ''}, hub_task: ${task}`;
    }

    _renderComposer() {
        const s = this._selSession();
        const can = !!(s || this.newFolder) && !!this.ipc && !(s && s.remote);
        const running = this.run && !this.run.done;
        this.el('hub-input').disabled = !can || running;
        this.el('hub-input').placeholder = !this.ipc ? '미리보기에서는 보낼 수 없어요'
            : s && s.remote ? `${s.machine} 의 세션은 그 기기에서 이어서 말할 수 있어요`
            : s ? `"${SessionMindMap._clip(s.title, 24)}" 에 이어서 말하기 (⌘↩ 보내기)` // 어느 세션으로 가는지 보이게
            : this.newFolder ? (this._newHub() && this.toonStart ? '세션 제목이나 할 일만 쓰세요 · 툰 허브를 읽고 시작해요 (⌘↩)' : '새 세션 첫 메시지 (⌘↩ 보내기)')
            : '왼쪽에서 세션을 고르세요';
        this.el('hub-send').hidden = running;
        this.el('hub-send').disabled = !can;
        this.el('hub-send').title = s ? `보낼 곳: ${s.title}` : this.newFolder ? `새 세션 · ${this.newFolder}` : '';
        this.el('hub-stop').hidden = !running;
    }

    /** 선택한 세션의 마지막 메시지 시각 (보내는 중이면 지금) */
    _lastActivity(s) {
        let t = s.lastAt || 0;
        const msgs = this.transcript && this.transcript.file === s.file ? this.transcript.messages || [] : [];
        if (msgs.length) t = Math.max(t, msgs[msgs.length - 1].at || 0);
        if (this.run && this._runBelongsHere()) t = Math.max(t, this.run.done ? this.run.sentAt : this.now());
        return t;
    }

    /** 캐시 타이머: 대화창 머리의 남은 시간, 55분부터 깜박 + 툰 버튼 강조. 깜박이는 세션이 바뀌면 목록·맵도 다시 그린다 */
    _tickCache() {
        const now = this.now();
        const s = this._selSession();
        const pill = this.el('hub-cache');
        if (pill && s) {
            const ttl = SessionMindMap.cacheMs(s);
            const { phase, left } = SessionMindMap.cachePhase(this._lastActivity(s), now, ttl);
            const min = Math.ceil(left / 60e3);
            const alarm = SessionMindMap.alarm({ ...s, lastAt: this._lastActivity(s) }, now);
            pill.className = `hub-cache hub-cache-${phase}${alarm ? ' is-alarm' : ''}`;
            pill.textContent = alarm === 'full' ? '툰 할 때 · 세션 거의 참' : alarm ? `툰 할 때 · 캐시 ${min}분` : phase === 'over' ? '캐시 지남' : `캐시 ${min}분`;
            pill.title = phase === 'over' ? '캐시가 끝나 다음 메시지는 앞 대화를 다시 비싸게 읽어요'
                : `마지막 메시지 뒤 ${ttl / 60e3}분까지 캐시로 싸게 이어가요 · ${min}분 남음`;
            const toon = document.querySelector('[data-act="toon-ask"]');
            if (toon) toon.classList.toggle('is-blink', !!alarm);
        }
        if (!this.data) return;
        const sig = this.data.projects.flatMap(p => p.sessions)
            .filter(x => SessionMindMap.alarm(x, now)).map(x => x.id).join();
        if (sig !== this._cacheSig) {
            const first = this._cacheSig === undefined;
            this._cacheSig = sig;
            if (!first) { this._renderList(); this.map.render(); }
        }
    }

    /**
     * 왼쪽 목록(폴더별): 가지 → 줄기 맨 끝 세션(이전 N, 펼치면 앞 세션) → 하위 세션
     * @returns {{ branches: [{topic, title, count, rows}], loose: rows, empty: [{topic, title}], count }}
     *   rows = [{ s, depth, prevCount, isPrev }]
     */
    static listTree(p, sessions, openChains = new Set(), searching = false) {
        const { heads, headOf } = SessionMindMap.chains(sessions);
        const byTime = list => [...list].sort((a, b) => b.lastAt - a.lastAt);
        const headIds = new Set(heads.keys());
        const kids = new Map();
        const top = [];
        for (const s of byTime(sessions.filter(x => headIds.has(x.id)))) {
            const pid = s.parentId && (headOf.get(s.parentId) || s.parentId);
            if (pid && pid !== s.id && headIds.has(pid)) { if (!kids.has(pid)) kids.set(pid, []); kids.get(pid).push(s); } else top.push(s);
        }
        const walk = (s, depth, out) => {
            const prev = heads.get(s.id) || [];
            out.push({ s, depth, prevCount: prev.length, isPrev: false });
            if (prev.length && openChains.has(`${p.root}::${s.id}`)) [...prev].reverse().forEach(x => out.push({ s: x, depth: depth + 1, prevCount: 0, isPrev: true }));
            (kids.get(s.id) || []).forEach(k => walk(k, depth + 1, out));
            return out;
        };
        const hub = p.hub || { topics: [], titles: {} };
        const names = [...new Set([...(hub.topics || []), ...top.map(s => s.topic).filter(Boolean)])];
        const title = t => (hub.titles || {})[t] || t;
        const branches = [], empty = [], loose = [];
        for (const t of names) {
            const mine = top.filter(s => s.topic === t);
            if (!mine.length) { if (!searching) empty.push({ topic: t, title: title(t) }); continue; }
            const rows = [];
            mine.forEach(s => walk(s, 1, rows));
            branches.push({ topic: t, title: title(t), count: rows.filter(r => !r.isPrev).length, rows, lastAt: mine[0].lastAt });
        }
        branches.sort((a, b) => b.lastAt - a.lastAt);
        top.filter(s => !s.topic || !names.includes(s.topic)).forEach(s => walk(s, 0, loose));
        return { branches, loose, empty, count: sessions.length };
    }

    /** 답 길이 버튼: 결과만 / 요약 / 자세히 (기억해 둔다) */
    setAnswerMode(mode) {
        this.answerMode = SessionHub.ANSWER_MODES.includes(mode) ? mode : 'summary';
        document.querySelectorAll('.hub-answer button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.answer === this.answerMode)));
        try { localStorage.setItem('hub.answerMode', this.answerMode); } catch { /* 저장 못 해도 이번엔 쓴다 */ }
    }

    static _loadAnswerMode() {
        try {
            const m = localStorage.getItem('hub.answerMode');
            if (SessionHub.ANSWER_MODES.includes(m)) return m;
        } catch { /* 미리보기·테스트 */ }
        return 'summary';
    }

    // 어느 버튼으로 받은 답인지: 기록 파일에는 남지 않으니 보낸 시각과 버튼을 따로 기억한다 (세션 id → [{ at, mode }])
    static _answerLog() {
        try { return JSON.parse(localStorage.getItem('hub.answerLog') || '{}') || {}; } catch { return {}; }
    }

    static _logAnswer(sessionId, at, mode) {
        try {
            const log = SessionHub._answerLog();
            log[sessionId] = [...(log[sessionId] || []), { at, mode }].slice(-100);
            const ids = Object.keys(log);
            if (ids.length > 300) ids.slice(0, ids.length - 300).forEach(id => delete log[id]); // 오래된 세션부터 버린다
            localStorage.setItem('hub.answerLog', JSON.stringify(log));
        } catch { /* 기억 못 해도 보내기는 된다 */ }
    }

    /**
     * 메시지마다 답 길이 표시: 사람 메시지 시각에 가장 가까운 보낸 기록(보낸 뒤 2분 안)을 찾아
     * 그 뒤에 이어지는 Claude 답에 붙인다. 앱 밖(터미널)에서 보낸 메시지는 표시 없음.
     */
    static answerModes(messages, log) {
        const out = new Array(messages.length).fill(null);
        if (!log || !log.length) return out;
        let mode = null;
        messages.forEach((m, i) => {
            if (m.role === 'user') {
                let best = null;
                for (const r of log) {
                    const d = m.at - r.at;
                    if (d >= -5000 && d <= 120000 && (!best || Math.abs(d) < Math.abs(m.at - best.at))) best = r;
                }
                mode = best ? best.mode : null;
            } else out[i] = mode;
        });
        return out;
    }

    /** 마지막 답을 자세히 다시 설명해 달라고 보낸다 (이번 한 번만 자세히) */
    askDetail() {
        const s = this._selSession();
        if (!s || s.remote || !this.ipc || (this.run && !this.run.done)) return;
        this._startRun({ cwd: s.cwd, sessionId: s.id, root: this.sel.root, text: SessionHub.DETAIL_TEXT, permissionMode: this.permission, answerMode: 'detail' });
    }

    send() {
        const input = this.el('hub-input');
        const typed = input.value.trim();
        if ((!typed && !this.attachments.length) || !this.ipc || (this.run && !this.run.done)) return;
        const text = SessionHub.withAttachments(typed, this.attachments);
        const s = this._selSession();
        if (s && s.remote) return; // 다른 기기 세션에는 보낼 수 없다
        const folderSel = this.el('hub-folder');
        const cwd = s ? s.cwd : (folderSel ? folderSel.value : this.newFolder);
        if (!cwd) return;
        const hub = s ? null : this._newHub();
        const first = hub && this.toonStart ? SessionHub.toonStartPrompt(cwd, this.newTopic, text) : text;
        if (!s) this.sel = { root: cwd };
        this._startRun({ cwd, sessionId: s ? s.id : null, root: s ? this.sel.root : cwd, text: first, permissionMode: this.permission });
        input.value = '';
        this.attachments = [];
        this._renderAttachments();
    }

    _startRun({ cwd, sessionId, root, text, permissionMode, label, answerMode, meta }) {
        const runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        // 새 세션이면 끝난 뒤 제자리(하위·줄기·주제)에 붙인다
        if (!sessionId) meta = meta || this.newMeta || null;
        const mode = answerMode || this.answerMode;
        this.run = { runId, text, label, events: [], sessionId, root, done: false, answerMode: mode, sentAt: Date.now(), meta: sessionId ? null : meta };
        if (sessionId) SessionHub._logAnswer(sessionId, this.run.sentAt, mode);
        this.ipc.send('sessions:send', { runId, cwd, sessionId, text, permissionMode, answerMode: mode });
        this._renderMessages(true);
        this._renderComposer();
        return runId;
    }

    // ---------------------------------------------------------------------
    // 세션 끌어다 놓기
    // ---------------------------------------------------------------------
    _onDrop(src, t) {
        const p = src.project, s = src.data;
        if (s.remote) return;
        if (!t) {
            if (s.parentId) this._link(p.root, s.id, null, `떼어냈어요: ${s.title}`);
            return;
        }
        if (t.kind === 'topic') { // 주제 가지 위: 그 가지로 옮긴다 (같은 폴더만)
            if (t.project.root === p.root) this._meta(p.root, s.id, { parentId: null, topic: t.topic }, `${t.label} 가지로 옮겼어요: ${s.title}`);
            return;
        }
        const isSession = t.kind === 'session' || (t.kind === 'root' && t.ref.kind === 'session');
        const ts = isSession ? (t.kind === 'session' ? t.data : t.ref.data) : null;
        const tp = t.kind === 'session' ? t.project : t.kind === 'project' ? t.data : t.ref.kind === 'project' ? t.ref.data : t.ref.project;
        if (tp.root === p.root) {
            // 세션 위 = 그 아래로 (주제도 따라감), 폴더 위 = 가지·부모 없이 폴더 바로 아래로
            if (ts) this._meta(p.root, s.id, { parentId: ts.id, topic: ts.topic || null }, `붙였어요: ${ts.title} 아래에 ${s.title}`);
            else if (s.parentId || s.topic) this._meta(p.root, s.id, { parentId: null, topic: null }, `폴더 바로 아래로 옮겼어요: ${s.title}`);
            return;
        }
        // 다른 폴더: 복사는 파일을 새로 쓰니 한 번 묻는다
        this.dropAsk = { src: { root: p.root, id: s.id, title: s.title }, to: { root: tp.root, name: tp.name }, parent: ts ? { id: ts.id, title: ts.title } : null };
        this._renderDropAsk();
    }

    // 왼쪽 목록에서 끌기: 세션 위 = 하위로, 가지 위 = 그 가지로, 폴더 위 = 폴더 바로 아래(다른 폴더면 복사 묻기)
    _bindListDrag() {
        const TYPE = 'application/x-mindmap-session';
        const body = this.el('hub-list-body');
        if (!body) return;
        const proj = root => this.data && this.data.projects.find(p => p.root === root);
        const targetOf = e => {
            const el = e.target.closest ? e.target : e.target.parentElement;
            const it = el && el.closest('.hub-item');
            if (it) { const p = proj(it.dataset.root), s = p && p.sessions.find(x => x.id === it.dataset.id); return s && !s.remote ? { el: it, t: { kind: 'session', project: p, data: s } } : null; }
            const tp = el && el.closest('.hub-topic');
            if (tp) { const p = proj(tp.dataset.root); return p ? { el: tp, t: { kind: 'topic', project: p, topic: tp.dataset.topic, label: tp.textContent.replace(/\d+$/, '').trim() } } : null; }
            const f = el && el.closest('.hub-folder');
            if (f) { const p = proj(f.dataset.folder); return p && !p.remoteOnly ? { el: f, t: { kind: 'project', data: p } } : null; }
            return null;
        };
        let src = null, marked = null;
        const unmark = () => { if (marked) marked.classList.remove('hub-drop-target'); marked = null; };
        body.addEventListener('dragstart', e => {
            const it = e.target.closest && e.target.closest('.hub-item[draggable="true"]');
            const p = it && proj(it.dataset.root), s = p && p.sessions.find(x => x.id === it.dataset.id);
            if (!s) return;
            src = { project: p, data: s, el: it };
            e.dataTransfer.setData(TYPE, s.id);
            e.dataTransfer.effectAllowed = 'copyMove';
        });
        body.addEventListener('dragover', e => {
            if (!src) return;
            const h = targetOf(e);
            const ok = h && h.el !== src.el;
            if (ok) { e.preventDefault(); e.dataTransfer.dropEffect = h.t.kind === 'project' && h.t.data.root !== src.project.root ? 'copy' : 'move'; }
            if (!ok || h.el !== marked) { unmark(); if (ok) { marked = h.el; marked.classList.add('hub-drop-target'); } }
        });
        body.addEventListener('drop', e => {
            if (!src) return;
            e.preventDefault();
            const h = targetOf(e);
            const from = src;
            unmark(); src = null;
            if (h && h.el !== from.el) this._onDrop(from, h.t);
        });
        body.addEventListener('dragend', () => { unmark(); src = null; });
    }

    _meta(root, id, meta, done) {
        if (!this.ipc) {
            const p = this.data.projects.find(x => x.root === root);
            const s = p && p.sessions.find(x => x.id === id);
            if (s) Object.assign(s, meta);
            this._onIndex(this.data);
            this.map._toast(done);
            return;
        }
        this._pendingToast = done;
        this.ipc.send('sessions:meta', { root, id, ...meta });
    }

    _link(root, id, parentId, done) {
        if (!this.ipc) {
            // 미리보기: 화면에서만 바꾼다
            const p = this.data.projects.find(x => x.root === root);
            const s = p && p.sessions.find(x => x.id === id);
            if (s) s.parentId = parentId;
            this._onIndex(this.data);
            this.map._toast(done);
            return;
        }
        this._pendingToast = done;
        this.ipc.send('sessions:link', { root, id, parentId });
    }

    _renderDropAsk() {
        const el = this.el('hub-drop-ask');
        if (!el) return;
        const a = this.dropAsk;
        if (!a) { el.hidden = true; el.innerHTML = ''; return; }
        const esc = SessionMindMap._esc;
        el.hidden = false;
        const off = this.ipc ? '' : ' disabled';
        el.innerHTML = `<h4>다른 폴더로 옮기기</h4>
            <p><b>${esc(a.src.title)}</b> → <b>${esc(a.to.name)}</b> 폴더${a.parent ? `의 <b>${esc(a.parent.title)}</b> 아래` : ''}로 옮겨요.</p>
            <p class="hub-muted">이동: 같은 세션 그대로 새 폴더로 (원래 폴더에서는 사라져요). 복사: 원본은 두고 새 세션을 하나 더 만들어요 — 그 뒤로는 따로 가요.</p>
            <p class="hub-muted">Claude 데스크톱 앱 세션은 처음 연 폴더를 기억해서, 옮긴 뒤에는 새 폴더에서 새로 열어야 이어져요.</p>
            ${this.ipc ? '' : '<p class="hub-muted">미리보기에서는 옮길 수 없어요 (맥 앱에서 돼요).</p>'}
            <div class="row"><button class="btn btn-primary" data-act="drop-move"${off}>이동</button><button class="btn" data-act="drop-copy"${off}>복사</button><button class="btn" data-act="drop-cancel">취소</button></div>`;
    }

    _onChanged(r) {
        if (!r) return;
        if (!r.ok) { this.map._toast(r.error || '바꾸지 못했어요'); return; }
        const msg = r.action === 'copy' ? '복사했어요. 새 세션으로 이동해요' : r.action === 'move' ? '옮겼어요' : this._pendingToast || (r.quiet ? '' : '바꿨어요');
        this._pendingToast = null;
        if (r.quiet && !msg) { this.refresh(); return; }
        if (r.action === 'copy' || r.action === 'move') {
            this._afterIndex = () => { if (this.data.projects.some(p => p.root === r.root && p.sessions.some(x => x.id === r.id))) this.selectSession(r.root, r.id); };
        }
        this.map._toast(msg);
        this.refresh();
    }

    // ---------------------------------------------------------------------
    // 툰 허브 보기 (가운데 원을 누르면)
    // ---------------------------------------------------------------------
    showHub(root, topic) {
        this.hubView = { root, topic: topic || null, loading: true };
        this._renderHub();
        if (this.ipc) this.ipc.send('sessions:hub', { root, topic: topic || null });
        else if (this.previewHubs) {
            const h = this.previewHubs[root];
            if (!h) this._onHub({ root, topic, error: '이 폴더에는 툰 허브(.toon/HUB.toon)가 없어요' });
            else this._onHub({ root, topic, path: `${root}/.toon/${topic ? topic + '/' : ''}HUB.toon`, text: topic ? (h.topics[topic] || '') : h.text, topics: Object.keys(h.topics || {}) });
        }
    }

    showHubList() {
        this.hubView = { list: true };
        this._renderHub();
    }

    hideHub() {
        this.hubView = null;
        this._renderHub();
    }

    _onHub(r) {
        if (!this.hubView || this.hubView.root !== r.root || (this.hubView.topic || null) !== (r.topic || null)) return;
        this.hubView = { ...r, topic: r.topic || null };
        this._renderHub();
    }

    _renderHub() {
        const el = this.el('hub-toon-panel');
        if (!el) return;
        const esc = SessionMindMap._esc;
        const v = this.hubView;
        if (!v) { el.hidden = true; el.innerHTML = ''; return; }
        el.hidden = false;
        const close = '<button class="hub-toon-close" data-act="hub-close" aria-label="닫기">×</button>';
        if (v.list) {
            const withHub = (this.data ? this.data.projects : []).filter(p => p.hub);
            el.innerHTML = `${close}<h3>툰 허브</h3><p class="hub-muted">폴더를 고르면 그 폴더의 HUB.toon 을 보여줘요.</p>
              ${withHub.length ? `<ul class="hub-toon-list">${withHub.map(p => `<li><button class="hub-link" data-act="hub-open" data-root="${esc(p.root)}">${esc(p.name)}</button>
                <span class="hub-muted">${p.hub.topics.length ? `주제 ${p.hub.topics.length}개` : ''}</span>
                ${p.hub.next.length ? `<div class="hub-toon-next">${esc(p.hub.next[0])}</div>` : ''}</li>`).join('')}</ul>` : '<p class="hub-muted">툰 허브가 있는 폴더가 없어요.</p>'}`;
            return;
        }
        const p = this.data && this.data.projects.find(x => x.root === v.root);
        const name = p ? p.name : v.root;
        const topics = v.topics || (p && p.hub ? p.hub.topics : []);
        const chips = `<div class="hub-toon-tabs" role="tablist">
            <button role="tab" aria-selected="${!v.topic}" data-act="hub-topic" data-topic="">프로젝트 허브</button>
            ${topics.map(t => `<button role="tab" aria-selected="${v.topic === t}" data-act="hub-topic" data-topic="${esc(t)}">${esc((v.titles || {})[t] || t)}</button>`).join('')}</div>`;
        const body = v.loading ? '<p class="hub-muted">불러오는 중…</p>'
            : v.error ? `<p class="hub-muted">${esc(v.error)}</p>`
            : `<pre class="hub-toon-text">${SessionHub.toonHtml(v.text)}</pre>`;
        el.innerHTML = `${close}<h3>${esc(name)} <span class="hub-muted">툰 허브</span></h3>
            ${v.path ? `<div class="hub-mono hub-muted">${esc(v.path)}</div>` : ''}
            ${topics.length ? chips : ''}${body}`;
    }

    // 툰 글을 읽기 쉽게: NEXT 줄, 제목 줄, [확인]/[가설] 같은 태그를 강조
    static toonHtml(text) {
        const esc = SessionMindMap._esc;
        return String(text || '').split('\n').map(line => {
            let h = esc(line).replace(/\[(확인|가설|변경|모순|읽음|흐림|추정|verify)\]/g, '<span class="t-tag">[$1]</span>');
            if (/NEXT/.test(line)) return `<span class="t-next">${h}</span>`;
            if (/^\s*(#{1,6}\s|[A-Z][A-Z0-9_]{2,}(\[\d+\])?(\{[^}]*\})?:)/.test(line)) return `<span class="t-head">${h}</span>`;
            return h;
        }).join('\n');
    }

    // ---------------------------------------------------------------------
    // 툰 → 이어가기: ① 지금 세션에 툰 저장 ② 답에서 시작 메시지를 뽑아 ③ 같은 폴더에 새 세션
    // ---------------------------------------------------------------------
    toonAndContinue() {
        const s = this._selSession();
        if (!s || !this.ipc || (this.run && !this.run.done)) return;
        this.toonAsk = false;
        const runId = this._startRun({
            cwd: s.cwd, sessionId: s.id, root: this.sel.root, text: SessionHub.TOON_SAVE_TEXT,
            // 툰 저장은 파일을 써야 하므로 최소 "파일 수정 자동 허용"
            permissionMode: this.permission === 'default' ? 'acceptEdits' : this.permission,
            label: '1/2 툰 저장'
        });
        this.toonFlow = { stage: 'save', runId, fromId: s.id, root: this.sel.root, cwd: s.cwd, topic: s.topic || null };
        this._renderChat();
    }

    _toonNext(run) {
        const flow = this.toonFlow;
        const text = run.events.filter(e => e.type === 'assistant' && e.message && Array.isArray(e.message.content))
            .flatMap(e => e.message.content.filter(b => b.type === 'text').map(b => b.text)).join('\n\n');
        const res = run.events.find(e => e.type === 'result');
        const all = text + '\n\n' + (res && typeof res.result === 'string' ? res.result : '');
        if (run.stopped || (res && res.is_error) || !res) {
            this.toonFlow = null;
            this.map._toast(run.stopped ? '툰 저장을 멈췄어요' : '툰 저장이 끝나지 않아서 새 세션을 열지 않았어요');
            return;
        }
        const prompt = SessionHub.nextPrompt(all, `툰 불러와 — root: ${flow.cwd}`);
        flow.stage = 'start';
        flow.prompt = prompt;
        // 새 세션 자리로 옮겨 가서 시작 과정을 보여준다
        this.sel = { root: flow.root };
        this.newFolder = flow.cwd;
        this.transcript = null;
        this.map.pendingRoot = flow.root;
        this._applyCenter(true);
        this._renderList();
        // 새 세션은 원래 세션의 다음 칸(같은 줄기, 같은 주제)
        flow.runId = this._startRun({ cwd: flow.cwd, sessionId: null, root: flow.root, text: prompt, permissionMode: this.permission, label: '2/2 새 세션',
            meta: { prevId: flow.fromId, topic: flow.topic || SessionHub.topicOf(prompt) || undefined } });
        this._renderChat();
    }

    stop() {
        if (this.run && !this.run.done && this.ipc) this.ipc.send('sessions:stop', { runId: this.run.runId });
    }

    _onRunEvent({ runId, event }) {
        if (!this.run || this.run.runId !== runId) return;
        this.run.events.push(event);
        if (event.session_id && !this.run.sessionId && !this.run.newSessionId) {
            this.run.newSessionId = event.session_id;
            SessionHub._logAnswer(event.session_id, this.run.sentAt, this.run.answerMode); // 새 세션은 id 를 알게 된 뒤 기록
        }
        const box = this.el('hub-messages');
        const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 60;
        if (this._runBelongsHere()) this._renderMessages(atBottom);
    }

    _onRunExit({ runId, code, stopped, error }) {
        if (!this.run || this.run.runId !== runId) return;
        if (error) this.run.events.push({ type: 'stderr', text: error });
        this.run.done = true;
        this.run.stopped = stopped;
        const run = this.run;
        const newId = run.newSessionId;
        this.readUsage();
        this._renderMessages(true);
        this._renderComposer();
        if (this.toonFlow && this.toonFlow.runId === runId) {
            if (this.toonFlow.stage === 'save') { this._toonNext(run); this.refresh(); return; }
            this.toonFlow = null;
        }
        // 기록 파일이 바뀌었으니 목록과 대화를 다시 읽고, 새 세션이면 그 세션으로 간다
        this._afterIndex = () => {
            if (newId && !run.sessionId) {
                const p = this.data.projects.find(x => x.sessions.some(y => y.id === newId));
                this.map.pendingRoot = null;
                if (p) this.selectSession(p.root, newId);
                const m = run.meta;
                if (p && m && this.ipc) this.ipc.send('sessions:meta', { root: p.root, id: newId, parentId: m.parentId, prevId: m.prevId, topic: m.topic });
            }
        };
        this.refresh();
    }

    // ---------------------------------------------------------------------
    // 이벤트 연결
    // ---------------------------------------------------------------------
    _bind() {
        this.el('hub-list-body').addEventListener('click', e => {
            const add = e.target.closest('.hub-add');
            if (add) return this.newSessionIn(add.dataset.add);
            const chain = e.target.closest('.hub-chain-toggle');
            if (chain) {
                e.stopPropagation();
                if (this.openChains.has(chain.dataset.chain)) this.openChains.delete(chain.dataset.chain); else this.openChains.add(chain.dataset.chain);
                return this._renderList();
            }
            const tAdd = e.target.closest('.hub-topic-add');
            if (tAdd) return this.newSessionIn(tAdd.dataset.root, { topic: tAdd.dataset.topic });
            const topic = e.target.closest('.hub-topic');
            if (topic) return this.showHub(topic.dataset.root, topic.dataset.topic);
            const it = e.target.closest('.hub-item');
            if (it) return this.selectSession(it.dataset.root, it.dataset.id);
            const f = e.target.closest('.hub-folder');
            if (f) this.selectFolder(f.dataset.folder);
        });
        this.el('hub-search').addEventListener('input', e => { this.listQuery = e.target.value.trim().toLowerCase(); this._renderList(); });
        document.querySelectorAll('.hub-group-toggle button').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.group === this.group)));
        document.querySelectorAll('.hub-group-toggle button').forEach(b => b.addEventListener('click', () => {
            this.group = b.dataset.group;
            try { localStorage.setItem('hub.group', this.group); } catch { /* 미리보기 */ }
            document.querySelectorAll('.hub-group-toggle button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            this._renderList();
        }));
        this.el('hub-new').addEventListener('click', () => this.newSession());
        this.el('hub-refresh').addEventListener('click', () => this.refresh());
        const addFolder = this.el('hub-add-folder');
        if (addFolder) addFolder.addEventListener('click', () => { if (this.ipc) this.ipc.send('sessions:pick-folder'); });
        if (this.el('hub-usage')) this.el('hub-usage').addEventListener('click', () => { this.usage = null; this._renderUsage(); this.readUsage(); });
        document.querySelectorAll('.hub-seg button').forEach(b => b.addEventListener('click', () => this.setCenter(b.dataset.center)));
        this.el('hub-send').addEventListener('click', () => this.send());
        this.el('hub-stop').addEventListener('click', () => this.stop());
        this.el('hub-perm').addEventListener('change', e => { this.permission = e.target.value; });
        document.querySelectorAll('.hub-answer button').forEach(b => b.addEventListener('click', () => this.setAnswerMode(b.dataset.answer)));
        this.setAnswerMode(this.answerMode);
        this.el('hub-messages').addEventListener('click', e => { if (e.target.closest('[data-act="more"]')) this.askDetail(); });
        this.el('hub-input').addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.send(); }
        });
        this.el('hub-chat-head').addEventListener('click', e => {
            const c = e.target.closest('[data-copy]');
            if (c) { this._copy(c.dataset.copy); return; }
            const act = e.target.closest('[data-act]');
            if (act && act.dataset.act === 'kind') {
                const s = this._selSession();
                if (s) this._meta(this.sel.root, s.id, { kind: s.kind === 'chat' ? 'code' : 'chat' }, s.kind === 'chat' ? '코드 세션으로 바꿨어요' : '대화 세션으로 바꿨어요');
                return;
            }
            if (act && act.dataset.act === 'toon-ask') { this.toonAsk = true; this._renderChat(); return; }
            if (act && act.dataset.act === 'toon-cancel') { this.toonAsk = false; this._renderChat(); return; }
            if (act && act.dataset.act === 'toon-go') { this.toonAndContinue(); return; }
            if (e.target.closest('[data-act="pick-folder"]') && this.ipc) this.ipc.send('sessions:pick-folder');
        });
        const dropAsk = this.el('hub-drop-ask');
        if (dropAsk) dropAsk.addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            if (b.dataset.act === 'drop-copy' && this.dropAsk && this.ipc) {
                const a = this.dropAsk;
                this.ipc.send('sessions:copy', { root: a.src.root, id: a.src.id, toRoot: a.to.root, parentId: a.parent ? a.parent.id : null });
            }
            if (b.dataset.act === 'drop-move' && this.dropAsk && this.ipc) {
                const a = this.dropAsk;
                this.ipc.send('sessions:move', { root: a.src.root, id: a.src.id, toRoot: a.to.root, parentId: a.parent ? a.parent.id : null });
            }
            this.dropAsk = null;
            this._renderDropAsk();
        });
        const panel = this.el('hub-toon-panel');
        if (panel) panel.addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            if (b.dataset.act === 'hub-close') this.hideHub();
            else if (b.dataset.act === 'hub-open') this.showHub(b.dataset.root);
            else if (b.dataset.act === 'hub-topic' && this.hubView) this.showHub(this.hubView.root, b.dataset.topic || null);
        });
        document.addEventListener('keydown', e => { if (e.key === 'Escape' && this.hubView) this.hideHub(); });
        this.el('hub-chat-head').addEventListener('change', e => {
            if (e.target.id === 'hub-toonstart') { this.toonStart = e.target.checked; this._renderComposer(); return; }
            if (e.target.id === 'hub-topic') { this.newTopic = e.target.value; if (this.newMeta) this.newMeta.topic = e.target.value || undefined; return; }
            if (e.target.id === 'hub-folder') {
                this.newFolder = e.target.value;
                this.newTopic = '';
                this.sel = { root: this.newFolder };
                this.map.pendingRoot = this.newFolder;
                this._applyCenter(true);
                this._renderList();
                this._renderChat();
            }
        });
    }

    async _copy(text) {
        try { await navigator.clipboard.writeText(text); this.map._toast('복사했어요'); }
        catch { this.map._toast(text); }
    }

    /**
     * 툰 저장 답에서 새 세션 시작 메시지를 뽑는다.
     * ① ```toon-next 블록 ② "툰 불러" 가 든 코드 블록 ③ 인라인 코드 ④ "툰 불러" 로 시작하는 줄 ⑤ fallback
     */
    static nextPrompt(text, fallback) {
        const t = String(text || '');
        const tagged = /```toon-next[^\n]*\n([\s\S]*?)```/.exec(t);
        if (tagged && tagged[1].trim()) return tagged[1].trim();
        const blocks = [...t.matchAll(/```[^\n]*\n([\s\S]*?)```/g)].map(m => m[1].trim()).filter(b => /툰\s*불러/.test(b));
        if (blocks.length) return blocks[blocks.length - 1];
        const inline = [...t.matchAll(/`(툰\s*불러[^`\n]+)`/g)].map(m => m[1].trim());
        if (inline.length) return inline[inline.length - 1];
        const line = t.split('\n').map(l => l.trim().replace(/^[`>*-]+\s*|`+$/g, '')).reverse().find(l => /^툰\s*불러/.test(l));
        return line || fallback;
    }

    // 아주 작은 마크다운: 코드 블록, 인라인 코드, 굵게, 줄바꿈
    static md(text) {
        const esc = SessionMindMap._esc;
        const parts = String(text).split(/```/);
        return parts.map((part, i) => {
            if (i % 2 === 1) {
                const body = part.replace(/^[\w+-]*\n/, '');
                return `<pre><code>${esc(body.replace(/\n$/, ''))}</code></pre>`;
            }
            return esc(part)
                .replace(/`([^`\n]+)`/g, '<code>$1</code>')
                .replace(/\*\*([^*\n]+)\*\*/g, '<b>$1</b>')
                .replace(/\n/g, '<br>');
        }).join('');
    }
}

SessionHub.ANSWER_MODES = ['result', 'summary', 'detail'];
/** 시작 메시지의 "topic: X" (SessionIndexer.topicOf 와 같은 규칙) */
SessionHub.topicOf = prompt => { const m = /\btopic:\s*([\w.-]+)/.exec(String(prompt || '')); return m ? m[1] : null; };
SessionHub.ANSWER_LABEL = { result: '결과만', summary: '요약', detail: '자세히' };
SessionHub.DETAIL_TEXT = '방금 답을 자세히 설명해 줘.';
SessionHub.TOON_SAVE_TEXT = '툰 저장해줘. 저장이 끝나면 새 세션에서 이어갈 시작 메시지를 ```toon-next 코드 블록 하나에만 담아서 답의 맨 끝에 보여줘.';

if (typeof window !== 'undefined') window.SessionHub = SessionHub;
if (typeof module !== 'undefined' && module.exports) module.exports = SessionHub;
