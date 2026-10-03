/**
 * SessionMindMap.js
 * =============================================================================
 * Claude Code 세션을 사방으로 펼쳐지는 마인드맵으로 그리는 모듈 (렌더러)
 *
 * 구조 (가운데에서 바깥으로):
 *   [Claude] ── 프로젝트 ── 세션 ── 세션이 고친 파일
 *
 * - 데이터: 메인 프로세스의 SessionIndexer 가 'sessions:index' IPC 로 보내준다.
 * - 세션을 누르면 그 세션이 고친 파일이 펼쳐지고, 같은 파일을 고친 다른 세션이 점선으로 이어진다.
 * - 파일을 누르면 그 파일을 고친 세션들이 모두 이어지고, "코드 보기"로 코드 탭에 연다.
 * - 휠로 확대·축소, 끌어서 이동, 빈 곳 더블클릭으로 전체 보기.
 */

class SessionMindMap {
    constructor(containerId, options = {}) {
        this.containerId = containerId;
        this.ipc = options.ipc !== undefined ? options.ipc : SessionMindMap._defaultIpc();
        this.now = options.now || (() => Date.now());
        this.onSelect = options.onSelect || null;       // (node) => void : 세션·프로젝트·파일을 골랐을 때
        this.infoKinds = new Set(options.infoKinds || ['project', 'session', 'file']); // 떠 있는 정보 패널을 보여줄 종류
        this.focus = { mode: 'all' };
        this.compact = !!options.compact;
        this.onAddSession = options.onAddSession || null; // (root) => void : 폴더의 + 를 눌렀을 때
        this.pendingRoot = null;                          // 새 세션을 만드는 중인 폴더 (자리 노드 표시)
        this.onDropSession = options.onDropSession || null; // (source, target|null) => void : 세션을 끌어다 놓았을 때                // 허브 안에서는 제목·새로고침을 뺀다                    // all | project(root) | session(root, id)

        this.data = null;
        this.period = '7d';
        this.query = '';
        this.showAllFiles = false;
        this.expanded = new Set();   // 파일이 펼쳐진 세션 키
        this.fold = new Map();       // 노드 키 → 펼침(true)/접힘(false). 없으면 기본값 (_isOpen)
        this.pins = SessionMindMap._loadPins(); // 끌어다 놓은 자리: 보기 → { 노드 키: [x, y] }
        this.selected = null;        // { kind, key }
        this.view = { x: 0, y: 0, k: 1 };
        this.nodes = [];
        this.byKey = new Map();
        this.built = false;
        this.loading = false;
        this._fitPending = true;
    }

    static _defaultIpc() {
        if (typeof window !== 'undefined' && window.ipcRenderer) return window.ipcRenderer;
        try {
            if (typeof require === 'function') return require('electron').ipcRenderer;
        } catch {
            // 브라우저 하네스에서는 IPC 없이 setData 로만 그린다
        }
        return null;
    }

    // ---------------------------------------------------------------------
    // 공개 API
    // ---------------------------------------------------------------------
    activate() {
        this._build();
        if (!this.data) this.refresh();
        else this._resizeSoon();
    }

    refresh() {
        this._build();
        if (!this.ipc) {
            this._setStatus('IPC 없음: setData()로 데이터를 넣어 주세요');
            return;
        }
        if (this.loading) return;
        this.loading = true;
        this._setStatus('세션 기록 읽는 중…');
        this.ipc.send('sessions:index', {});
    }

    setData(data) {
        this._build();
        this.loading = false;
        this.data = data;
        // 처음에는 작업 중·최근 세션의 파일을 펼쳐 둔다
        if (!this._seededExpand) {
            this._seededExpand = true;
            for (const p of data.projects) {
                for (const s of p.sessions) {
                    if (s.status === 'working') this.expanded.add(this._sessionKey(p, s));
                }
            }
        }
        this._fitPending = true;
        this.render();
    }

    /**
     * 가운데에 무엇을 둘지 정한다.
     *   setFocus('all')                     Claude → 프로젝트 → 세션 → 파일
     *   setFocus('project', root)           폴더 → 세션 → 파일
     *   setFocus('session', root, id)       세션 → 고친 파일 → 그 파일을 같이 고친 다른 세션
     */
    setFocus(mode, root, id) {
        this.focus = mode === 'all' ? { mode } : { mode, root, id };
        this.selected = null;
        if (this.info) this.info.hidden = true;
        this._fitPending = true;
        this.render();
    }

    _findProject(root) { return this.data && this.data.projects.find(p => p.root === root); }

    /** 카드 아래 기기 이름: 다른 기기 세션이거나, 고친 것이 아직 GitHub 에 없어 이 기기에만 있을 때 */
    _machineOf(s) {
        if (s.remote) return s.machine || '';
        return (s.git === 'dirty' || s.git === 'ahead') && this.data && this.data.machine ? this.data.machine : '';
    }

    // ---------------------------------------------------------------------
    // DOM 뼈대
    // ---------------------------------------------------------------------
    _build() {
        if (this.built) return;
        const container = document.getElementById(this.containerId);
        if (!container) return;
        SessionMindMap._injectStyle();
        this.container = container;
        container.innerHTML = `
          <div class="smm-root${this.compact ? ' smm-compact' : ''}">
            <div class="smm-toolbar">
              <strong class="smm-title">세션 맵</strong>
              <input class="smm-search" type="search" placeholder="세션·파일 찾기" aria-label="세션이나 파일 이름으로 찾기">
              <select class="smm-period" aria-label="기간">
                <option value="24h">24시간</option>
                <option value="7d" selected>7일</option>
                <option value="30d">30일</option>
                <option value="all">전체</option>
              </select>
              <label class="smm-check"><input type="checkbox" class="smm-allfiles"> 파일 모두</label>
              <button class="smm-btn smm-fit" title="전체 보기 (빈 곳 더블클릭)">전체 보기</button>
              <button class="smm-btn smm-foldall" hidden>가지 모두 접기</button>
              <button class="smm-btn smm-reset" title="끌어다 놓은 자리를 처음 배치로" hidden>자리 되돌리기</button>
              <button class="smm-btn smm-refresh">새로고침</button>
              <span class="smm-status"></span>
            </div>
            <svg class="smm-svg" xmlns="http://www.w3.org/2000/svg">
              <g class="smm-viewport">
                <g class="smm-rings"></g>
                <g class="smm-links"></g>
                <g class="smm-xlinks"></g>
                <g class="smm-nodes"></g>
              </g>
            </svg>
            <div class="smm-legend">
              <span><i class="smm-chip-c smm-working"></i>작업 중 (10분 안)</span>
              <span><i class="smm-chip-c smm-recent"></i>최근 (24시간 안)</span>
              <span><i class="smm-chip-c smm-idle"></i>지난 세션</span>
              <span><i class="smm-chip-c smm-chip-chat"></i>대화 세션</span>
              <span><i class="smm-dash"></i>같은 파일을 고친 세션</span>
            </div>
            <aside class="smm-info" hidden></aside>
            <div class="smm-toast" hidden></div>
          </div>`;

        const q = sel => container.querySelector(sel);
        this.svg = q('.smm-svg');
        this.gView = q('.smm-viewport');
        this.gRings = q('.smm-rings');
        this.gLinks = q('.smm-links');
        this.gX = q('.smm-xlinks');
        this.gNodes = q('.smm-nodes');
        this.info = q('.smm-info');
        this.statusEl = q('.smm-status');
        this.toastEl = q('.smm-toast');

        q('.smm-search').addEventListener('input', e => { this.query = e.target.value.trim().toLowerCase(); this.render(); });
        q('.smm-period').addEventListener('change', e => { this.period = e.target.value; this._fitPending = true; this.render(); });
        q('.smm-allfiles').addEventListener('change', e => { this.showAllFiles = e.target.checked; this._fitPending = true; this.render(); });
        q('.smm-fit').addEventListener('click', () => this._fit(true));
        this.foldBtn = q('.smm-foldall');
        this.resetBtn = q('.smm-reset');
        this.foldBtn.addEventListener('click', () => this._foldAll());
        this.resetBtn.addEventListener('click', () => {
            delete this.pins[this._viewKey()];
            this._savePins();
            this._fitPending = true;
            this.render();
        });
        q('.smm-refresh').addEventListener('click', () => this.refresh());
        if (SessionMindMap.addTools) SessionMindMap.addTools(this);   // MindMapTools.js: ＋/− 확대, 우클릭 지우기

        this._bindPanZoom();
        this._bindDrag();
        this.gNodes.addEventListener('click', e => this._onNodeClick(e));
        this.info.addEventListener('click', e => this._onInfoClick(e));

        if (this.ipc) {
            this.ipc.on('sessions:index-result', (event, result) => {
                this.loading = false;
                if (result && result.success === false) {
                    this._setStatus('읽기 실패: ' + (result.error || '알 수 없는 오류'));
                    return;
                }
                this.setData(result);
            });
        }
        if (typeof ResizeObserver !== 'undefined') {
            new ResizeObserver(() => this._resizeSoon()).observe(container);
        }
        this.built = true;
    }

    // ---------------------------------------------------------------------
    // 트리 만들기 (필터 반영)
    // ---------------------------------------------------------------------
    _sessionKey(p, s) { return `s:${p.root}::${s.id}`; }

    _visibleTree() {
        if (this.focus.mode === 'project') {
            const p = this._findProject(this.focus.root);
            if (p) return this._projectTree(p);
        }
        if (this.focus.mode === 'session') {
            const p = this._findProject(this.focus.root);
            const s = p && p.sessions.find(x => x.id === this.focus.id);
            if (s) return this._sessionTree(p, s);
        }
        return this._allTree();
    }

    _colorOf(p) {
        const i = this.data.projects.indexOf(p);
        return SessionMindMap.PALETTE[(i < 0 ? 0 : i) % SessionMindMap.PALETTE.length];
    }

    _fileNodes(p, s, sKey, color, onlyMatching) {
        const q = this.query;
        return s.files
            .filter(f => !onlyMatching || !q || (f.rel || f.path).toLowerCase().includes(q))
            .map(f => ({ key: `f:${sKey}::${f.path}`, kind: 'file', label: SessionMindMap._base(f.rel || f.path), data: f, session: s, project: p, color, children: [] }));
    }

    // 폴더 중심: 가운데 폴더, 둘레에 그 폴더의 세션(기간·검색 반영), 세션은 파일까지 펼친다
    _projectTree(p) {
        const color = this._colorOf(p);
        const root = { key: 'root', kind: 'root', label: p.name, color, ref: { kind: 'project', data: p }, children: [] };
        root.children.push(...this._sessionNodes(p, this._filterSessions(p), color));
        if (this.pendingRoot === p.root && !this._pendingPlaced) root.children.push(this._pendingNode(p, color));
        return root;
    }

    // 세션 중심: 가운데 세션, 둘레에 고친 파일, 그 바깥에 같은 파일을 고친 다른 세션 (모든 폴더에서)
    _sessionTree(p, s) {
        const color = this._colorOf(p);
        const sKey = this._sessionKey(p, s);
        const root = { key: 'root', kind: 'root', label: s.title, color, ref: { kind: 'session', data: s, project: p, key: sKey }, children: [] };
        const others = new Map(); // 파일 경로 → [{p, s}]
        for (const op of this.data.projects) {
            for (const os of op.sessions) {
                if (op === p && os.id === s.id) continue;
                for (const f of os.files) {
                    if (!others.has(f.path)) others.set(f.path, []);
                    others.get(f.path).push({ p: op, s: os });
                }
            }
        }
        for (const fNode of this._fileNodes(p, s, sKey, color, true)) {
            for (const o of (others.get(fNode.data.path) || []).sort((a, b) => a.s.firstAt - b.s.firstAt)) {
                const oKey = this._sessionKey(o.p, o.s);
                fNode.children.push({ key: `${oKey}@${fNode.data.path}`, kind: 'session', label: o.s.title, data: o.s, project: o.p, color: this._colorOf(o.p), seq: this._seq(o.p, o.s), related: oKey, children: [] });
            }
            root.children.push(fNode);
        }
        return root;
    }

