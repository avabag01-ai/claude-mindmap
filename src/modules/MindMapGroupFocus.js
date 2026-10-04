// 그룹 중심 보기: "클로드 앱" 보기의 전체 맵에서 그룹을 누르면 그 그룹이 가운데, 둘레에 그 그룹 세션이 나온다.
// 가운데를 누르면 다시 전체. 그룹 접기는 ▸/▾ 단추나 더블클릭(MindMapDoubleClick.js)으로.
// 그룹 트리는 MindMapAppGroups.js 의 _allTree 를 그대로 쓰고 그 그룹 가지만 꺼낸다.
// MindMapAppGroups.js 뒤, MindMapDoubleClick.js 앞에 불러야 한다.
(function () {
    if (typeof SessionMindMap === 'undefined' || typeof document === 'undefined') return;
    const P = SessionMindMap.prototype;

    const active = map => !!(map.groupFocus && map.focus.mode === 'all' && map.appHub && map.appHub.group === 'app' && !(map.gh && map.gh.on));

    function caption(map) {
        const cap = document.getElementById('hub-map-caption');
        if (cap && active(map)) cap.textContent = `그룹 중심 · ${map.groupFocus.label}`;
    }

    const visibleTree = P._visibleTree;
    P._visibleTree = function () {
        if (!active(this)) return visibleTree.call(this);
        // 왼쪽에서 접어 둔 그룹이라도 가운데에서는 펼쳐 보인다
        const hub = this.appHub;
        const folded = hub.folded;
        hub.folded = new Set([...folded].filter(k => k !== this.groupFocus.fold));
        let all;
        try { all = this._allTree(); } finally { hub.folded = folded; }
        const g = all.children.find(c => c.kind === 'group' && c.fold === this.groupFocus.fold);
        if (!g) { this.groupFocus = null; return visibleTree.call(this); }
        return { key: 'root', kind: 'root', label: g.label, groupRoot: true, children: g.children };
    };

    const viewKey = P._viewKey;
    P._viewKey = function () {
        return active(this) ? `group:${this.groupFocus.fold}` : viewKey.call(this);
    };

    // 폴더·세션 중심으로 가면 그룹 중심은 끝
    const setFocus = P.setFocus;
    P.setFocus = function (mode, root, id) {
        if (mode !== 'all') this.groupFocus = null;
        return setFocus.call(this, mode, root, id);
    };

    const render = P.render;
    P.render = function () {
        render.call(this);
        caption(this);
    };

    // 가운데 원 글자: 그룹 이름
    const nodeSvg = P._nodeSvg;
    P._nodeSvg = function (n) {
        const svg = nodeSvg.call(this, n);
        if (!n.groupRoot) return svg;
        return svg.replace('</g>', '<title>눌러서 전체 보기로</title></g>');
    };

    const onNodeClick = P._onNodeClick;
    P._onNodeClick = function (e) {
        const el = !this._suppressClick && !e.target.closest('.smm-fold, .smm-add') && e.target.closest('.smm-node');
        const n = el && this.byKey && this.byKey.get(el.dataset.key);
        if (n && n.kind === 'group' && this.focus.mode === 'all') {
            e.stopPropagation();
            this.groupFocus = { fold: n.fold, label: n.label };
            this.selected = null;
            if (this.info) this.info.hidden = true;
            this._fitPending = true;
            this.render();
            return;
        }
        if (n && n.groupRoot) {
            e.stopPropagation();
            this.groupFocus = null;
            this._fitPending = true;
            this.render();
            const hub = this.appHub;
            if (hub && hub._applyCenter) hub._applyCenter(true); // 위 제목을 "전체"로
            return;
        }
        return onNodeClick.call(this, e);
    };

    // 세션 목록이 새로 읽혀 위 제목이 "전체"로 바뀌어도 그룹 중심이면 그대로
    function wireHub() {
        if (typeof SessionHub === 'undefined' || SessionHub.prototype._groupFocusWired) return;
        SessionHub.prototype._groupFocusWired = true;
        const applyCenter = SessionHub.prototype._applyCenter;
        SessionHub.prototype._applyCenter = function (fit) {
            applyCenter.call(this, fit);
            caption(this.map);
        };
    }
    if (typeof SessionHub !== 'undefined') wireHub();
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireHub);
})();
