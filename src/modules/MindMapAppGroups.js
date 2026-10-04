// 마인드맵 "전체" 보기를 클로드 앱 그룹대로: 왼쪽 목록이 "클로드 앱" 보기일 때
//   가운데 Claude → 고정됨 · 직접 만든 그룹 · 세션 · 앱 밖 세션 (왼쪽 목록과 같은 순서) → 세션 → 고친 파일
// 그룹 접기는 왼쪽 목록과 같이 쓴다 (hub.folded 의 "app:<그룹>"). 폴더·가지 보기면 원래대로 폴더 중심.
// 데이터: 세션 목록의 claudeApp + SessionHub.appSections (HubAppList.js). SessionHub 가 map.appHub = this 로 이어 준다.
(function () {
    if (typeof SessionMindMap === 'undefined' || typeof document === 'undefined') return;
    const P = SessionMindMap.prototype;

    function appMode(map) {
        const hub = map.appHub;
        return !!(hub && hub.group === 'app' && map.data && map.data.claudeApp && map.data.claudeApp.ok && typeof SessionHub !== 'undefined' && SessionHub.appSections);
    }

    function injectStyle() {
        if (document.getElementById('smm-appgroup-style')) return;
        const style = document.createElement('style');
        style.id = 'smm-appgroup-style';
        style.textContent = `
        .smm-group-box { fill:var(--smm-panel, #1f2329); stroke:var(--smm-accent, #4ec9b0); stroke-width:1.5; }
        .smm-group:hover .smm-group-box { stroke-width:2.5; }
        .smm-group-label { fill:var(--smm-ink, #d7dde4); font-size:13px; font-weight:700; }
        .smm-group-count { fill:var(--smm-muted, #8a95a1); font-size:11px; }
        .smm-group { cursor:pointer; }`;
        document.head.appendChild(style);
    }

    const groupWidth = n => Math.max(84, SessionMindMap._textWidth(SessionMindMap._clip(n.label, 18), 13) + SessionMindMap._textWidth(String(n.total), 11) + 36);

    // 전체 보기: 클로드 앱 그룹 → 세션
    const allTree = P._allTree;
    P._allTree = function () {
        if (!appMode(this)) return allTree.call(this);
        injectStyle();
        const limit = { '24h': 864e5, '7d': 7 * 864e5, '30d': 30 * 864e5, all: Infinity }[this.period];
        const now = this.now();
        const q = this.query;
        const rows = [];
        for (const p of this.data.projects) {
            for (const s of p.sessions) {
                if (now - s.lastAt > limit) continue;
                if (q && !s.title.toLowerCase().includes(q) && !p.name.toLowerCase().includes(q) && !s.files.some(f => (f.rel || f.path).toLowerCase().includes(q))) continue;
                rows.push({ p, s });
            }
        }
        const folded = this.appHub.folded || new Set();
        const root = { key: 'root', kind: 'root', label: 'Claude', children: [] };
        for (const sec of SessionHub.appSections(this.data.claudeApp, rows)) {
            if (sec.note || !sec.rows.length) continue;
            const fk = `app:${sec.key}`;
            const g = { key: `g:${fk}`, kind: 'group', fold: fk, label: sec.title, total: sec.rows.length, color: '#4ec9b0', children: [] };
            if (folded.has(fk) && !q) g.hidden = sec.rows.length;
            else {
                for (const { p, s } of sec.rows) {
                    const color = this._colorOf(p);
                    const sKey = this._sessionKey(p, s);
                    const n = { key: sKey, kind: 'session', label: s.title, data: s, project: p, color, seq: this._seq(p, s), children: [] };
                    const open = this.showAllFiles || this.expanded.has(sKey) || (q && s.files.some(f => (f.rel || f.path).toLowerCase().includes(q)));
                    if (open) n.children.push(...this._fileNodes(p, s, sKey, color, !this.showAllFiles && !this.expanded.has(sKey)));
                    g.children.push(n);
                }
            }
            root.children.push(g);
        }
        return root;
    };

    // 끌어다 놓은 자리: 폴더 보기와 따로 기억
    const viewKey = P._viewKey;
    P._viewKey = function () {
        const k = viewKey.call(this);
        return k === 'all' && appMode(this) ? 'all:app' : k;
    };

    const nodeSvg = P._nodeSvg;
    P._nodeSvg = function (n) {
        if (n.kind !== 'group') return nodeSvg.call(this, n);
        const esc = SessionMindMap._esc;
        const label = SessionMindMap._clip(n.label, 18);
        const w = groupWidth(n), h = 30;
        const at = `transform="translate(${(n.x || 0).toFixed(1)},${(n.y || 0).toFixed(1)})"`;
        return `<g class="smm-node smm-group" data-key="${esc(n.key)}" ${at} tabindex="0">
            <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="9" class="smm-group-box"/>
            <text text-anchor="middle" dy="5"><tspan class="smm-group-label">${esc(label)}</tspan><tspan class="smm-group-count" dx="6">${n.total}</tspan></text>
            ${this._foldChip(0, h / 2 + 9, n, '세션')}
            <title>클로드 앱 그룹 "${esc(n.label)}" · 눌러서 ${n.hidden ? '펼치기' : '접기'}</title></g>`;
    };

    const box = P._box;
    P._box = function (n) {
        if (n.kind !== 'group') return box.call(this, n);
        const w = groupWidth(n);
        return [-w / 2 - 4, w / 2 + 4, -19, n.hidden || n.children.length ? 32 : 18];
    };

    // 그룹 접기·펼치기: 왼쪽 목록과 같은 기억(hub.folded)을 쓴다
    function toggleGroup(map, n) {
        const hub = map.appHub;
        if (hub.folded.has(n.fold)) hub.folded.delete(n.fold); else hub.folded.add(n.fold);
        try { localStorage.setItem('hub.folded', JSON.stringify([...hub.folded])); } catch { /* 미리보기 */ }
        hub._renderList();
        map.render();
    }

    const toggleFold = P._toggleFold;
    P._toggleFold = function (key) {
        const n = this.byKey && this.byKey.get(key);
        if (n && n.kind === 'group') return toggleGroup(this, n);
        return toggleFold.call(this, key);
    };

    const onNodeClick = P._onNodeClick;
    P._onNodeClick = function (e) {
        const g = !this._suppressClick && !e.target.closest('.smm-fold') && e.target.closest('.smm-group');
        const n = g && this.byKey && this.byKey.get(g.dataset.key);
        if (n && n.kind === 'group') { e.stopPropagation(); return toggleGroup(this, n); }
        return onNodeClick.call(this, e);
    };
})();
