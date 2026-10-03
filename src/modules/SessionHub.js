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
        this.group = 'recent';     // recent | folder
        this.listQuery = '';
        this.center = 'all';       // all | project | session
        this.sel = null;           // { root, id? }
        this.transcript = null;    // { file, messages, truncated, mtimeMs }
        this.run = null;           // { runId, text, events[], sessionId, root }
        this.newFolder = null;     // 새 세션을 열 폴더
        this.permission = 'default';
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
            onAddSession: root => this.newSessionIn(root),
            onDropSession: (src, target) => this._onDrop(src, target),
            onSelect: n => this._onMapSelect(n)
        });
        this.attachments = [];     // 대화창에 첨부한 파일 경로
        this.leftTab = 'sessions';
        this._bind();
        this._bindFiles();
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
            const raw = dt.getData(typeof FLOWCODE_PATHS !== 'undefined' ? FLOWCODE_PATHS : 'application/x-flowcode-paths');
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
        const isFileDrag = dt => dt && [...(dt.types || [])].some(t => t === 'Files' || t === 'application/x-flowcode-paths');
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
            this.ipc.on('sessions:pick-folder-result', (e, r) => { if (r && r.path) { this.newFolder = r.path; this._renderChat(); } });
            this.refresh();
            this._poll = setInterval(() => this._pollTranscript(), 4000);
            // 사용량: 2분마다, 창으로 돌아올 때, 보내기가 끝날 때
            this.readUsage();
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
        if (changed) { this.transcript = null; this.newFolder = null; this.toonAsk = false; }
        if (this.center === 'all') this.center = 'session';
        this._applyCenter(true);
        this._renderList();
        this._renderChat();
        this._loadTranscript(true);
        if (this.leftTab === 'github' && this.github) this.github.show();
    }

    selectFolder(root) {
        this.sel = { root };
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

    // 폴더의 + : 그 폴더에 새 세션 자리를 만들고 입력창으로 간다. 첫 메시지를 보내면 claude 가 세션을 만든다
    newSessionIn(root) {
        this.newFolder = root;
        this.sel = { root };
        this.transcript = null;
        this.map.pendingRoot = root;
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
        if (!rows.length) { body.innerHTML = `<p class="hub-empty">${q ? '찾는 세션이 없어요' : '아직 세션 기록이 없어요'}</p>`; return; }

        const item = ({ p, s, depth }) => {
            const on = this.sel && this.sel.root === p.root && this.sel.id === s.id;
            return `<button class="hub-item${on ? ' is-on' : ''}" data-root="${esc(p.root)}" data-id="${esc(s.id)}" title="${esc(s.title)}"${depth ? ` style="padding-left:${8 + depth * 16}px"` : ''}>
                <i class="hub-dot hub-${s.status}" style="--c:${this.map._colorOf(p)}"></i>
                <span class="hub-item-title">${esc(s.title)}</span>
                <span class="hub-item-sub">${this.group === 'recent' ? `${esc(p.name)} · ` : ''}${SessionMindMap._ago(s.lastAt, now)}${s.git ? ` · <b class="smm-git-${s.git}">${SessionMindMap.GIT[s.git]}</b>` : ''}${s.remote ? ` · ${esc(s.machine)}` : ''}</span>
            </button>`;
        };

        let html = '';
        if (this.group === 'folder') {
            const byRoot = new Map();
            rows.forEach(r => { if (!byRoot.has(r.p)) byRoot.set(r.p, []); byRoot.get(r.p).push(r); });
            for (const [p, flat] of byRoot) {
                // 하위 세션은 부모 바로 아래, 들여쓰기
                const ids = new Set(flat.map(r => r.s.id));
                const kids = new Map();
                const roots = [];
                flat.forEach(r => {
                    const pid = r.s.parentId && ids.has(r.s.parentId) ? r.s.parentId : null;
                    if (pid) { if (!kids.has(pid)) kids.set(pid, []); kids.get(pid).push(r); } else roots.push(r);
                });
                const list = [];
                const walk = (r, depth) => { list.push({ ...r, depth }); (kids.get(r.s.id) || []).forEach(k => walk(k, depth + 1)); };
                roots.forEach(r => walk(r, 0));
                const on = this.sel && this.sel.root === p.root && !this.sel.id;
                html += `<div class="hub-group">
                    <button class="hub-folder${on ? ' is-on' : ''}" data-folder="${esc(p.root)}" title="${esc(p.root)}">
                      <i class="hub-swatch" style="background:${this.map._colorOf(p)}"></i>${esc(p.name)}<span class="hub-count">${list.length}</span>
                    </button><button class="hub-add" data-add="${esc(p.root)}" title="이 폴더에 새 세션" aria-label="${esc(p.name)} 폴더에 새 세션">+</button>${list.map(item).join('')}</div>`;
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
              <div class="hub-chat-meta"><span class="hub-pill hub-${s.status}">${SessionMindMap.STATUS[s.status]}</span>
                <span>${esc(p.name)}</span>${s.gitBranch ? `<span class="hub-mono">${esc(s.gitBranch)}</span>` : ''}
                ${s.git ? `<span class="smm-git-pill smm-git-${s.git}" title="${SessionMindMap.GIT_LONG[s.git]}">${SessionMindMap.GIT[s.git]}</span>` : ''}
                ${s.costUSD != null ? `<span>$${s.costUSD.toFixed(2)}</span>` : ''}
                <button class="hub-link" data-copy="${esc(resume)}" title="${esc(resume)}">${s.remote ? `${esc(s.machine)} 에서 열기 (명령 복사)` : '터미널 명령 복사'}</button></div>
              ${this.ipc && !s.remote ? `<div class="hub-toon-row"><button class="btn hub-toon" data-act="toon-ask"${this.run && !this.run.done ? ' disabled' : ''} title="툰 저장 후 새 세션에서 이어가기">툰 → 이어가기</button></div>` : ''}
              ${this.toonAsk ? `<div class="hub-confirm" role="group" aria-label="툰 저장 후 이어가기 확인">
                <p>이 세션에 <b>툰 저장</b>을 시키고, 저장 결과의 시작 메시지로 <b>같은 폴더에 새 세션</b>을 열어 이어가요. 툰 저장은 파일을 써야 해서 최소 "파일 수정 자동 허용"으로 실행해요.</p>
                <div class="row"><button class="btn btn-primary" data-act="toon-go">시작</button><button class="btn" data-act="toon-cancel">취소</button></div></div>` : ''}`;
        } else if (this.newFolder) {
            const folders = this.data ? this.data.projects.map(x => x.root) : [];
            if (!folders.includes(this.newFolder)) folders.unshift(this.newFolder);
            head.innerHTML = `<div class="hub-chat-title">새 세션</div>
              <div class="hub-chat-meta"><label for="hub-folder">폴더</label>
                <select id="hub-folder">${folders.map(f => `<option value="${esc(f)}"${f === this.newFolder ? ' selected' : ''}>${esc(f)}</option>`).join('')}</select>
                ${this.ipc ? '<button class="hub-link" data-act="pick-folder">다른 폴더…</button>' : ''}</div>
              ${this._newHub() ? `<div class="hub-chat-meta">
                <label><input type="checkbox" id="hub-toonstart"${this.toonStart ? ' checked' : ''}> 툰 허브 읽고 시작</label>
                ${this._newHub().topics.length ? `<label for="hub-topic">주제</label><select id="hub-topic"><option value="">(프로젝트 허브)</option>${this._newHub().topics.map(t => `<option value="${esc(t)}"${t === this.newTopic ? ' selected' : ''}>${esc(t)}</option>`).join('')}</select>` : ''}
              </div>` : ''}`;
        } else {
            head.innerHTML = `<div class="hub-chat-title">대화</div><div class="hub-chat-meta">왼쪽에서 세션을 고르거나 새 세션을 시작하세요</div>`;
        }
        this._renderMessages(true);
        this._renderComposer();
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
                html += this.transcript.messages.map(m => this._msgHtml(m)).join('');
            }
        } else if (!this.newFolder) {
            html = `<div class="hub-welcome"><p>세션을 고르면 여기서 대화를 보고 이어서 말할 수 있어요.</p>
              <p>보낸 메시지는 그 세션을 <code>claude --resume</code> 으로 이어서 실행해요.</p></div>`;
        }
        if (this.run && this._runBelongsHere()) html += this._runHtml();
        box.innerHTML = html || '<p class="hub-empty">첫 메시지를 보내면 새 세션이 시작돼요</p>';
        if (scroll) box.scrollTop = box.scrollHeight;
    }

    _runBelongsHere() {
        const s = this._selSession();
        return (s && this.run.sessionId === s.id) || (!this.run.sessionId && this.sel && this.run.root === this.sel.root && !this.sel.id) ||
            (this.run.newSessionId && s && this.run.newSessionId === s.id);
    }

    _msgHtml(m) {
        const esc = SessionMindMap._esc;
        const MAX = 6;
        const shown = (m.tools || []).slice(0, MAX);
        const more = (m.tools || []).length - shown.length;
        const tools = shown.length
            ? `<div class="hub-tools">${shown.map(t => `<span class="hub-tool" title="${esc(t.target)}"><b>${esc(t.name.replace(/^mcp__[^_]+(?:-[^_]+)*__/, ''))}</b> ${esc(SessionMindMap._base(t.target) || '')}</span>`).join('')}${more > 0 ? `<span class="hub-tool-more">도구 ${more}개 더</span>` : ''}</div>` : '';
        const time = m.at ? `<time>${SessionMindMap._fmt(m.at)}</time>` : '';
        return `<div class="hub-msg hub-${m.role}">${m.text ? `<div class="hub-bubble">${SessionHub.md(m.text)}</div>` : ''}${tools}${time}</div>`;
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
        return `<div class="hub-live">${r.label ? `<div class="hub-step">${SessionMindMap._esc(r.label)}</div>` : ''}${this._msgHtml(parts[0])}${a.text || a.tools.length ? this._msgHtml(a) : ''}
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
            : s ? '이 세션에 이어서 말하기 (⌘↩ 보내기)'
            : this.newFolder ? (this._newHub() && this.toonStart ? '세션 제목이나 할 일만 쓰세요 · 툰 허브를 읽고 시작해요 (⌘↩)' : '새 세션 첫 메시지 (⌘↩ 보내기)')
            : '왼쪽에서 세션을 고르세요';
        this.el('hub-send').hidden = running;
        this.el('hub-send').disabled = !can;
        this.el('hub-stop').hidden = !running;
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

    _startRun({ cwd, sessionId, root, text, permissionMode, label }) {
        const runId = 'run-' + Date.now() + '-' + Math.random().toString(36).slice(2, 6);
        this.run = { runId, text, label, events: [], sessionId, root, done: false };
        this.ipc.send('sessions:send', { runId, cwd, sessionId, text, permissionMode });
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
        const isSession = t.kind === 'session' || (t.kind === 'root' && t.ref.kind === 'session');
        const ts = isSession ? (t.kind === 'session' ? t.data : t.ref.data) : null;
        const tp = t.kind === 'session' ? t.project : t.kind === 'project' ? t.data : t.ref.kind === 'project' ? t.ref.data : t.ref.project;
        if (tp.root === p.root) {
            if (ts) this._link(p.root, s.id, ts.id, `붙였어요: ${ts.title} 아래에 ${s.title}`);
            else if (s.parentId) this._link(p.root, s.id, null, `폴더 바로 아래로 옮겼어요: ${s.title}`);
            return;
        }
        // 다른 폴더: 복사는 파일을 새로 쓰니 한 번 묻는다
        this.dropAsk = { src: { root: p.root, id: s.id, title: s.title }, to: { root: tp.root, name: tp.name }, parent: ts ? { id: ts.id, title: ts.title } : null };
        this._renderDropAsk();
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
        el.innerHTML = `<h4>다른 폴더로 복사</h4>
            <p><b>${esc(a.src.title)}</b> → <b>${esc(a.to.name)}</b> 폴더${a.parent ? `의 <b>${esc(a.parent.title)}</b> 아래` : ''}로 복사해요.</p>
            <p class="hub-muted">원본은 그대로예요. 대화 기록을 새 세션으로 복사하고 작업 폴더를 바꿔서, 그 폴더에서 이어서 말할 수 있어요.</p>
            ${this.ipc ? '' : '<p class="hub-muted">미리보기에서는 복사할 수 없어요 (맥 앱에서 돼요).</p>'}
            <div class="row"><button class="btn btn-primary" data-act="drop-copy"${this.ipc ? '' : ' disabled'}>복사</button><button class="btn" data-act="drop-cancel">취소</button></div>`;
    }

    _onChanged(r) {
        if (!r) return;
        if (!r.ok) { this.map._toast(r.error || '바꾸지 못했어요'); return; }
        const msg = r.action === 'copy' ? '복사했어요. 새 세션으로 이동해요' : this._pendingToast || '바꿨어요';
        this._pendingToast = null;
        if (r.action === 'copy') {
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
            ${topics.map(t => `<button role="tab" aria-selected="${v.topic === t}" data-act="hub-topic" data-topic="${esc(t)}">${esc(t)}</button>`).join('')}</div>`;
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
        this.toonFlow = { stage: 'save', runId, fromId: s.id, root: this.sel.root, cwd: s.cwd };
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
        flow.runId = this._startRun({ cwd: flow.cwd, sessionId: null, root: flow.root, text: prompt, permissionMode: this.permission, label: '2/2 새 세션' });
        this._renderChat();
    }

    stop() {
        if (this.run && !this.run.done && this.ipc) this.ipc.send('sessions:stop', { runId: this.run.runId });
    }

    _onRunEvent({ runId, event }) {
        if (!this.run || this.run.runId !== runId) return;
        this.run.events.push(event);
        if (event.session_id && !this.run.sessionId) this.run.newSessionId = event.session_id;
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
            const it = e.target.closest('.hub-item');
            if (it) return this.selectSession(it.dataset.root, it.dataset.id);
            const f = e.target.closest('.hub-folder');
            if (f) this.selectFolder(f.dataset.folder);
        });
        this.el('hub-search').addEventListener('input', e => { this.listQuery = e.target.value.trim().toLowerCase(); this._renderList(); });
        document.querySelectorAll('.hub-group-toggle button').forEach(b => b.addEventListener('click', () => {
            this.group = b.dataset.group;
            document.querySelectorAll('.hub-group-toggle button').forEach(x => x.setAttribute('aria-pressed', String(x === b)));
            this._renderList();
        }));
        this.el('hub-new').addEventListener('click', () => this.newSession());
        this.el('hub-refresh').addEventListener('click', () => this.refresh());
        if (this.el('hub-usage')) this.el('hub-usage').addEventListener('click', () => { this.usage = null; this._renderUsage(); this.readUsage(); });
        document.querySelectorAll('.hub-seg button').forEach(b => b.addEventListener('click', () => this.setCenter(b.dataset.center)));
        this.el('hub-send').addEventListener('click', () => this.send());
        this.el('hub-stop').addEventListener('click', () => this.stop());
        this.el('hub-perm').addEventListener('change', e => { this.permission = e.target.value; });
        this.el('hub-input').addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this.send(); }
        });
        this.el('hub-chat-head').addEventListener('click', e => {
            const c = e.target.closest('[data-copy]');
            if (c) { this._copy(c.dataset.copy); return; }
            const act = e.target.closest('[data-act]');
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
            if (e.target.id === 'hub-topic') { this.newTopic = e.target.value; return; }
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

SessionHub.TOON_SAVE_TEXT = '툰 저장해줘. 저장이 끝나면 새 세션에서 이어갈 시작 메시지를 ```toon-next 코드 블록 하나에만 담아서 답의 맨 끝에 보여줘.';

if (typeof window !== 'undefined') window.SessionHub = SessionHub;
if (typeof module !== 'undefined' && module.exports) module.exports = SessionHub;
