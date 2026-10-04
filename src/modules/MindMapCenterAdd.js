// 세션 중심 보기: 가운데 세션 카드 오른쪽에 ＋ 단추 — 누르면 그 세션의 하위 세션을 새로 만든다 (같은 폴더·같은 주제)
// 단추 모양·누르기는 SessionMindMap 의 _addButton · onAddSession 을 그대로 쓴다.
(function () {
    if (typeof SessionMindMap === 'undefined' || typeof document === 'undefined') return;
    const P = SessionMindMap.prototype;

    const isCenterSession = n => n.kind === 'root' && n.ref && n.ref.kind === 'session' && !n.ref.data.remote;

    const nodeSvg = P._nodeSvg;
    P._nodeSvg = function (n) {
        const svg = nodeSvg.call(this, n);
        if (!isCenterSession(n) || !this.onAddSession) return svg;
        const s = n.ref.data;
        const b = box.call(this, n);
        const add = this._addButton(b[1] + 16, 0, n.ref.project.root, n.color, { parentId: s.id, topic: s.topic || '', label: '이 세션의 하위 세션 새로 만들기' });
        return svg.replace(/<\/g>\s*$/, `${add}</g>`);
    };

    const box = P._box;
    P._box = function (n) {
        const b = box.call(this, n);
        return isCenterSession(n) && this.onAddSession ? [b[0], b[1] + 30, b[2], b[3]] : b;
    };
})();
