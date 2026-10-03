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
        this.collapsed = new Set();  // 세션이 접힌 프로젝트 루트
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
        q('.smm-refresh').addEventListener('click', () => this.refresh());

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
        if (this.pendingRoot === p.root) root.children.push(this._pendingNode(p, color));
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

    // 폴더 안 세션 노드: 하위 세션(parentId)은 부모 세션 가지 아래로, 파일은 그 뒤에
    _sessionNodes(p, sessions, color) {
        const q = this.query;
        const nodes = new Map();
        for (const s of SessionMindMap._chrono(sessions)) {
            const sKey = this._sessionKey(p, s);
            const n = { key: sKey, kind: 'session', label: s.title, data: s, project: p, color, seq: this._seq(p, s), children: [] };
            const open = this.showAllFiles || this.expanded.has(sKey) || (q && s.files.some(f => (f.rel || f.path).toLowerCase().includes(q)));
            n.files = open ? this._fileNodes(p, s, sKey, color, !this.showAllFiles && !this.expanded.has(sKey)) : [];
            nodes.set(s.id, n);
        }
        const top = [];
        for (const n of nodes.values()) {
            const parent = n.data.parentId && nodes.get(n.data.parentId);
            if (parent) { n.sub = true; parent.children.push(n); } else top.push(n);
        }
        for (const n of nodes.values()) n.children.push(...n.files);
        return top;
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
            if (!sessions.length && this.pendingRoot !== p.root) return;
            const pNode = { key: `p:${p.root}`, kind: 'project', label: p.name, data: p, color, children: [] };
            if (!this.collapsed.has(p.root)) pNode.children.push(...this._sessionNodes(p, sessions, color));
            if (this.pendingRoot === p.root) pNode.children.push(this._pendingNode(p, color));
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
            return n.w;
        };
        weight(root);

        const all = [];
        const assign = (n, a0, a1, depth) => {
            n.depth = depth;
            n.angle = (a0 + a1) / 2;
            all.push(n);
            if (!n.children.length) return;
            const inner = n.kind === 'project' ? (a1 - a0) * (n.w - 0.8) / n.w : a1 - a0;
            let cursor = n.angle - inner / 2;
            const sum = n.children.reduce((a, c) => a + c.w, 0);
            for (const c of n.children) {
                const span = inner * c.w / sum;
                assign(c, cursor, cursor + span, depth + 1);
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
        const need = (cardLeaves * 46 + (leaves.length - cardLeaves) * 18) / (2 * Math.PI);
        const scale = outer ? Math.max(1, need / rings[outer]) : 1;
        const radius = d => rings[d] * scale;
        for (const n of all) {
            n.r = radius(n.depth);
            n.x = n.r * Math.cos(n.angle);
            n.y = n.r * Math.sin(n.angle);
        }
        this.rings = [];
        for (let d = 1; d <= maxDepth; d++) this.rings.push(radius(d));
        return all;
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

        const sessionCount = new Set(this.nodes.filter(n => n.kind === 'session').map(n => n.related || n.key)).size;
        const projectCount = this.focus.mode === 'all' || !tree.ref ? this.nodes.filter(n => n.kind === 'project').length
            : new Set([tree.ref.project ? tree.ref.project.root : tree.ref.data.root, ...this.nodes.filter(n => n.kind === 'session').map(n => n.project.root)]).size;
        this._setStatus(`프로젝트 ${projectCount} · 세션 ${sessionCount} · ${SessionMindMap._ago(this.data.generatedAt, this.now())} 기준`);

        this.gRings.innerHTML = this.rings.map(r => `<circle r="${r.toFixed(1)}" class="smm-ring"/>`).join('');

        const links = [];
        const walk = n => {
            for (const c of n.children) {
                links.push(`<path class="smm-link smm-link-${c.kind}" stroke="${c.kind === 'project' ? c.color : c.color}" d="${SessionMindMap._radialLink(n, c)}"/>`);
                walk(c);
            }
        };
        walk(tree);
        this.gLinks.innerHTML = links.join('');

        this.gNodes.innerHTML = this.nodes.map(n => this._nodeSvg(n)).join('');
        this._drawSelection();

        if (this._fitPending) this._fit(false);
        else this._applyView();
    }

    // 단계마다 다른 도형: 가운데(큰 원 / 큰 폴더 / 큰 카드) · 폴더(폴더 모양) · 세션(카드) · 파일(문서 아이콘)
    _nodeSvg(n) {
        const esc = SessionMindMap._esc;
        const W = SessionMindMap._textWidth;
        const right = Math.cos(n.angle) >= -1e-6;
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
            const w = Math.max(W(label, 14), W(time, 11)) + 36, h = 56;
            return `<g class="smm-node smm-root-node smm-root-card" data-key="root" ${at}>
                <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="14" class="smm-card smm-${s.status}" style="--c:${n.color}"/>
                <text text-anchor="middle"><tspan x="0" dy="-3" class="smm-card-title smm-big">${esc(label)}</tspan><tspan x="0" dy="18" class="smm-time">${time}</tspan></text>
                ${n.children.length ? '' : `<text class="smm-hint" text-anchor="middle" y="${h / 2 + 22}">이 세션이 고친 파일이 없어요</text>`}
                <title>${esc(s.title)} · 눌러서 툰 허브 보기</title></g>`;
        }

        if (n.kind === 'project') {
            const label = SessionMindMap._clip(n.label, 20);
            const w = Math.max(84, W(label, 13) + 30), h = 30;
            return `<g class="smm-node smm-project" data-key="${esc(n.key)}" ${at} tabindex="0">
                ${SessionMindMap._folderShape(w, h, n.color)}
                <text class="smm-folder-label" text-anchor="middle" dy="7">${esc(label)}</text>
                ${this._addButton(w / 2 + 16, 2, n.data.root, n.color)}
                <title>${esc(n.data.root)}</title></g>`;
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
            const w = Math.max(W(seq + title, 12), W(time, 10.5) * 0.92) + 24, h = 36;
            const x = right ? 11 : -11 - w;
            const badge = count && !open ? `<g class="smm-badge-pill" transform="translate(${right ? x + w : x},${-h / 2})"><rect x="-13" y="-8" width="26" height="16" rx="8" fill="${n.color}"/><text text-anchor="middle" dy="4">+${count}</text></g>` : '';
            return `<g class="smm-node smm-session smm-${s.status}${n.sub ? ' smm-sub' : ''}" data-key="${esc(n.key)}" ${at} tabindex="0">
                ${s.status === 'working' ? `<rect x="${x - 3}" y="${-h / 2 - 3}" width="${w + 6}" height="${h + 6}" rx="12" class="smm-pulse"/>` : ''}
                <circle r="4.5" class="smm-joint" fill="${n.color}"/>
                <rect x="${x}" y="${-h / 2}" width="${w}" height="${h}" rx="${n.sub ? 4 : 10}" class="smm-card smm-${s.status}" style="--c:${n.color}"/>
                <text class="smm-label"><tspan x="${x + 12}" dy="-2">${n.seq ? `<tspan class="smm-seq">${n.seq}</tspan> ` : ''}${esc(title)}</tspan><tspan x="${x + 12}" dy="14" class="smm-time">${time}</tspan></text>
                ${badge}
                <title>${esc(s.title)}${count ? ` · 고친 파일 ${count}개` : ''}</title></g>`;
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
    _addButton(x, y, root, color) {
        if (!this.onAddSession) return '';
        return `<g class="smm-add" data-add="${SessionMindMap._esc(root)}" transform="translate(${x},${y})" role="button" aria-label="이 폴더에 새 세션">
            <circle r="10" stroke="${color}"/><path d="M-4.5,0H4.5M0,-4.5V4.5"/><title>이 폴더에 새 세션</title></g>`;
    }

    // ---------------------------------------------------------------------
    // 세션 끌어다 놓기: 다른 세션 위 = 그 아래로 붙이기, 폴더 위 = 그 폴더로 (다른 폴더면 복사), 빈 곳 = 떼기
    // ---------------------------------------------------------------------
    _bindDrag() {
        if (!this.onDropSession) return;
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

        this.svg.addEventListener('pointerdown', e => {
            if (e.button !== 0 || e.target.closest('.smm-add')) return;
            const g = e.target.closest('.smm-session');
            if (!g) return;
            const n = this.byKey.get(g.dataset.key);
            if (!n || n.related) return; // 세션 중심 보기의 "같은 파일을 고친 세션"은 끌지 않는다
            d = { n, x: e.clientX, y: e.clientY, started: false, id: e.pointerId };
        });
        window.addEventListener('pointermove', e => {
            if (!d || e.pointerId !== d.id) return;
            if (!d.started) {
                if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 7) return;
                d.started = true;
                ghost.textContent = d.n.label;
                ghost.hidden = false;
                this.svg.classList.add('smm-dragging');
            }
            const rect = this.container.getBoundingClientRect();
            ghost.style.left = (e.clientX - rect.left + 12) + 'px';
            ghost.style.top = (e.clientY - rect.top + 10) + 'px';
            clear();
            const t = targetAt(e.clientX, e.clientY);
            d.target = t;
            if (t && t !== d.n) {
                const g = this.gNodes.querySelector(`[data-key="${CSS.escape(t.key)}"]`);
                const ok = this._dropAllowed(d.n, t);
                if (g) g.classList.add(ok ? 'smm-drop-ok' : 'smm-drop-no');
                ghost.dataset.hint = ok ? this._dropHint(d.n, t) : '여기에는 놓을 수 없어요';
            } else {
                ghost.dataset.hint = d.n.data.parentId ? '빈 곳에 놓으면 떼어내요' : '';
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
            const t = drag.target && drag.target !== drag.n ? drag.target : null;
            if (t && !this._dropAllowed(drag.n, t)) return;
            this.onDropSession(drag.n, t);
        });
    }

    // 놓을 수 있는 곳: 세션(자기 하위 세션 제외), 폴더, 가운데의 폴더·세션
    _dropAllowed(src, t) {
        const tSession = t.kind === 'session' ? t.data : t.kind === 'root' && t.ref && t.ref.kind === 'session' ? t.ref.data : null;
        const tProject = t.kind === 'project' ? t.data : t.kind === 'root' && t.ref && t.ref.kind === 'project' ? t.ref.data : null;
        if (tSession) {
            const tp = t.kind === 'session' ? t.project : t.ref.project;
            if (tSession.id === src.data.id && tp.root === src.project.root) return false;
            if (tp.root !== src.project.root) return true;
            // 자기 하위 세션 아래로는 안 됨
            const byId = new Map(src.project.sessions.map(x => [x.id, x]));
            for (let cur = tSession, guard = 0; cur && guard < 1000; cur = byId.get(cur.parentId), guard++) if (cur.id === src.data.id) return false;
            return true;
        }
        return !!tProject;
    }

    _dropHint(src, t) {
        const tp = t.kind === 'session' ? t.project : t.kind === 'project' ? t.data : t.ref.kind === 'project' ? t.ref.data : t.ref.project;
        const same = tp.root === src.project.root;
        const isSession = t.kind === 'session' || (t.ref && t.ref.kind === 'session');
        if (isSession) return same ? '이 세션 아래로 붙이기' : `${tp.name} 폴더로 복사해서 이 세션 아래로`;
        return same ? '폴더 바로 아래로 떼어내기' : `${tp.name} 폴더로 복사`;
    }

    _onNodeClick(e) {
        if (this._suppressClick) return;
        const add = e.target.closest('.smm-add');
        if (add) {
            e.stopPropagation();
            if (this.onAddSession) this.onAddSession(add.dataset.add);
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
                <div class="smm-actions"><button class="smm-btn" data-act="toggle-project">${this.collapsed.has(p.root) ? '세션 펼치기' : '세션 접기'}</button></div>`;
        } else if (n.kind === 'session') {
            const s = n.data;
            const files = s.files.map(f => `<li><button class="smm-link-btn" data-act="select-file" data-path="${esc(f.path)}">${esc(f.rel || f.path)}</button><span class="smm-muted"> ${f.edits}</span></li>`).join('');
            const resume = `cd ${SessionMindMap._shellQuote(s.cwd)} && claude --resume ${s.id}`;
            html = `<h4>${esc(s.title)}</h4>
                <div class="smm-meta"><span class="smm-pill smm-${s.status}">${SessionMindMap.STATUS[s.status]}</span><span>${esc(n.project.name)}</span>${s.gitBranch ? `<span class="smm-mono">${esc(s.gitBranch)}</span>` : ''}</div>
                <dl><dt>기간</dt><dd>${SessionMindMap._fmt(s.firstAt)} → ${SessionMindMap._fmt(s.lastAt)} (${SessionMindMap._ago(s.lastAt, now)})</dd>
                ${s.costUSD != null ? `<dt>비용</dt><dd>$${s.costUSD.toFixed(2)}</dd>` : ''}
                <dt>고친 파일 ${s.files.length}개</dt><dd>${files ? `<ul class="smm-list smm-files">${files}</ul>` : '<span class="smm-muted">파일 수정 없음</span>'}</dd>
                <dt>이어서 하기</dt><dd><code class="smm-cmd">${esc(resume)}</code></dd></dl>
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
            if (this.collapsed.has(root)) this.collapsed.delete(root); else this.collapsed.add(root);
            this._fitPending = true;
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
        const pad = 150; // 라벨 자리
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const n of this.nodes) {
            x0 = Math.min(x0, n.x - pad); x1 = Math.max(x1, n.x + pad);
            y0 = Math.min(y0, n.y - 30); y1 = Math.max(y1, n.y + 30);
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
        .smm-dragging .smm-session:not(.smm-drop-ok) { opacity:.75; }
        .smm-drop-ok .smm-card, .smm-drop-ok .smm-folder, .smm-drop-ok .smm-core { stroke:var(--smm-working) !important; stroke-width:3 !important; stroke-dasharray:none !important; filter:drop-shadow(0 0 6px var(--smm-working)); }
        .smm-drop-no { opacity:.4; }
        .smm-session { cursor:grab; }
        .smm-seq { fill:var(--smm-accent); font-weight:700; font-variant-numeric:tabular-nums; }
        .smm-time { fill:var(--smm-muted); font-size:10.5px; font-family:ui-monospace, Menlo, Consolas, monospace; font-weight:400; }
        .smm-idle .smm-label { fill:var(--smm-muted); }
        .smm-session-dot { stroke-width:2; }
        .smm-pulse { fill:none; stroke:var(--smm-working); stroke-width:2; animation:smm-pulse 1.8s ease-out infinite; transform-box:fill-box; transform-origin:center; }
        @keyframes smm-pulse { from { opacity:.9; transform:scale(1); } to { opacity:0; transform:scale(1.12); } }
        @media (prefers-reduced-motion: reduce) { .smm-pulse { animation:none; opacity:.6; } }
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