    // 시간순: 시작이 이른 세션부터. 순번은 폴더 안 전체 세션 기준이라 걸러도 바뀌지 않는다
    static _chrono(list) { return [...list].sort((a, b) => (a.firstAt - b.firstAt) || (a.lastAt - b.lastAt)); }

    _seq(p, s) {
        if (!this._seqCache || this._seqCache.data !== this.data) this._seqCache = { data: this.data, byRoot: new Map() };
        let m = this._seqCache.byRoot.get(p.root);
        if (!m) {
            m = new Map(SessionMindMap._chrono(p.sessions).map((x, i) => [x.id, i + 1]));
            this._seqCache.byRoot.set(p.root, m);
        }
        return m.get(s.id);
    }

    /**
     * 줄기(툰 이어가기로 이어진 세션)마다 맨 끝(최신) 세션 → 앞 세션들 [오래된 것부터]
     * 지도에는 맨 끝만 그리고 앞 세션은 "이전 N" 으로 접는다.
     */
    static chains(sessions) {
        const ids = new Set(sessions.map(s => s.id));
        const hasNext = new Set(sessions.filter(s => s.prevId && ids.has(s.prevId)).map(s => s.prevId));
        const byId = new Map(sessions.map(s => [s.id, s]));
        const heads = new Map(); // 맨 끝 id → 앞 세션들
        const headOf = new Map(); // 세션 id → 맨 끝 id
        for (const s of sessions) {
            if (hasNext.has(s.id)) continue;
            const prev = [];
            for (let cur = byId.get(s.prevId), guard = 0; cur && guard < 1000; cur = byId.get(cur.prevId), guard++) prev.unshift(cur);
            heads.set(s.id, prev);
            headOf.set(s.id, s.id);
            prev.forEach(x => headOf.set(x.id, s.id));
        }
        return { heads, headOf };
    }

    // 폴더 안 세션 노드: 주제 가지 → 줄기의 최신 세션 → 하위 세션(parentId), 파일은 그 뒤에
    _sessionNodes(p, sessions, color) {
        const q = this.query;
        const nodes = new Map();
        const { heads, headOf } = SessionMindMap.chains(sessions);
        this._pendingPlaced = false;
        for (const s of SessionMindMap._chrono(sessions)) {
            if (!heads.has(s.id)) continue; // 줄기의 앞 세션은 맨 끝 카드에 접는다
            const sKey = this._sessionKey(p, s);
            const n = { key: sKey, kind: 'session', label: s.title, data: s, project: p, color, seq: this._seq(p, s), prev: heads.get(s.id), children: [] };
            const open = this.showAllFiles || this.expanded.has(sKey) || (q && s.files.some(f => (f.rel || f.path).toLowerCase().includes(q)));
            n.files = open ? this._fileNodes(p, s, sKey, color, !this.showAllFiles && !this.expanded.has(sKey)) : [];
            nodes.set(s.id, n);
        }
        const top = [];
        for (const n of nodes.values()) {
            // 하위 세션의 부모가 줄기 앞쪽에 접혀 있으면 그 줄기의 맨 끝 카드 아래로
            const parent = n.data.parentId && nodes.get(headOf.get(n.data.parentId) || n.data.parentId);
            if (parent && parent !== n) { n.sub = true; parent.children.push(n); } else top.push(n);
        }
        for (const n of nodes.values()) n.children.push(...n.files);

        // 주제 가지: 툰 주제 허브(빈 가지 포함) + 세션에 적힌 주제. 주제 없는 세션은 폴더 바로 아래
        const hub = p.hub || { topics: [], titles: {} };
        const names = [...new Set([...(hub.topics || []), ...top.map(n => n.data.topic).filter(Boolean)])];
        if (!names.length) { this._placePending(p, color, nodes, new Map(), headOf); return top; }
        const branches = new Map(names.map(t => [t, {
            key: `t:${p.root}::${t}`, kind: 'topic', label: (hub.titles || {})[t] || t, topic: t, project: p, color, children: []
        }]));
        const loose = [];
        for (const n of top) (n.data.topic && branches.get(n.data.topic) ? branches.get(n.data.topic).children : loose).push(n);
        this._placePending(p, color, nodes, branches, headOf);
        // 잔가지 접기: 전체 보기에서는 가지를 접어 두고, 폴더 중심에서는 펼쳐 둔다
        const pend = this.pendingRoot === p.root && this.pendingMeta && this.pendingMeta.topic;
        for (const b of branches.values()) {
            if (!b.children.length || b.topic === pend || this._isOpen(b.key, this.focus.mode !== 'all')) continue;
            b.hidden = b.children.length;
            b.children = [];
        }
        // 검색 중에는 맞는 세션이 있는 가지만
        const shown = [...branches.values()].filter(b => !q || b.children.length || b.hidden || b.label.toLowerCase().includes(q) || b.topic.toLowerCase().includes(q));
        return [...shown, ...loose];
    }

    // 새 세션 자리: 세션 ⊕ 면 그 세션 아래, 가지 ⊕ 면 그 가지 아래 (못 찾으면 폴더 아래 = 호출한 쪽이 붙인다)
    _placePending(p, color, nodes, branches, headOf) {
        const m = this.pendingMeta;
        if (this.pendingRoot !== p.root || !m) return;
        const target = (m.parentId && nodes.get(headOf.get(m.parentId) || m.parentId)) || (m.topic && branches.get(m.topic));
        if (!target) return;
        target.children.push(this._pendingNode(p, color));
        this._pendingPlaced = true;
    }

    _pendingNode(p, color) {
        return { key: `pending:${p.root}`, kind: 'pending', label: '새 세션', project: p, color, children: [] };
    }

