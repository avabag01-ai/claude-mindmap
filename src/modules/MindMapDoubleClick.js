// 마인드맵 노드 더블클릭 = 그 노드 아래 펼치기·닫기
// - 세션: 하위 세션·고친 파일을 접고 펼친다 (접으면 카드 옆에 ▸ 숨은 수)
// - 폴더·가지·클로드 앱 그룹·GitHub 묶음·저장소: 원래 ▸/▾ 단추와 같다
// 한 번 누르기(세션 고르기·가운데 바꾸기)는 더블클릭인지 볼 동안(0.25초) 기다렸다가 한다.
// MindMapAppGroups.js 뒤에 불러야 모든 보기의 누르기를 감싼다.
(function () {
    if (typeof SessionMindMap === 'undefined' || typeof document === 'undefined') return;
    const P = SessionMindMap.prototype;
    const WAIT_MS = 250;

    const closed = map => map.closedNodes || (map.closedNodes = new Set());

    // 접어 둔 세션: 아래 노드를 숨기고 개수만 남긴다
    function cut(map, n) {
        for (const c of n.children) cut(map, c);
        if (n.kind === 'session' && n.children.length && closed(map).has(n.key)) {
            n.hidden = (n.hidden || 0) + n.children.length;
            n.children = [];
            n.dblClosed = true;
        }
    }
    const visibleTree = P._visibleTree;
    P._visibleTree = function () {
        const tree = visibleTree.call(this);
        if (this.closedNodes && this.closedNodes.size) cut(this, tree);
        return tree;
    };

    // 접은 세션 카드 옆 ▸ 단추 (누르면 펼침)
    const nodeSvg = P._nodeSvg;
    P._nodeSvg = function (n) {
        const svg = nodeSvg.call(this, n);
        if (!n.dblClosed) return svg;
        const b = this._box(n);
        const right = n.right !== undefined ? n.right : Math.cos(n.angle) >= -1e-6;
        return svg.replace(/<\/g>\s*$/, `${this._foldChip(right ? b[1] + 10 : b[0] - 10, 0, n, '아래 노드')}</g>`);
    };
    const box = P._box;
    P._box = function (n) {
        const b = box.call(this, n);
        if (!n.dblClosed) return b;
        const right = n.right !== undefined ? n.right : Math.cos(n.angle) >= -1e-6;
        return right ? [b[0], b[1] + 34, b[2], b[3]] : [b[0] - 34, b[1], b[2], b[3]];
    };

    const toggleFold = P._toggleFold;
    P._toggleFold = function (key) {
        if (this.closedNodes && this.closedNodes.has(key)) { this.closedNodes.delete(key); return this.render(); }
        return toggleFold.call(this, key);
    };

    function toggle(map, n) {
        if (map.levelCut && map.levelCut.has(n.key)) return map._toggleFold(n.key); // −/＋ 단계로 접힌 것
        if (n.kind === 'session') {
            if (closed(map).has(n.key)) closed(map).delete(n.key);
            else if (n.children.length) closed(map).add(n.key);
            else return;
            return map.render();
        }
        if (n.children.length || n.hidden || n.kind === 'ghrepo') map._toggleFold(n.key);
    }

    const onNodeClick = P._onNodeClick;
    P._onNodeClick = function (e) {
        const el = !this._suppressClick && !e.target.closest('.smm-fold, .smm-add') && e.target.closest('.smm-node');
        const n = el && this.byKey && this.byKey.get(el.dataset.key);
        if (!n || n.kind === 'root' || n.kind === 'pending') return onNodeClick.call(this, e);
        e.stopPropagation();
        clearTimeout(this._clickTimer);
        if (e.detail >= 2) { this._clickTimer = null; toggle(this, n); return; }
        // 한 번 누르기는 잠깐 기다렸다가 (그 사이 다시 누르면 더블클릭)
        const fake = { target: e.target, stopPropagation() {}, preventDefault() {} };
        this._clickTimer = setTimeout(() => { this._clickTimer = null; onNodeClick.call(this, fake); }, WAIT_MS);
    };
})();
