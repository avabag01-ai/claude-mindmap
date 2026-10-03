// 마인드맵: 가장 최근에 만든 세션은 색을 꽉 채우고, 바로 그 전 세션은 빗금으로 칠한다.
// SessionMindMap.render() 가 그린 뒤 SessionMindMap.markRecent(this) 로 부른다.
(function () {
    if (typeof SessionMindMap === 'undefined' || typeof document === 'undefined') return;
    const NS = 'http://www.w3.org/2000/svg';

    // 이 기기 세션 중 만든 시각(firstAt) 순으로 가장 새 것, 그 전 것
    function pick(data) {
        const all = [];
        for (const p of data.projects || []) for (const s of p.sessions || []) if (!s.remote) all.push(s);
        all.sort((a, b) => (b.firstAt - a.firstAt) || (b.lastAt - a.lastAt));
        return [all[0] && all[0].id, all[1] && all[1].id];
    }

    function ensureDefs(map) {
        if (map.svg.querySelector('#smm-hatch')) return;
        const defs = document.createElementNS(NS, 'defs');
        defs.innerHTML = `<pattern id="smm-hatch" patternUnits="userSpaceOnUse" width="7" height="7" patternTransform="rotate(45)">
            <line x1="0" y1="0" x2="0" y2="7" stroke="#ffffff" stroke-opacity=".28" stroke-width="3"/></pattern>`;
        map.svg.insertBefore(defs, map.svg.firstChild);
        const style = document.createElement('style');
        style.id = 'smm-recent-style';
        style.textContent = `
        .smm-newest .smm-card { fill:color-mix(in srgb, var(--c) 62%, var(--smm-bg)) !important; stroke:var(--c) !important; stroke-width:2.5 !important;
          stroke-dasharray:none !important; stroke-opacity:1 !important; filter:drop-shadow(0 0 6px var(--c)); }
        .smm-newest .smm-label, .smm-newest .smm-card-title { fill:#ffffff; }
        .smm-newest .smm-time { fill:#f0f3f6; }
        .smm-previous .smm-card { stroke-dasharray:none !important; stroke-opacity:1 !important; stroke-width:2 !important; }
        .smm-previous .smm-label { fill:var(--smm-ink); }
        .smm-hatch-over { fill:url(#smm-hatch); pointer-events:none; }
        .smm-chip-c.smm-chip-newest { background:#4ec9b0; border-color:#4ec9b0; box-shadow:0 0 4px #4ec9b0; }
        .smm-chip-c.smm-chip-previous { border-color:#8a95a1; background:repeating-linear-gradient(45deg, rgba(255,255,255,.35) 0 2px, transparent 2px 5px); }`;
        document.head.appendChild(style);
        const legend = map.svg.parentNode && map.svg.parentNode.querySelector('.smm-legend');
        if (legend) legend.insertAdjacentHTML('afterbegin',
            '<span><i class="smm-chip-c smm-chip-newest"></i>가장 최근 만든 세션</span><span><i class="smm-chip-c smm-chip-previous"></i>바로 그 전 세션</span>');
    }

    SessionMindMap.markRecent = function (map) {
        if (!map.data || !map.svg || !map.gNodes) return;
        ensureDefs(map);
        const [newest, previous] = pick(map.data);
        for (const g of map.gNodes.querySelectorAll('.smm-node')) {
            const n = map.byKey && map.byKey.get(g.dataset.key);
            if (!n) continue;
            const s = n.kind === 'session' ? n.data : n.kind === 'root' && n.ref && n.ref.kind === 'session' ? n.ref.data : null;
            if (!s) continue;
            if (s.id === newest) g.classList.add('smm-newest');
            else if (s.id === previous) {
                g.classList.add('smm-previous');
                const card = g.querySelector('rect.smm-card');
                if (card) {
                    const over = card.cloneNode(false);
                    over.setAttribute('class', 'smm-hatch-over');
                    over.removeAttribute('style');
                    card.after(over);
                }
            }
        }
    };
})();