    _filterSessions(p) {
        const limit = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: Infinity }[this.period];
        const now = this.now();
        const q = this.query;
        return p.sessions.filter(s => {
            if (now - s.lastAt > limit) return false;
            if (!q) return true;
            return s.title.toLowerCase().includes(q) ||
                s.files.some(f => (f.rel || f.path).toLowerCase().includes(q)) ||
                p.name.toLowerCase().includes(q);
        });
    }

    /** 접기·펼치기: 사용자가 정한 게 있으면 그것, 검색 중이면 펼침, 아니면 기본값 */
    _isOpen(key, def) {
        if (this.query) return true;
        const v = this.fold.get(key);
        return v === undefined ? def : v;
    }

    _toggleFold(key) {
        const n = this.byKey.get(key);
        const open = !!(n && n.children.length);
        this.fold.set(key, !open);
        this.render();
    }

    /** 끌어다 놓은 자리는 보기(전체·폴더 중심·세션 중심)마다 따로 기억한다 */
    _viewKey() {
        const f = this.focus;
        return f.mode === 'all' ? 'all' : `${f.mode}:${f.root}${f.mode === 'session' ? '::' + f.id : ''}`;
    }

    static _loadPins() {
        try { return JSON.parse(localStorage.getItem('smm.pins') || '{}') || {}; } catch { return {}; }
    }

    _savePins() {
        try { localStorage.setItem('smm.pins', JSON.stringify(this.pins)); } catch { /* 저장 못 해도 이번 창에서는 유지 */ }
    }

    _allTree() {
        const limit = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: Infinity }[this.period];
        const now = this.now();
        const q = this.query;
        const root = { key: 'root', kind: 'root', label: 'Claude', children: [] };

        this.data.projects.forEach((p, pi) => {
            const color = SessionMindMap.PALETTE[pi % SessionMindMap.PALETTE.length];
            const sessions = p.sessions.filter(s => {
                if (now - s.lastAt > limit) return false;
                if (!q) return true;
                return s.title.toLowerCase().includes(q) ||
                    s.files.some(f => (f.rel || f.path).toLowerCase().includes(q)) ||
                    p.name.toLowerCase().includes(q);
            });
            // 폴더는 기간과 상관없이 늘 보인다 (세션이 없거나 오래된 폴더도). 검색 중에는 맞는 것만
            if (!sessions.length && q && !p.name.toLowerCase().includes(q) && this.pendingRoot !== p.root) return;
            const pNode = { key: `p:${p.root}`, kind: 'project', label: p.name, data: p, color, total: sessions.length, children: [] };
            this._pendingPlaced = false;
            // 처음에는 폴더만: 폴더 아래(가지·세션)는 접어 두고 ▸ 로 펼친다. 새 세션 자리가 있으면 펼친다
            if (this._isOpen(pNode.key, false) || this.pendingRoot === p.root) pNode.children.push(...this._sessionNodes(p, sessions, color));
            else pNode.hidden = sessions.length;
            if (this.pendingRoot === p.root && !this._pendingPlaced) pNode.children.push(this._pendingNode(p, color));
            root.children.push(pNode);
        });
        return root;
    }

    // ---------------------------------------------------------------------
    // 방사형 배치: 잎 개수에 비례해 각도를 나누고, 깊이마다 고리 하나
    // ---------------------------------------------------------------------
    _layout(root) {
        const weight = n => {
            if (!n.children.length) n.w = 1;
            else n.w = n.children.reduce((a, c) => a + weight(c), 0);
            if (n.kind === 'project') n.w += 0.8; // 프로젝트 사이 여백
            if (n.kind === 'topic' && !n.children.length && !n.hidden) n.w = 0.7; // 빈 가지는 좁게
            return n.w;
        };
        weight(root);

        const all = [];
        const assign = (n, a0, a1, depth, parent) => {
            n.depth = depth;
            n.parent = parent || null;
            n.angle = (a0 + a1) / 2;
            all.push(n);
            if (!n.children.length) return;
            const inner = n.kind === 'project' ? (a1 - a0) * (n.w - 0.8) / n.w : a1 - a0;
            let cursor = n.angle - inner / 2;
            const sum = n.children.reduce((a, c) => a + c.w, 0);
            for (const c of n.children) {
                const span = inner * c.w / sum;
                assign(c, cursor, cursor + span, depth + 1, n);
                cursor += span;
            }
        };
        assign(root, -Math.PI / 2, Math.PI * 1.5, 0);

        // 고리 반지름: 깊이마다 앞 고리에 무엇이 있는지에 따라 간격을 둔다 (세션 카드는 바깥으로 길게 뻗어서 넓게)
        const maxDepth = Math.max(...all.map(n => n.depth));
        const isCard = n => n.kind === 'session' || n.kind === 'pending';
        const rings = [0];
        for (let d = 1; d <= maxDepth; d++) {
            const prevHasCards = all.some(n => n.depth === d - 1 && isCard(n));
            rings[d] = rings[d - 1] + (d === 1 ? (root.ref ? 210 : 170) : prevHasCards ? 260 : 190);
        }
        // 가장 바깥 잎들이 서로 겹치지 않을 만큼 전체를 키운다 (세션 카드는 두 줄이라 더 넓게)
        const leaves = all.filter(n => !n.children.length && n.depth > 0);
        const outer = leaves.length ? Math.max(...leaves.map(n => n.depth)) : 0;
        const cardLeaves = leaves.filter(isCard).length;
        const boxLeaves = leaves.filter(n => n.kind === 'project' || n.kind === 'topic').length; // 폴더·가지 꼬리표는 넓다
        const need = (cardLeaves * 46 + boxLeaves * 64 + (leaves.length - cardLeaves - boxLeaves) * 18) / (2 * Math.PI);
        const scale = outer ? Math.max(1, need / rings[outer]) : 1;
        const radius = d => rings[d] * scale;
        for (const n of all) {
            n.r = radius(n.depth);
            n.x = n.r * Math.cos(n.angle);
            n.y = n.r * Math.sin(n.angle);
        }
        this.rings = [];
        for (let d = 1; d <= maxDepth; d++) this.rings.push(radius(d));
        this._applyPins(all);
        SessionMindMap.spread(all.map(n => ({ n, box: this._box(n) })));
        return all;
    }

    /**
     * 끌어다 놓은 자리: 놓은 노드는 그 자리에, 그 아래 노드들은 같이 따라간다.
     * all 은 부모가 먼저 나오는 순서라 부모가 옮겨진 만큼을 아래로 물려준다.
     */
    _applyPins(all) {
        const pins = this.pins[this._viewKey()] || {};
        for (const n of all) {
            const pin = n.depth > 0 && pins[n.key];
            const pd = n.parent ? n.parent.delta : [0, 0];
            n.delta = pin ? [pin[0] - n.x, pin[1] - n.y] : pd;
            n.fixed = !!pin || n.depth === 0;
            n.x += n.delta[0];
            n.y += n.delta[1];
            n.moved = !!pin || !!(n.parent && n.parent.moved);
            // 카드·꼬리표를 어느 쪽으로 펼칠지: 옮긴 노드는 부모와의 위치로, 나머지는 각도로
            n.right = n.moved && n.parent ? n.x >= n.parent.x : Math.cos(n.angle) >= -1e-6;
        }
    }

    /**
     * 노드가 차지하는 네모 (노드 점 기준). 카드·꼬리표는 점 옆으로 붙어 그려지므로 그 쪽으로 넓다.
     * _nodeSvg 의 크기 계산과 맞춰 둔다.
     */
    _box(n) {
        const W = SessionMindMap._textWidth;
        const side = (w, before, after, y0, y1) => n.right ? [-before, w + after, y0, y1] : [-(w + after), before, y0, y1];
        if (n.kind === 'root') {
            if (!n.ref) return [-48, 48, -48, 48];
            const w = n.ref.kind === 'project' ? Math.max(120, W(SessionMindMap._clip(n.label, 18), 15) + 44) : Math.max(160, W(SessionMindMap._clip(n.label, 22), 14) + 36);
            return [-w / 2 - 4, w / 2 + 4, -34, 50];
        }
        if (n.kind === 'project') {
            const w = Math.max(84, W(SessionMindMap._clip(n.label, 20), 13) + 30);
            return [-w / 2 - 4, w / 2 + 30, -21, n.hidden || n.children.length ? 32 : 18];
        }
        if (n.kind === 'topic') {
            const w = W(SessionMindMap._clip(n.label, 14), 12) + 22;
            return side(w, 6, 8 + 26 + (n.hidden || n.children.length ? 34 : 0), -14, 14);
        }
        if (n.kind === 'pending') return side(168, 6, 12, -19, 19);
        if (n.kind === 'session') {
            const s = n.data;
            const git = SessionMindMap.GIT[s.git];
            const w = Math.max(W((n.seq ? `${n.seq} ` : '') + SessionMindMap._clip(n.label, 20), 12), W(SessionMindMap._span(s.firstAt, s.lastAt), 10.5) * 0.92 + (git ? W(git, 10) + 10 : 0)) + 24;
            return side(w, 6 + (n.prev && n.prev.length ? 32 : 0), 11 + 24, -23, this._machineOf(s) ? 32 : 23);
        }
        const lw = W(SessionMindMap._clip(n.label, 28), 11);
        return side(lw, 7, 12, -9, 9);
    }

    /**
     * 겹침 풀기: 네모가 겹치는 두 노드를 덜 겹친 쪽(가로·세로)으로 밀어낸다.
     * 고정 노드(가운데, 끌어다 놓은 노드)는 안 움직이고 상대만 민다. 겹침이 없어질 때까지 (최대 120번)
     * @param {{n:{x,y,fixed}, box:[x0,x1,y0,y1]}[]} items
     * @returns {number} 남은 겹침 수
     */
    static spread(items, gap = 6) {
        let left = 0;
        for (let it = 0; it < 120; it++) {
            left = 0;
            for (let i = 0; i < items.length; i++) {
                const a = items[i];
                for (let j = i + 1; j < items.length; j++) {
                    const b = items[j];
                    if (a.n.fixed && b.n.fixed) continue;
                    const ox = Math.min(a.n.x + a.box[1], b.n.x + b.box[1]) - Math.max(a.n.x + a.box[0], b.n.x + b.box[0]) + gap;
                    if (ox <= 0) continue;
                    const oy = Math.min(a.n.y + a.box[3], b.n.y + b.box[3]) - Math.max(a.n.y + a.box[2], b.n.y + b.box[2]) + gap;
                    if (oy <= 0) continue;
                    left++;
                    const wa = a.n.fixed ? 0 : b.n.fixed ? 1 : 0.5, wb = 1 - wa;
                    if (ox < oy) {
                        // 가운데끼리 비교해 바깥쪽으로
                        const dir = (a.n.x + (a.box[0] + a.box[1]) / 2) <= (b.n.x + (b.box[0] + b.box[1]) / 2) ? -1 : 1;
                        a.n.x += dir * ox * wa; b.n.x -= dir * ox * wb;
                    } else {
                        const dir = (a.n.y + (a.box[2] + a.box[3]) / 2) <= (b.n.y + (b.box[2] + b.box[3]) / 2) ? -1 : 1;
                        a.n.y += dir * oy * wa; b.n.y -= dir * oy * wb;
                    }
                }
            }
            if (!left) break;
        }
        return left;
    }

    // ---------------------------------------------------------------------
    // 그리기
    // ---------------------------------------------------------------------
    render() {
        if (!this.built || !this.data) return;
        const tree = this._visibleTree();
        if (!tree.children.length && !tree.ref) {
            this.gRings.innerHTML = this.gLinks.innerHTML = this.gX.innerHTML = '';
            this.gNodes.innerHTML = `<text class="smm-empty" x="0" y="0" text-anchor="middle">이 조건에 맞는 세션이 없어요</text>`;
            this._setStatus('');
            this._applyView();
            return;
        }
        this.nodes = this._layout(tree);
        this.byKey = new Map(this.nodes.map(n => [n.key, n]));

        // 전체 보기는 접힌 폴더의 세션까지 센다
        const sessionCount = tree.ref ? new Set(this.nodes.filter(n => n.kind === 'session').map(n => n.related || n.key)).size
            : this.nodes.reduce((a, n) => a + (n.total || 0), 0);
        const projectCount = this.focus.mode === 'all' || !tree.ref ? this.nodes.filter(n => n.kind === 'project').length
            : new Set([tree.ref.project ? tree.ref.project.root : tree.ref.data.root, ...this.nodes.filter(n => n.kind === 'session').map(n => n.project.root)]).size;
        this._setStatus(`프로젝트 ${projectCount} · 세션 ${sessionCount} · ${SessionMindMap._ago(this.data.generatedAt, this.now())} 기준`);

        this.gRings.innerHTML = this.rings.map(r => `<circle r="${r.toFixed(1)}" class="smm-ring"/>`).join('');

        this._tree = tree;
        this._drawLinks();
        const pins = this.pins[this._viewKey()];
        if (this.resetBtn) this.resetBtn.hidden = !pins || !Object.keys(pins).length;
        if (this.foldBtn) {
            const foldable = this.nodes.filter(n => n.kind === 'project' || n.kind === 'topic');
            this.foldBtn.hidden = !foldable.some(n => n.hidden || n.children.length);
            this.foldBtn.textContent = foldable.some(n => n.children.length && n.depth > 0) ? '가지 모두 접기' : '가지 모두 펼치기';
        }

        this.gNodes.innerHTML = this.nodes.map(n => this._nodeSvg(n)).join('');
        if (SessionMindMap.markRecent) SessionMindMap.markRecent(this);   // MindMapRecent.js
        this._drawSelection();

        if (this._fitPending) this._fit(false);
        else this._applyView();
    }

    _drawLinks() {
        const links = [];
        const walk = n => {
            for (const c of n.children) {
                links.push(`<path class="smm-link smm-link-${c.kind}" stroke="${c.color}" d="${SessionMindMap._link(n, c)}"/>`);
                walk(c);
            }
        };
        walk(this._tree);
        this.gLinks.innerHTML = links.join('');
    }

    /** 가지 모두 접기 / 펼치기 (폴더·주제 가지) */
    _foldAll() {
        const foldable = this.nodes.filter(n => (n.kind === 'project' || n.kind === 'topic') && (n.hidden || n.children.length));
        const open = !foldable.some(n => n.children.length && n.depth > 0);
        // 펼칠 때는 지금 숨은 것까지 펼치려고 두 번 그린다 (폴더를 펼쳐야 그 안 가지가 나온다)
        for (let pass = 0; pass < (open ? 2 : 1); pass++) {
            for (const n of this.nodes) if (n.kind === 'project' || n.kind === 'topic') this.fold.set(n.key, open);
            this._fitPending = true;
            this.render();
        }
    }

    // 단계마다 다른 도형: 가운데(큰 원 / 큰 폴더 / 큰 카드) · 폴더(폴더 모양) · 세션(카드) · 파일(문서 아이콘)
    _nodeSvg(n) {
        const esc = SessionMindMap._esc;
        const W = SessionMindMap._textWidth;
        const right = n.right !== undefined ? n.right : Math.cos(n.angle) >= -1e-6;
        const tx = right ? 1 : -1;
        const at = `transform="translate(${(n.x || 0).toFixed(1)},${(n.y || 0).toFixed(1)})"`;

        if (n.kind === 'root') {
            // 전체: 큰 원(이중 테)
            if (!n.ref) {
                return `<g class="smm-node smm-root-node" data-key="root" ${at}>
                    <circle r="44" class="smm-core-ring"/><circle r="36" class="smm-core"/>
                    <text class="smm-core-label" text-anchor="middle" dy="5">${esc(n.label)}</text>
                    <title>눌러서 툰 허브 보기</title></g>`;
            }
            // 폴더 중심: 큰 폴더
            if (n.ref.kind === 'project') {
                const label = SessionMindMap._clip(n.label, 18);
                const w = Math.max(120, W(label, 15) + 44), h = 52;
                return `<g class="smm-node smm-root-node smm-root-folder" data-key="root" ${at}>
                    ${SessionMindMap._folderShape(w, h, n.color)}
                    <text class="smm-folder-label smm-big" text-anchor="middle" dy="9">${esc(label)}</text>
                    ${this._addButton(0, h / 2 + 18, n.ref.data.root, n.color)}
                    <title>${esc(n.ref.data.root)} · 눌러서 툰 허브 보기</title></g>`;
            }
            // 세션 중심: 큰 카드
            const s = n.ref.data;
            const label = SessionMindMap._clip(n.label, 22);
            const time = SessionMindMap._span(s.firstAt, s.lastAt);
            const git = SessionMindMap.GIT[s.git];
            const where = this._machineOf(s);
            const w = Math.max(W(label, 14), W(time, 11) + (git ? W(git, 10) + 10 : 0)) + 36, h = 56;
            return `<g class="smm-node smm-root-node smm-root-card" data-key="root" ${at}>
                <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="14" class="smm-card smm-${s.status}" style="--c:${n.color}"/>
                <text text-anchor="middle"><tspan x="0" dy="-3" class="smm-card-title smm-big">${esc(label)}</tspan><tspan x="0" dy="18" class="smm-time">${time}</tspan>${git ? `<tspan dx="8" class="smm-git smm-git-${s.git}">${git}</tspan>` : ''}</text>
                ${where ? `<text text-anchor="middle" y="${h / 2 + 13}" class="smm-machine">${esc(where)}</text>` : ''}
                ${n.children.length ? '' : `<text class="smm-hint" text-anchor="middle" y="${h / 2 + (where ? 32 : 22)}">이 세션이 고친 파일이 없어요</text>`}
                <title>${esc(s.title)} · 눌러서 툰 허브 보기</title></g>`;
        }

        if (n.kind === 'project') {
            const label = SessionMindMap._clip(n.label, 20);
            const w = Math.max(84, W(label, 13) + 30), h = 30;
            return `<g class="smm-node smm-project${n.total ? '' : ' smm-project-quiet'}" data-key="${esc(n.key)}" ${at} tabindex="0">
                ${SessionMindMap._folderShape(w, h, n.color)}
                <text class="smm-folder-label" text-anchor="middle" dy="7">${esc(label)}</text>
                ${this._addButton(w / 2 + 16, 2, n.data.root, n.color)}
                ${this._foldChip(0, h / 2 + 9, n, '세션')}
                <title>${esc(n.data.root)}</title></g>`;
        }

        if (n.kind === 'topic') {
            // 주제 가지: 꼬리표 모양 + ⊕ (그 주제로 새 세션)
            const label = SessionMindMap._clip(n.label, 14);
            const w = W(label, 12) + 22, h = 24;
            const x = right ? 8 : -8 - w;
            const empty = !n.children.length && !n.hidden;
            return `<g class="smm-node smm-topic${empty ? ' smm-topic-empty' : ''}" data-key="${esc(n.key)}" ${at} tabindex="0">
                <circle r="4" class="smm-joint" fill="${n.color}"/>
                <rect x="${x}" y="${-h / 2}" width="${w}" height="${h}" rx="12" class="smm-topic-tag" style="--c:${n.color}"/>
                <text x="${x + w / 2}" dy="4" text-anchor="middle" class="smm-topic-label">${esc(label)}</text>
                ${this._addButton(right ? x + w + 14 : x - 14, 0, n.project.root, n.color, { topic: n.topic, label: `${n.label} 가지에 새 세션` })}
                ${this._foldChip(right ? x + w + 44 : x - 44, 0, n, '세션')}
                <title>${esc(n.label)} 가지 (.toon/${esc(n.topic)}) · ${empty ? '아직 세션 없음 · ⊕ 로 첫 세션' : `세션 ${n.hidden || n.children.length}개`} · 눌러서 주제 허브 보기</title></g>`;
        }

        if (n.kind === 'pending') {
            const w = 168;
            const x = right ? 10 : -10 - w;
            return `<g class="smm-node smm-pending" data-key="${esc(n.key)}" ${at} tabindex="0">
                <circle r="5" stroke="${n.color}"/>
                <rect x="${x}" y="-17" width="${w}" height="34" rx="9" stroke="${n.color}"/>
                <text x="${x + 12}" dy="4" class="smm-label">＋ 새 세션 · 첫 메시지로 시작</text></g>`;
        }

        if (n.kind === 'session') {
            const s = n.data;
            const count = s.files.length;
            const open = n.children.some(c => c.kind === 'file');
            const title = SessionMindMap._clip(n.label, 20);
            const seq = n.seq ? `${n.seq} ` : '';
            const time = SessionMindMap._span(s.firstAt, s.lastAt);
            const git = SessionMindMap.GIT[s.git];
            const where = this._machineOf(s);
            const w = Math.max(W(seq + title, 12), W(time, 10.5) * 0.92 + (git ? W(git, 10) + 10 : 0)) + 24, h = 36;
            const x = right ? 11 : -11 - w;
            const badge = count && !open ? `<g class="smm-badge-pill" transform="translate(${right ? x + w : x},${-h / 2})"><rect x="-13" y="-8" width="26" height="16" rx="8" fill="${n.color}"/><text text-anchor="middle" dy="4">+${count}</text></g>` : '';
            const alarm = SessionMindMap.alarm(s, this.now());
            const ctx = SessionMindMap.contextInfo(s);
            return `<g class="smm-node smm-session smm-${s.status}${n.sub ? ' smm-sub' : ''}${s.remote ? ' smm-remote' : ''} smm-kind-${s.kind || 'code'}" data-key="${esc(n.key)}" ${at} tabindex="0">
                ${alarm ? `<rect x="${x - 4}" y="${-h / 2 - 4}" width="${w + 8}" height="${h + 8}" rx="13" class="smm-alarm"><title>${alarm === 'full' ? '세션이 거의 찼어요' : '큰 세션인데 캐시가 곧 끝나요'} · 툰 할 때</title></rect>` : ''}
                ${s.status === 'working' ? `<rect x="${x - 3}" y="${-h / 2 - 3}" width="${w + 6}" height="${h + 6}" rx="12" class="smm-pulse"/>` : ''}
                <circle r="4.5" class="smm-joint" fill="${n.color}"/>
                <rect x="${x}" y="${-h / 2}" width="${w}" height="${h}" rx="${n.sub ? 4 : s.kind === 'chat' ? 16 : 10}" class="smm-card smm-${s.status}" style="--c:${n.color}"/>
                ${s.kind === 'chat' ? `<path d="M${right ? x + 16 : x + w - 16},${h / 2 - 0.5}l${right ? 0 : 0},8l${right ? 9 : -9},-8z" class="smm-card smm-tail smm-${s.status}" style="--c:${n.color}"/>` : ''}
                <text x="${x + w - 7}" y="${-h / 2 + 11}" text-anchor="end" class="smm-kind-mark">${s.kind === 'chat' ? '대화' : '&lt;/&gt;'}</text>
                <text class="smm-label"><tspan x="${x + 12}" dy="-2">${n.seq ? `<tspan class="smm-seq">${n.seq}</tspan> ` : ''}${esc(title)}</tspan><tspan x="${x + 12}" dy="14" class="smm-time">${time}</tspan>${git ? `<tspan dx="8" class="smm-git smm-git-${s.git}">${git}</tspan>` : ''}</text>
                ${ctx ? `<rect x="${x + 6}" y="${h / 2 - 4}" width="${(w - 12).toFixed(1)}" height="2.5" rx="1.2" class="smm-ctx-track"/><rect x="${x + 6}" y="${h / 2 - 4}" width="${((w - 12) * Math.min(1, ctx.pct)).toFixed(1)}" height="2.5" rx="1.2" class="smm-ctx smm-ctx-${ctx.phase}"/>` : ''}
                ${where ? `<text x="${x + 12}" y="${h / 2 + 11}" class="smm-machine">${esc(where)}</text>` : ''}
                ${badge}
                ${n.prev && n.prev.length ? `<g class="smm-chain" transform="translate(${right ? x - 2 : x + w + 2},${h / 2})"><rect x="${right ? -30 : 0}" y="-8" width="30" height="16" rx="8"/><text x="${right ? -15 : 15}" text-anchor="middle" dy="4">이전 ${n.prev.length}</text></g>` : ''}
                ${!s.remote && !n.related ? this._addButton(right ? x + w + 14 : x - 14, 0, n.project.root, n.color, { parentId: s.id, topic: s.topic || '', label: '이 세션의 하위 세션', hover: true }) : ''}
                <title>${esc(s.title)}${n.prev && n.prev.length ? ` · 툰으로 이어진 이전 세션 ${n.prev.length}개` : ''}${ctx ? ` · 세션 분량 ${Math.round(ctx.pct * 100)}% (${SessionMindMap._k(ctx.tokens)} 토큰)` : ''}${count ? ` · 고친 파일 ${count}개` : ''}${git ? ` · ${SessionMindMap.GIT_LONG[s.git]}` : ''}${s.remote ? ` · ${esc(s.machine)} 의 세션 (읽기 전용)` : ''}</title></g>`;
        }

        // 파일: 문서 아이콘 + 이름
        const label = SessionMindMap._clip(n.label, 28);
        return `<g class="smm-node smm-file" data-key="${esc(n.key)}" ${at} tabindex="0">
            <path d="M-4.5,-6h5.5l3.5,3.5v8.5h-9z" class="smm-file-dot" stroke="${n.color}"/>
            <text x="${tx * 10}" dy="3.5" text-anchor="${right ? 'start' : 'end'}" class="smm-label smm-file-label">${esc(label)}</text>
            <title>${esc(n.data.rel || n.data.path)} · ${n.data.edits}번 수정</title></g>`;
    }

    // 폴더 모양: 왼쪽 위 탭 + 몸통
    static _folderShape(w, h, color) {
        const x = -w / 2, y = -h / 2 + 4;
        const tab = Math.min(46, w * 0.36);
        return `<g class="smm-folder" fill="${color}"><rect x="${x}" y="${y - 6}" width="${tab}" height="12" rx="3"/><rect x="${x}" y="${y}" width="${w}" height="${h - 4}" rx="7"/></g>`;
    }

    // 선택 강조와 "같은 파일을 고친 세션" 연결선
    _drawSelection() {
        this.gNodes.querySelectorAll('.smm-on, .smm-dim').forEach(el => el.classList.remove('smm-on', 'smm-dim'));
        this.gX.innerHTML = '';
        this.svg.classList.toggle('smm-has-sel', !!this.selected);
        if (!this.selected) return;
        const sel = this.byKey.get(this.selected.key);
        if (!sel) { this.selected = null; this.svg.classList.remove('smm-has-sel'); return; }

        const on = new Set([sel.key]);
        const lines = [];
        const sessionsByPath = this._sessionsByPath();

        if (sel.kind === 'project') {
            sel.children.forEach(c => { on.add(c.key); c.children.forEach(f => on.add(f.key)); });
        } else if (sel.kind === 'session') {
            sel.children.forEach(f => on.add(f.key));
            for (const f of sel.data.files) {
                for (const other of sessionsByPath.get(f.path) || []) {
                    if (other.key === sel.key) continue;
                    on.add(other.key);
                    const from = sel.children.find(c => c.data.path === f.path) || sel;
                    lines.push(SessionMindMap._chord(from, other));
                }
            }
        } else if (sel.kind === 'file') {
            for (const s of sessionsByPath.get(sel.data.path) || []) {
                on.add(s.key);
                s.children.forEach(f => { if (f.data.path === sel.data.path) on.add(f.key); });
                if (s.key !== this._parentKey(sel)) lines.push(SessionMindMap._chord(sel, s));
            }
            on.add(this._parentKey(sel));
        }

        this.gX.innerHTML = [...new Set(lines)].map(d => `<path class="smm-xlink" d="${d}"/>`).join('');
        this.gNodes.querySelectorAll('.smm-node').forEach(el => {
            if (el.dataset.key === 'root') return;
            el.classList.add(on.has(el.dataset.key) ? 'smm-on' : 'smm-dim');
        });
    }

    _parentKey(fileNode) { return this._sessionKey(fileNode.project, fileNode.session); }

    _sessionsByPath() {
        const map = new Map();
        for (const n of this.nodes) {
            if (n.kind !== 'session') continue;
            for (const f of n.data.files) {
                if (!map.has(f.path)) map.set(f.path, []);
                map.get(f.path).push(n);
            }
        }
        return map;
    }

    // ---------------------------------------------------------------------
    // 클릭
    // ---------------------------------------------------------------------
    // 폴더의 + 버튼 (onAddSession 이 있을 때만)
    /** 접기·펼치기 단추: 접혀 있으면 "▸ 숨은 수", 펼쳐 있으면 "▾" */
    _foldChip(x, y, n, what) {
        if (!n.hidden && !n.children.length) return '';
        const esc = SessionMindMap._esc;
        const text = n.hidden ? `▸ ${n.hidden}` : '▾';
        const w = n.hidden ? SessionMindMap._textWidth(text, 10.5) + 12 : 20;
        return `<g class="smm-fold${n.hidden ? ' smm-folded' : ''}" data-fold="${esc(n.key)}" transform="translate(${x},${y})" role="button" aria-label="${n.hidden ? `${what} ${n.hidden}개 펼치기` : '접기'}">
            <rect x="${-w / 2}" y="-8" width="${w}" height="16" rx="8" stroke="${n.color}"/><text text-anchor="middle" dy="3.5">${text}</text><title>${n.hidden ? `${what} ${n.hidden}개 펼치기` : '접기'}</title></g>`;
    }

    _addButton(x, y, root, color, meta = {}) {
        if (!this.onAddSession) return '';
        const esc = SessionMindMap._esc;
        const label = meta.label || '이 폴더에 새 세션';
        return `<g class="smm-add${meta.hover ? ' smm-add-hover' : ''}" data-add="${esc(root)}"${meta.topic ? ` data-topic="${esc(meta.topic)}"` : ''}${meta.parentId ? ` data-parent="${esc(meta.parentId)}"` : ''} transform="translate(${x},${y})" role="button" aria-label="${esc(label)}">
            <circle r="${meta.hover ? 8 : 10}" stroke="${color}"/><path d="M-4,0H4M0,-4V4"/><title>${esc(label)}</title></g>`;
    }

    // ---------------------------------------------------------------------
    // 노드 끌기: 아무 노드나 끌어서 원하는 자리에 둔다 (그 아래 노드도 같이 따라온다, 보기마다 기억)
    // 세션은 다른 세션 위 = 그 아래로 붙이기, 가지 위 = 그 가지로, 폴더 위 = 폴더 바로 아래로 (다른 폴더면 복사)
    // ---------------------------------------------------------------------
    _bindDrag() {
        const ghost = document.createElement('div');
        ghost.className = 'smm-ghost';
        ghost.hidden = true;
        this.container.querySelector('.smm-root').appendChild(ghost);
        let d = null;
        const targetAt = (x, y) => {
            const el = document.elementFromPoint(x, y);
            const g = el && el.closest && el.closest('.smm-node');
            return g && this.byKey.get(g.dataset.key) || null;
        };
        const clear = () => this.gNodes.querySelectorAll('.smm-drop-ok, .smm-drop-no').forEach(el => el.classList.remove('smm-drop-ok', 'smm-drop-no'));
        const subtree = n => { const out = [n]; for (let i = 0; i < out.length; i++) out.push(...out[i].children); return out; };

        this.svg.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target.closest('.smm-add, .smm-fold')) return;
            const g = e.target.closest('.smm-node');
            if (!g || g.dataset.key === 'root') return;
            const n = this.byKey.get(g.dataset.key);
            if (!n) return;
            // 붙이기는 이 기기의 진짜 세션만 ("같은 파일을 고친 세션"·다른 기기 세션은 자리만 옮긴다)
            const linkable = !!this.onDropSession && n.kind === 'session' && !n.related && !n.data.remote;
            d = { n, linkable, x: e.clientX, y: e.clientY, started: false, id: e.pointerId };
        });
        window.addEventListener('pointermove', e => {
            if (!d || e.pointerId !== d.id) return;
            if (!d.started) {
                if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 7) return;
                d.started = true;
                d.moving = subtree(d.n).map(m => ({ m, x: m.x, y: m.y, g: this.gNodes.querySelector(`[data-key="${CSS.escape(m.key)}"]`) }));
                d.moving.forEach(o => o.g && o.g.classList.add('smm-moving'));
                this.svg.classList.add('smm-dragging');
                if (this.info) this.info.hidden = true;
            }
            // 화면에서 움직인 만큼 지도 좌표로 옮긴다
            const dx = (e.clientX - d.x) / this.view.k, dy = (e.clientY - d.y) / this.view.k;
            for (const o of d.moving) {
                o.m.x = o.x + dx; o.m.y = o.y + dy; o.m.moved = true;
                if (o.g) o.g.setAttribute('transform', `translate(${o.m.x.toFixed(1)},${o.m.y.toFixed(1)})`);
            }
            this._drawLinks();
            this.gX.innerHTML = '';

            clear();
            const t = d.linkable ? targetAt(e.clientX, e.clientY) : null;
            d.target = t && t !== d.n && this._dropAllowed(d.n, t) ? t : null;
            if (d.target) {
                const g = this.gNodes.querySelector(`[data-key="${CSS.escape(t.key)}"]`);
                if (g) g.classList.add('smm-drop-ok');
                const rect = this.container.getBoundingClientRect();
                ghost.textContent = this._dropHint(d.n, t);
                ghost.style.left = (e.clientX - rect.left + 14) + 'px';
                ghost.style.top = (e.clientY - rect.top + 12) + 'px';
                ghost.hidden = false;
            } else {
                ghost.hidden = true;
            }
        });
        window.addEventListener('pointerup', e => {
            if (!d || e.pointerId !== d.id) return;
            const drag = d;
            d = null;
            if (!drag.started) return;
            ghost.hidden = true;
            this.svg.classList.remove('smm-dragging');
            clear();
            this._suppressClick = true;
            setTimeout(() => { this._suppressClick = false; }, 0);
            if (drag.target) {
                // 붙이기: 자리는 그대로 두고 (다시 그리면 원래 자리) 허브에 맡긴다
                this.render();
                this.onDropSession(drag.n, drag.target);
                return;
            }
            // 자리 옮기기: 놓은 노드를 그 자리에 고정. 그 아래에 고정해 둔 노드도 같이 옮긴다
            const vk = this._viewKey();
            const pins = this.pins[vk] || (this.pins[vk] = {});
            const ddx = drag.n.x - drag.moving[0].x, ddy = drag.n.y - drag.moving[0].y;
            for (const o of drag.moving.slice(1)) {
                const p = pins[o.m.key];
                if (p) pins[o.m.key] = [p[0] + ddx, p[1] + ddy];
            }
            pins[drag.n.key] = [Math.round(drag.n.x), Math.round(drag.n.y)];
            this._savePins();
            this.render();
            this._drawSelection();
        });
        window.addEventListener('pointercancel', e => {
            if (!d || e.pointerId !== d.id) return;
            const started = d.started;
            d = null;
            ghost.hidden = true;
            this.svg.classList.remove('smm-dragging');
            clear();
            if (started) this.render();
        });
    }

    // 놓을 수 있는 곳: 세션(자기 하위 세션 제외), 폴더, 가운데의 폴더·세션
    _dropAllowed(src, t) {
        if (t.kind === 'topic') return t.project.root === src.project.root && src.data.topic !== t.topic;
        const tSession = t.kind === 'session' ? t.data : t.kind === 'root' && t.ref && t.ref.kind === 'session' ? t.ref.data : null;
        const tProject = t.kind === 'project' ? t.data : t.kind === 'root' && t.ref && t.ref.kind === 'project' ? t.ref.data : null;
        if (tSession && tSession.remote) return false; // 다른 기기 세션 아래로는 못 붙인다
        if (tSession) {
            const tp = t.kind === 'session' ? t.project : t.ref.project;
            if (tSession.id === src.data.id && tp.root === src.project.root) return false;
            if (tp.root !== src.project.root) return true;
            // 자기 하위 세션 아래로는 안 됨
            const byId = new Map(src.project.sessions.map(x => [x.id, x]));
            for (let cur = tSession, guard = 0; cur && guard < 1000; cur = byId.get(cur.parentId), guard++) if (cur.id === src.data.id) return false;
            return true;
        }
        return !!tProject && !tProject.remoteOnly;
    }

    _dropHint(src, t) {
        if (t.kind === 'topic') return `${t.label} 가지로 옮기기`;
        const tp = t.kind === 'session' ? t.project : t.kind === 'project' ? t.data : t.ref.kind === 'project' ? t.ref.data : t.ref.project;
        const same = tp.root === src.project.root;
        const isSession = t.kind === 'session' || (t.ref && t.ref.kind === 'session');
        if (isSession) return same ? '이 세션 아래로 붙이기' : `${tp.name} 폴더로 복사해서 이 세션 아래로`;
        return same ? '폴더 바로 아래로 떼어내기' : `${tp.name} 폴더로 복사`;
    }

    _onNodeClick(e) {
        if (this._suppressClick) return;
        const fold = e.target.closest('.smm-fold');
        if (fold) {
            e.stopPropagation();
            this._toggleFold(fold.dataset.fold);
            return;
        }
        const add = e.target.closest('.smm-add');
        if (add) {
            e.stopPropagation();
            if (this.onAddSession) this.onAddSession(add.dataset.add, { topic: add.dataset.topic || undefined, parentId: add.dataset.parent || undefined });
            return;
        }
        const g = e.target.closest('.smm-node');
        if (!g) return;
        if (g.classList.contains('smm-pending')) {
            const n = this.byKey.get(g.dataset.key);
            if (n && this.onAddSession) this.onAddSession(n.project.root);
            return;
        }
        const n = this.byKey.get(g.dataset.key);
        if (!n) return;
        if (n.kind === 'root') {
            this.selected = null;
            this._drawSelection();
            this.info.hidden = true;
            if (this.onSelect) this.onSelect(n.ref ? { ...n.ref, isRoot: true } : { kind: 'all', isRoot: true });
            return;
        }
        // onSelect 가 true 를 돌려주면 (예: 허브가 가운데를 바꿈) 여기서 멈춘다
        if (this.onSelect && this.onSelect(n) === true) return;
        if (n.kind === 'session' && n.data.files.length) {
            // 같은 세션을 다시 누르면 파일을 접고 펼친다
            if (this.selected && this.selected.key === n.key) {
                if (this.expanded.has(n.key)) this.expanded.delete(n.key); else this.expanded.add(n.key);
                this.render();
                this._showInfo(this.byKey.get(n.key));
                return;
            }
            if (!this.expanded.has(n.key) && !this.showAllFiles) {
                this.expanded.add(n.key);
                this.selected = { key: n.key };
                this.render();
                this._showInfo(this.byKey.get(n.key));
                this._reveal(this.byKey.get(n.key));
                return;
            }
        }
        this.selected = { key: n.key };
        this._drawSelection();
        this._showInfo(n);
    }

    _showInfo(n) {
        if (!n) return;
        if (!this.infoKinds.has(n.kind)) { this.info.hidden = true; return; }
        const esc = SessionMindMap._esc;
        const now = this.now();
        let html = '';
        if (n.kind === 'project') {
            const p = n.data;
            const next = p.hub && p.hub.next.length
                ? `<dt>툰 허브 NEXT</dt><dd><ul class="smm-list">${p.hub.next.map(l => `<li>${esc(l)}</li>`).join('')}</ul></dd>` : '';
            const topics = p.hub && p.hub.topics.length ? `<dt>주제 허브</dt><dd>${p.hub.topics.map(t => `<span class="smm-chip">${esc(t)}</span>`).join(' ')}</dd>` : '';
            html = `<h4><i class="smm-swatch" style="background:${n.color}"></i>${esc(p.name)}</h4>
                <dl><dt>폴더</dt><dd class="smm-mono">${esc(p.root)}</dd>
                <dt>세션</dt><dd>${p.sessions.length}개 · 마지막 ${SessionMindMap._ago(p.lastAt, now)}</dd>${next}${topics}</dl>
                <div class="smm-actions"><button class="smm-btn" data-act="toggle-project">${n.hidden ? '세션 펼치기' : '세션 접기'}</button></div>`;
        } else if (n.kind === 'session') {
            const s = n.data;
            const files = s.files.map(f => `<li><button class="smm-link-btn" data-act="select-file" data-path="${esc(f.path)}">${esc(f.rel || f.path)}</button><span class="smm-muted"> ${f.edits}</span></li>`).join('');
            const resume = `cd ${SessionMindMap._shellQuote(s.cwd)} && claude --resume ${s.id}`;
            const where = this._machineOf(s);
            html = `<h4>${esc(s.title)}</h4>
                <div class="smm-meta"><span class="smm-pill smm-${s.status}">${SessionMindMap.STATUS[s.status]}</span><span>${esc(n.project.name)}</span>${s.gitBranch ? `<span class="smm-mono">${esc(s.gitBranch)}</span>` : ''}${s.git ? `<span class="smm-git-pill smm-git-${s.git}">${SessionMindMap.GIT[s.git]}</span>` : ''}</div>
                <dl>${s.remote ? `<dt>기기</dt><dd>${esc(s.machine)} · 읽기 전용 (대화는 그 기기에서 열어요)</dd>` : where ? `<dt>기기</dt><dd>${esc(where)} 에만 있어요 · ${SessionMindMap.GIT_LONG[s.git]}</dd>` : ''}
                <dt>기간</dt><dd>${SessionMindMap._fmt(s.firstAt)} → ${SessionMindMap._fmt(s.lastAt)} (${SessionMindMap._ago(s.lastAt, now)})</dd>
                ${s.costUSD != null ? `<dt>비용</dt><dd>$${s.costUSD.toFixed(2)}</dd>` : ''}
                <dt>고친 파일 ${s.files.length}개</dt><dd>${files ? `<ul class="smm-list smm-files">${files}</ul>` : '<span class="smm-muted">파일 수정 없음</span>'}</dd>
                <dt>${s.remote ? `${esc(s.machine)} 에서 열기` : '이어서 하기'}</dt><dd><code class="smm-cmd">${esc(resume)}</code></dd></dl>
                <div class="smm-actions"><button class="smm-btn" data-act="copy" data-text="${esc(resume)}">명령 복사</button>
                ${s.files.length ? `<button class="smm-btn" data-act="toggle-files" data-key="${esc(n.key)}">${this.expanded.has(n.key) || this.showAllFiles ? '파일 접기' : '파일 펼치기'}</button>` : ''}</div>`;
        } else if (n.kind === 'file') {
            const f = n.data;
            const sessions = (this._sessionsByPath().get(f.path) || [])
                .map(s => `<li><button class="smm-link-btn" data-act="select" data-key="${esc(s.key)}">${esc(s.data.title)}</button><span class="smm-muted"> ${SessionMindMap._ago(s.data.lastAt, now)}</span></li>`).join('');
            html = `<h4 class="smm-mono">${esc(f.rel || f.path)}</h4>
                <dl><dt>이 파일을 고친 세션</dt><dd><ul class="smm-list">${sessions}</ul></dd>
                <dt>전체 경로</dt><dd class="smm-mono">${esc(f.path)}</dd></dl>
                <div class="smm-actions">${this.ipc ? `<button class="smm-btn smm-primary" data-act="open-code" data-path="${esc(f.path)}">코드 보기</button>` : ''}</div>`;
        }
        this.info.innerHTML = `<button class="smm-close" data-act="close" aria-label="닫기">×</button>${html}`;
        this.info.style.setProperty('--smm-info-top', this._toolbarBottom() + 'px');
        this.info.hidden = false;
    }

    _onInfoClick(e) {
        const b = e.target.closest('[data-act]');
        if (!b) return;
        const act = b.dataset.act;
        if (act === 'close') { this.info.hidden = true; this.selected = null; this._drawSelection(); return; }
        if (act === 'copy') { this._copy(b.dataset.text); return; }
        if (act === 'open-code') { this.ipc.send('read-file', { path: b.dataset.path }); return; }
        if (act === 'select') { this._select(b.dataset.key); return; }
        if (act === 'select-file') {
            const sel = this.byKey.get(this.selected && this.selected.key);
            if (sel && sel.kind === 'session' && !this.expanded.has(sel.key) && !this.showAllFiles) { this.expanded.add(sel.key); this.render(); }
            const fileNode = this.nodes.find(n => n.kind === 'file' && n.data.path === b.dataset.path && sel && this._parentKey(n) === sel.key);
            if (fileNode) this._select(fileNode.key);
            return;
        }
        if (act === 'toggle-files') {
            const key = b.dataset.key;
            if (this.expanded.has(key)) this.expanded.delete(key); else this.expanded.add(key);
            this.render();
            this._showInfo(this.byKey.get(key));
            this._reveal(this.byKey.get(key));
            return;
        }
        if (act === 'toggle-project') {
            const sel = this.byKey.get(this.selected.key);
            const root = sel.data.root;
            this.fold.set(`p:${root}`, !!sel.hidden);
            this.render();
            this._showInfo(this.byKey.get(`p:${root}`));
        }
    }

    _select(key) {
        const n = this.byKey.get(key);
        if (!n) return;
        this.selected = { key };
        this._drawSelection();
        this._showInfo(n);
        this._centerOn(n);
    }

    async _copy(text) {
        try {
            await navigator.clipboard.writeText(text);
            this._toast('복사했어요');
        } catch {
            const code = this.info.querySelector('.smm-cmd');
            if (code) {
                const r = document.createRange();
                r.selectNodeContents(code);
                const s = window.getSelection();
                s.removeAllRanges();
                s.addRange(r);
            }
            this._toast('선택해 뒀어요. Cmd+C로 복사하세요');
        }
    }

    _toast(msg) {
        this.toastEl.textContent = msg;
        this.toastEl.hidden = false;
        clearTimeout(this._toastTimer);
        this._toastTimer = setTimeout(() => { this.toastEl.hidden = true; }, 1600);
    }

    _setStatus(text) { if (this.statusEl) this.statusEl.textContent = text; }

    // ---------------------------------------------------------------------
    // 확대·이동
    // ---------------------------------------------------------------------
    // (mx, my) 화면 점을 고정한 채로 배율을 k 로 바꾼다
    _zoomAt(mx, my, k) {
        k = Math.min(4, Math.max(0.15, k));
        const f = k / this.view.k;
        this.view.x = mx - (mx - this.view.x) * f;
        this.view.y = my - (my - this.view.y) * f;
        this.view.k = k;
        this._applyView();
    }

    _bindPanZoom() {
        const svg = this.svg;
        let drag = null;
        const touches = new Map(); // 두 손가락 확대용
        let pinch = null;
        svg.addEventListener('wheel', e => {
            e.preventDefault();
            const rect = svg.getBoundingClientRect();
            this._zoomAt(e.clientX - rect.left, e.clientY - rect.top, this.view.k * Math.exp(-e.deltaY * 0.0015));
        }, { passive: false });
        svg.addEventListener('pointerdown', e => {
            if (e.pointerType === 'touch') {
                touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
                if (touches.size === 2) {
                    const [a, b] = [...touches.values()];
                    pinch = { d: Math.hypot(a.x - b.x, a.y - b.y) || 1, k: this.view.k };
                    drag = null;
                    return;
                }
            }
            if (e.target.closest('.smm-node')) return;
            drag = { x: e.clientX, y: e.clientY, vx: this.view.x, vy: this.view.y, moved: false };
            svg.setPointerCapture(e.pointerId);
        });
        svg.addEventListener('pointermove', e => {
            if (touches.has(e.pointerId)) touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pinch && touches.size === 2) {
                const [a, b] = [...touches.values()];
                const rect = svg.getBoundingClientRect();
                const d = Math.hypot(a.x - b.x, a.y - b.y);
                this._zoomAt((a.x + b.x) / 2 - rect.left, (a.y + b.y) / 2 - rect.top, pinch.k * d / pinch.d);
                return;
            }
            if (!drag) return;
            const dx = e.clientX - drag.x, dy = e.clientY - drag.y;
            if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
            this.view.x = drag.vx + dx;
            this.view.y = drag.vy + dy;
            this._applyView();
        });
        const end = e => {
            if (drag && !drag.moved && !e.target.closest('.smm-node')) {
                this.selected = null;
                this._drawSelection();
                this.info.hidden = true;
            }
            drag = null;
        };
        const lift = e => {
            touches.delete(e.pointerId);
            if (touches.size < 2) pinch = null;
        };
        svg.addEventListener('pointerup', e => { const wasPinch = !!pinch; lift(e); if (!wasPinch) end(e); });
        svg.addEventListener('pointercancel', e => { lift(e); drag = null; });
        svg.addEventListener('dblclick', e => { if (!e.target.closest('.smm-node')) this._fit(true); });
    }

    _applyView() {
        const { x, y, k } = this.view;
        this.gView.setAttribute('transform', `translate(${x.toFixed(1)},${y.toFixed(1)}) scale(${k.toFixed(4)})`);
        this.svg.classList.toggle('smm-zoomed', k >= 1.1);
        this.svg.classList.toggle('smm-dense', this.showAllFiles);
    }

    _fit(animate) {
        const rect = this.svg.getBoundingClientRect();
        if (!rect.width || !rect.height || !this.nodes.length) return;
        this._fitPending = false;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const n of this.nodes) {
            const b = this._box(n); // 카드·꼬리표까지 다 들어오게
            x0 = Math.min(x0, n.x + b[0] - 16); x1 = Math.max(x1, n.x + b[1] + 16);
            y0 = Math.min(y0, n.y + b[2] - 12); y1 = Math.max(y1, n.y + b[3] + 12);
        }
        const top = this._toolbarBottom(), bottom = 36; // 도구 막대, 범례
        const h = rect.height - top - bottom;
        const k = Math.min(1.3, Math.max(0.15, Math.min(rect.width / (x1 - x0), h / (y1 - y0))));
        const target = { k, x: rect.width / 2 - ((x0 + x1) / 2) * k, y: top + h / 2 - ((y0 + y1) / 2) * k };
        this._animateTo(target, animate);
    }

    // 정보 패널을 뺀 나머지 화면
    _visibleArea() {
        const rect = this.svg.getBoundingClientRect();
        const panel = this.info.hidden ? 0 : this.info.getBoundingClientRect().width + 20;
        return { w: Math.max(200, rect.width - panel), h: rect.height, top: this._toolbarBottom(), bottom: 36 };
    }

    // 도구 막대는 좁은 화면에서 두 줄이 될 수 있어서 실제 높이를 잰다
    _toolbarBottom() {
        const bar = this.container && this.container.querySelector('.smm-toolbar');
        return bar ? bar.offsetTop + bar.offsetHeight + 12 : 56;
    }

    _centerOn(n) {
        const a = this._visibleArea();
        const k = Math.max(this.view.k, 0.9);
        this._animateTo({ k, x: a.w / 2 - n.x * k, y: a.top + (a.h - a.top - a.bottom) / 2 - n.y * k }, true);
    }

    // 세션과 펼친 파일이 모두 보이게 옮긴다 (이미 보이면 그대로)
    _reveal(n) {
        if (!n) return;
        const pts = [n, ...n.children];
        const a = this._visibleArea();
        const pad = 140;
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of pts) { x0 = Math.min(x0, p.x - pad); x1 = Math.max(x1, p.x + pad); y0 = Math.min(y0, p.y - 20); y1 = Math.max(y1, p.y + 20); }
        const { x, y, k } = this.view;
        const inside = x0 * k + x >= 0 && x1 * k + x <= a.w && y0 * k + y >= a.top && y1 * k + y <= a.h - a.bottom;
        if (inside) return;
        const kk = Math.min(k, Math.max(0.15, Math.min(a.w / (x1 - x0), (a.h - a.top - a.bottom) / (y1 - y0))));
        this._animateTo({ k: kk, x: a.w / 2 - ((x0 + x1) / 2) * kk, y: a.top + (a.h - a.top - a.bottom) / 2 - ((y0 + y1) / 2) * kk }, true);
    }

    _animateTo(target, animate) {
        const reduce = typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!animate || reduce) { this.view = target; this._applyView(); return; }
        const from = { ...this.view };
        const t0 = performance.now();
        const step = t => {
            const p = Math.min(1, (t - t0) / 280);
            const e = 1 - Math.pow(1 - p, 3);
            this.view = { x: from.x + (target.x - from.x) * e, y: from.y + (target.y - from.y) * e, k: from.k + (target.k - from.k) * e };
            this._applyView();
            if (p < 1) requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
    }

    _resizeSoon() {
        clearTimeout(this._resizeTimer);
        this._resizeTimer = setTimeout(() => {
            if (!this.data) return;
            if (this._fitPending) this._fit(false);
        }, 60);
    }

    // ---------------------------------------------------------------------
    // 도우미
    // ---------------------------------------------------------------------
    // 자리를 옮긴 노드는 부드러운 S 곡선, 나머지는 방사형 곡선
    static _link(a, b) {
        if (!b.moved) return SessionMindMap._radialLink(a, b);
        const ax = a.depth === 0 ? 0 : a.x, ay = a.depth === 0 ? 0 : a.y;
        const mx = (ax + b.x) / 2;
        return `M${ax.toFixed(1)},${ay.toFixed(1)}C${mx.toFixed(1)},${ay.toFixed(1)} ${mx.toFixed(1)},${b.y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    }

    static _radialLink(a, b) {
        const mid = (a.r + b.r) / 2;
        const c1x = mid * Math.cos(a.angle), c1y = mid * Math.sin(a.angle);
        const c2x = mid * Math.cos(b.angle), c2y = mid * Math.sin(b.angle);
        const sx = a.depth === 0 ? 0 : a.x, sy = a.depth === 0 ? 0 : a.y;
        return `M${sx.toFixed(1)},${sy.toFixed(1)}C${(a.depth === 0 ? 0 : c1x).toFixed(1)},${(a.depth === 0 ? 0 : c1y).toFixed(1)} ${c2x.toFixed(1)},${c2y.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    }

    // 원 안쪽으로 휘는 연결선 (두 노드 사이)
    static _chord(a, b) {
        const mx = (a.x + b.x) / 2 * 0.45, my = (a.y + b.y) / 2 * 0.45;
        return `M${a.x.toFixed(1)},${a.y.toFixed(1)}Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
    }

    static _base(p) { const parts = String(p).split(/[\\/]/); return parts[parts.length - 1] || p; }
    static _clip(s, n) { s = String(s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
    static _esc(s) { return String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])); }
    static _shellQuote(s) { return /^[\w@%+=:,./~-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`; }
    static _textWidth(s, size) {
        let w = 0;
        for (const ch of s) w += /[ᄀ-ᇿ㄰-㆏가-힯一-鿿]/.test(ch) ? size : size * 0.6;
        return w;
    }
    static _fmt(ms) {
        const d = new Date(ms);
        const p = v => String(v).padStart(2, '0');
        return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
    }
    // 세션 기간: 같은 날이면 "10-03 12:16~14:57", 다른 날이면 "10-01 23:26~10-02 06:59"
    static _span(first, last) {
        const a = SessionMindMap._fmt(first), b = SessionMindMap._fmt(last);
        if (!first || a === b) return b;
        return a.slice(0, 5) === b.slice(0, 5) ? `${a}~${b.slice(6)}` : `${a}~${b}`;
    }

    /**
     * 캐시 타이머: 마지막 메시지 뒤 1시간까지는 Claude 가 앞 대화를 캐시로 싸게 다시 읽는다.
     * 55분이 넘으면 'soon' (툰 할 때), 1시간이 넘으면 'over'. 세션 시작이 아니라 마지막 메시지 기준이다.
     * @returns {{ phase: 'ok'|'soon'|'over', left: number }} left = 남은 ms
     */
    static cachePhase(lastAt, now, ttlMs = SessionMindMap.CACHE_MS) {
        const left = ttlMs - (now - lastAt);
        const warn = Math.min(SessionMindMap.CACHE_WARN_MS, ttlMs / 5);
        return { left, phase: left <= 0 ? 'over' : left <= warn ? 'soon' : 'ok' };
    }

    /** 세션의 캐시 유지 시간: 기록에 적힌 캐시 종류(1h/5m), 모르면 1시간 */
    static cacheMs(s) {
        return s && s.context && s.context.ttl === '5m' ? 5 * 60e3 : SessionMindMap.CACHE_MS;
    }

    /**
     * 세션 분량(컨텍스트 토큰): 마지막 답 기준.
     * 창 크기는 기록에 안 나와서 모델 이름으로 정한다 (contextWindow).
     * @returns {{ tokens, window, pct, phase: 'ok'|'warn'|'full' } | null}
     */
    static contextInfo(s) {
        const c = s && s.context;
        if (!c || !c.tokens) return null;
        const window = SessionMindMap.contextWindow(c.model, c.tokens);
        const pct = c.tokens / window;
        return { tokens: c.tokens, window, pct, phase: pct >= SessionMindMap.CONTEXT_FULL ? 'full' : pct >= SessionMindMap.CONTEXT_WARN ? 'warn' : 'ok' };
    }

    /**
     * 창 크기: 이름에 [1m] 이 붙었거나 Claude 5 계열(claude-opus-5-5 등)이면 100만, 아니면 20만.
     * 20만을 이미 넘었으면 100만 창으로 본다.
     */
    static contextWindow(model, tokens) {
        if (tokens > SessionMindMap.CONTEXT_SMALL) return SessionMindMap.CONTEXT_LARGE;
        return SessionMindMap.LARGE_MODEL_RE.test(model || '') ? SessionMindMap.CONTEXT_LARGE : SessionMindMap.CONTEXT_SMALL;
    }

    /**
     * 툰 알람(깜박): 세션 분량 기준.
     *   - 80% 넘음 → 곧 자동 요약, 툰 할 때
     *   - 50% 넘은 큰 세션인데 캐시가 곧 끝남 → 다음 메시지가 큰 대화를 비싸게 다시 읽으니 툰 할 때
     * @returns {'full'|'cache'|null}
     */
    static alarm(s, now) {
        if (!s || s.remote) return null;
        const ctx = SessionMindMap.contextInfo(s);
        if (!ctx) return null;
        if (ctx.phase === 'full') return 'full';
        if (ctx.pct >= SessionMindMap.CONTEXT_BIG && SessionMindMap.cachePhase(s.lastAt, now, SessionMindMap.cacheMs(s)).phase === 'soon') return 'cache';
        return null;
    }

    static _k(n) { return n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'k'; }

    static _ago(ms, now) {
        const s = Math.max(0, (now - ms) / 1000);
        if (s < 60) return '방금';
        if (s < 3600) return `${Math.floor(s / 60)}분 전`;
        if (s < 86400) return `${Math.floor(s / 3600)}시간 전`;
        return `${Math.floor(s / 86400)}일 전`;
    }

    static _injectStyle() {
        if (document.getElementById('smm-style')) return;
        const style = document.createElement('style');
        style.id = 'smm-style';
        style.textContent = `
        .smm-root { --smm-bg:#16191d; --smm-panel:#1f2329; --smm-ink:#d7dde4; --smm-muted:#8a95a1; --smm-line:#323943;
          --smm-working:#4ec9b0; --smm-accent:#4ec9b0;
          position:relative; width:100%; height:100%; background:var(--smm-bg); color:var(--smm-ink); overflow:hidden;
          font-family:-apple-system, "Apple SD Gothic Neo", "Segoe UI", sans-serif; font-size:12px; }
        .smm-toolbar { position:absolute; z-index:2; top:8px; left:8px; right:8px; display:flex; flex-wrap:wrap; gap:6px; align-items:center;
          padding:6px 8px; background:color-mix(in srgb, var(--smm-panel) 92%, transparent); border:1px solid var(--smm-line); border-radius:8px; }
        .smm-title { font-size:13px; margin-right:4px; }
        .smm-compact .smm-title, .smm-compact .smm-refresh { display:none; }
        .smm-search, .smm-period { background:var(--smm-bg); color:var(--smm-ink); border:1px solid var(--smm-line); border-radius:6px; padding:4px 8px; font:inherit; }
        .smm-search { width:150px; }
        .smm-check { display:flex; align-items:center; gap:4px; color:var(--smm-muted); }
        .smm-btn { background:var(--smm-bg); color:var(--smm-ink); border:1px solid var(--smm-line); border-radius:6px; padding:4px 10px; font:inherit; cursor:pointer; }
        .smm-btn:hover { border-color:var(--smm-accent); }
        .smm-primary { background:var(--smm-accent); color:#0b1512; border-color:var(--smm-accent); font-weight:600; }
        .smm-status { color:var(--smm-muted); margin-left:auto; font-variant-numeric:tabular-nums; }
        .smm-svg { width:100%; height:100%; display:block; cursor:grab; touch-action:none; user-select:none; }
        .smm-svg:active { cursor:grabbing; }
        .smm-ring { fill:none; stroke:var(--smm-line); stroke-dasharray:2 6; opacity:.6; }
        .smm-link { fill:none; stroke-width:2.2; opacity:.5; stroke-linecap:round; }
        .smm-link-project { stroke-width:6; opacity:.6; }
        .smm-link-file { stroke-width:1; opacity:.35; }
        .smm-link-pending { stroke-dasharray:4 4; }
        .smm-xlink { fill:none; stroke:var(--smm-working); stroke-width:1.6; stroke-dasharray:5 4; opacity:.9; }
        .smm-node { cursor:pointer; transition:opacity .15s; }
        .smm-core { fill:var(--smm-panel); stroke:var(--smm-accent); stroke-width:2.5; }
        .smm-core-ring { fill:none; stroke:var(--smm-accent); stroke-width:1; opacity:.45; }
        .smm-folder { stroke:rgba(0,0,0,.25); }
        .smm-folder-label { fill:#111; font-size:13px; font-weight:700; }
        .smm-big { font-size:15px; }
        .smm-root-node { cursor:pointer; }
        .smm-root-folder:hover .smm-folder, .smm-root-card:hover .smm-card { filter:brightness(1.12); }
        .smm-card { fill:color-mix(in srgb, var(--c) 16%, var(--smm-bg)); stroke:var(--c); stroke-width:1.5; }
        .smm-card.smm-idle { fill:var(--smm-bg); stroke-opacity:.55; stroke-dasharray:4 3; }
        .smm-card.smm-working { fill:color-mix(in srgb, var(--smm-working) 22%, var(--smm-bg)); stroke:var(--smm-working); stroke-width:2; }
        .smm-card-title { fill:var(--smm-ink); font-weight:700; }
        .smm-joint { stroke:var(--smm-bg); stroke-width:1.5; }
        .smm-badge-pill text { fill:#111; font-size:10px; font-weight:700; }
        .smm-hint { fill:var(--smm-muted); font-size:12px; }
        .smm-pending rect { fill:none; stroke-width:1.5; stroke-dasharray:4 4; }
        .smm-root-node:hover .smm-core { fill:var(--smm-bg); stroke-width:3; }
        .smm-core-label { fill:var(--smm-ink); font-size:14px; font-weight:700; }
        .smm-core-small { font-size:13px; }
        
        .smm-label { fill:var(--smm-ink); font-size:12px; paint-order:stroke; stroke:var(--smm-bg); stroke-width:3px; stroke-linejoin:round; }
        .smm-badge { fill:var(--smm-muted); font-size:10.5px; }
        .smm-add { cursor:pointer; }
        .smm-add circle { fill:var(--smm-panel); stroke-width:1.5; }
        .smm-add path { stroke:var(--smm-ink); stroke-width:1.8; stroke-linecap:round; }
        .smm-add:hover circle { fill:var(--smm-accent); stroke:var(--smm-accent); }
        .smm-add:hover path { stroke:#0b1512; }
        .smm-pending circle { fill:none; stroke-width:2; stroke-dasharray:3 3; }
        .smm-pending .smm-label { fill:var(--smm-accent); font-style:italic; }
        .smm-ghost { position:absolute; z-index:6; pointer-events:none; background:var(--smm-panel); border:1px solid var(--smm-accent); border-radius:8px;
          padding:5px 10px; font-size:12px; max-width:260px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; box-shadow:0 8px 20px rgba(0,0,0,.4); }
        .smm-ghost[data-hint]:not([data-hint=""])::after { content:attr(data-hint); display:block; color:var(--smm-accent); font-size:11px; margin-top:2px; }
        .smm-dragging { cursor:grabbing; }
        .smm-dragging .smm-node:not(.smm-drop-ok):not(.smm-moving) { opacity:.75; }
        .smm-node:not(.smm-root-node) { cursor:grab; }
        .smm-moving { pointer-events:none; opacity:.9; }
        .smm-fold { cursor:pointer; }
        .smm-project-quiet .smm-folder { opacity:.55; }
        .smm-fold rect { fill:var(--smm-panel); stroke-width:1.2; }
        .smm-fold text { fill:var(--smm-ink); font-size:10.5px; font-weight:600; }
        .smm-fold:hover rect { fill:var(--smm-accent); stroke:var(--smm-accent); }
        .smm-fold:hover text { fill:#0b1512; }
        .smm-drop-ok .smm-card, .smm-drop-ok .smm-folder, .smm-drop-ok .smm-core { stroke:var(--smm-working) !important; stroke-width:3 !important; stroke-dasharray:none !important; filter:drop-shadow(0 0 6px var(--smm-working)); }
        .smm-drop-no { opacity:.4; }
        .smm-session { cursor:grab; }
        .smm-seq { fill:var(--smm-accent); font-weight:700; font-variant-numeric:tabular-nums; }
        .smm-time { fill:var(--smm-muted); font-size:10.5px; font-family:ui-monospace, Menlo, Consolas, monospace; font-weight:400; }
        .smm-idle .smm-label { fill:var(--smm-muted); }
        .smm-git { font-size:10px; font-weight:700; font-family:ui-monospace, Menlo, Consolas, monospace; }
        .smm-git-pushed { fill:var(--smm-working); color:var(--smm-working); }
        .smm-git-ahead { fill:#e0b44c; color:#e0b44c; }
        .smm-git-dirty { fill:#ef7d6b; color:#ef7d6b; }
        .smm-git-pill { font-size:11px; font-weight:700; border:1px solid currentColor; border-radius:9px; padding:0 7px; }
        .smm-machine { fill:var(--smm-muted); font-size:10px; letter-spacing:.02em; paint-order:stroke; stroke:var(--smm-bg); stroke-width:3px; }
        .smm-remote .smm-card { stroke-dasharray:2 3; fill-opacity:.6; }
        .smm-remote.smm-session { cursor:pointer; }
        .smm-session-dot { stroke-width:2; }
        .smm-pulse { fill:none; stroke:var(--smm-working); stroke-width:2; animation:smm-pulse 1.8s ease-out infinite; transform-box:fill-box; transform-origin:center; }
        @keyframes smm-pulse { from { opacity:.9; transform:scale(1); } to { opacity:0; transform:scale(1.12); } }
        @media (prefers-reduced-motion: reduce) { .smm-pulse { animation:none; opacity:.6; } }
        .smm-alarm { fill:none; stroke:#e0b44c; stroke-width:2.5; animation:smm-blink 1s steps(2, start) infinite; }
        @keyframes smm-blink { to { visibility:hidden; } }
        @media (prefers-reduced-motion: reduce) { .smm-alarm { animation:none; } }
        .smm-ctx-track { fill:var(--smm-line); opacity:.6; }
        .smm-chip-chat { border-color:#b48ead !important; background:color-mix(in srgb, #b48ead 25%, transparent) !important; border-radius:8px; }
        .smm-kind-mark { fill:var(--smm-muted); font-size:8.5px; font-weight:700; font-family:ui-monospace, Menlo, Consolas, monospace; }
        .smm-kind-chat .smm-card { fill:color-mix(in srgb, #b48ead 14%, var(--smm-bg)); stroke:#b48ead; }
        .smm-kind-chat .smm-kind-mark { fill:#b48ead; }
        .smm-tail { stroke-dasharray:none; }
        .smm-topic-tag { fill:color-mix(in srgb, var(--c) 28%, var(--smm-bg)); stroke:var(--c); stroke-width:1.5; }
        .smm-topic-empty .smm-topic-tag { fill:var(--smm-bg); stroke-dasharray:4 3; }
        .smm-topic-label { fill:var(--smm-ink); font-size:12px; font-weight:700; }
        .smm-topic-empty .smm-topic-label { fill:var(--smm-muted); }
        .smm-topic:hover .smm-topic-tag { filter:brightness(1.2); }
        .smm-chain rect { fill:var(--smm-panel); stroke:var(--smm-line); }
        .smm-chain text { fill:var(--smm-muted); font-size:9.5px; font-weight:700; }
        .smm-add-hover { opacity:0; transition:opacity .15s; }
        .smm-session:hover .smm-add-hover, .smm-session.smm-on .smm-add-hover, .smm-session:focus-within .smm-add-hover { opacity:1; }
        .smm-ctx { fill:var(--smm-working); }
        .smm-ctx-warn { fill:#e0b44c; }
        .smm-ctx-full { fill:#ef7d6b; }
        .smm-working .smm-session-dot { fill:var(--smm-working); stroke:var(--smm-working); }
        .smm-file-dot { fill:var(--smm-panel); stroke-width:1.5; }
        .smm-file-label { font-size:11px; fill:var(--smm-muted); }
        .smm-dense .smm-file-label { opacity:0; }
        .smm-dense.smm-zoomed .smm-file-label, .smm-file.smm-on .smm-file-label, .smm-file:hover .smm-file-label { opacity:1; }
        .smm-has-sel .smm-dim { opacity:.18; }
        .smm-on .smm-label { fill:var(--smm-ink); font-weight:600; }
        .smm-node:focus, .smm-node:focus-visible { outline:none; }
        .smm-node:focus-visible circle, .smm-node:focus-visible rect { stroke:var(--smm-accent); stroke-width:3; }
        .smm-empty { fill:var(--smm-muted); font-size:14px; }
        .smm-legend { position:absolute; left:10px; bottom:10px; display:flex; flex-wrap:wrap; gap:12px; color:var(--smm-muted); font-size:11px; pointer-events:none; }
        .smm-legend span { display:flex; align-items:center; gap:5px; }
        .smm-dot { width:9px; height:9px; border-radius:50%; display:inline-block; border:2px solid var(--smm-muted); }
        .smm-dot.smm-working { background:var(--smm-working); border-color:var(--smm-working); }
        .smm-dot.smm-recent { background:var(--smm-muted); }
        .smm-dot.smm-idle { background:transparent; }
        .smm-chip-c { width:16px; height:10px; border-radius:3px; display:inline-block; border:1.5px solid var(--smm-muted); }
        .smm-chip-c.smm-working { border-color:var(--smm-working); background:color-mix(in srgb, var(--smm-working) 30%, transparent); }
        .smm-chip-c.smm-recent { background:color-mix(in srgb, var(--smm-muted) 35%, transparent); }
        .smm-chip-c.smm-idle { border-style:dashed; }
        .smm-dash { width:18px; border-top:2px dashed var(--smm-working); display:inline-block; }
        .smm-info { position:absolute; z-index:3; top:var(--smm-info-top, 56px); right:10px; width:min(340px, calc(100% - 20px)); max-height:calc(100% - 100px); overflow:auto;
          background:var(--smm-panel); border:1px solid var(--smm-line); border-radius:10px; padding:14px 16px; box-shadow:0 12px 32px rgba(0,0,0,.4); }
        .smm-info h4 { margin:0 22px 8px 0; font-size:14px; line-height:1.35; display:flex; align-items:center; gap:8px; overflow-wrap:anywhere; }
        .smm-info dl { margin:0; display:grid; gap:6px; }
        .smm-info dt { color:var(--smm-muted); font-size:10.5px; letter-spacing:.06em; margin-top:4px; }
        .smm-info dd { margin:0; overflow-wrap:anywhere; }
        .smm-close { position:absolute; top:8px; right:10px; background:none; border:0; color:var(--smm-muted); font-size:18px; cursor:pointer; }
        .smm-meta { display:flex; flex-wrap:wrap; gap:6px 10px; color:var(--smm-muted); margin-bottom:6px; align-items:center; }
        .smm-pill { padding:1px 8px; border-radius:999px; border:1px solid var(--smm-line); }
        .smm-pill.smm-working { background:var(--smm-working); color:#0b1512; border-color:var(--smm-working); }
        .smm-swatch { width:10px; height:10px; border-radius:3px; display:inline-block; flex:none; }
        .smm-list { margin:2px 0 0; padding-left:16px; display:grid; gap:2px; }
        .smm-files { max-height:180px; overflow:auto; }
        .smm-link-btn { background:none; border:0; padding:0; color:var(--smm-ink); font:inherit; cursor:pointer; text-align:left; text-decoration:underline; text-decoration-color:var(--smm-line); }
        .smm-link-btn:hover { color:var(--smm-accent); }
        .smm-muted { color:var(--smm-muted); }
        .smm-mono, .smm-cmd { font-family:ui-monospace, Menlo, Consolas, monospace; font-size:11px; }
        .smm-cmd { display:block; background:var(--smm-bg); padding:6px 8px; border-radius:6px; overflow-wrap:anywhere; user-select:text; }
        .smm-chip { display:inline-block; padding:0 6px; border:1px solid var(--smm-line); border-radius:4px; font-size:11px; }
        .smm-actions { display:flex; gap:6px; margin-top:10px; flex-wrap:wrap; }
        .smm-toast { position:absolute; z-index:4; left:50%; bottom:16px; transform:translateX(-50%); background:var(--smm-ink); color:var(--smm-bg); padding:6px 12px; border-radius:999px; }
        `;
        document.head.appendChild(style);
    }
}

SessionMindMap.PALETTE = ['#e5a050', '#6cb6ff', '#d27ad6', '#7ee787', '#f47067', '#dcbdfb', '#f0c674', '#56d4dd'];
SessionMindMap.STATUS = { working: '작업 중', recent: '최근', idle: '지난 세션' };
// 세션이 고친 파일의 git 상태 (SessionIndexer.attachGit)
SessionMindMap.CACHE_MS = 60 * 60e3;      // 캐시 유지 1시간
SessionMindMap.CACHE_WARN_MS = 5 * 60e3;  // 끝나기 5분 전부터 (5분 캐시면 1분 전)
SessionMindMap.CONTEXT_SMALL = 200e3;     // 창 크기: 20만, 넘으면 100만 창으로 본다
SessionMindMap.CONTEXT_LARGE = 1e6;
SessionMindMap.LARGE_MODEL_RE = /\[1m\]|^claude-[a-z]+-5(?:-|$)/i; // 100만 창 모델
SessionMindMap.CONTEXT_WARN = 0.6;        // 노랑
SessionMindMap.CONTEXT_FULL = 0.8;        // 빨강 + 깜박 (곧 자동 요약)
SessionMindMap.CONTEXT_BIG = 0.5;         // 이만큼 큰 세션은 캐시가 끝나기 전에도 깜박
SessionMindMap.GIT = { pushed: 'git', ahead: '푸시 전', dirty: '미커밋' };
SessionMindMap.GIT_LONG = { pushed: 'GitHub 에 올라감', ahead: '커밋했지만 아직 푸시 전', dirty: '커밋 안 한 수정이 있음' };

if (typeof window !== 'undefined') {
    window.SessionMindMap = SessionMindMap;
    const init = () => {
        if (!window.sessionMindMap && document.getElementById('session-mindmap')) {
            window.sessionMindMap = new SessionMindMap('session-mindmap');
        }
    };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
}
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionMindMap;
}
