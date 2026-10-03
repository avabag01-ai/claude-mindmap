// 마인드맵 도구: 자리 되돌리기 옆 − / ＋ 확대 버튼, 세션 노드 우클릭 → 세션 지우기 (앱 휴지통으로).
// SessionMindMap 이 화면을 만든 뒤 SessionMindMap.addTools(this) 로 부른다.
(function () {
    if (typeof SessionMindMap === 'undefined' || typeof document === 'undefined') return;
    const STEP = 1.25;

    function injectStyle() {
        if (document.getElementById('smm-tools-style')) return;
        const style = document.createElement('style');
        style.id = 'smm-tools-style';
        style.textContent = `
        .smm-zoom { min-width:26px; font-weight:700; }
        .smm-menu { position:fixed; z-index:50; min-width:150px; background:var(--smm-panel, #1f2329); border:1px solid var(--smm-line, #323943);
          border-radius:8px; padding:4px; box-shadow:0 6px 20px rgba(0,0,0,.45); font-size:12.5px; }
        .smm-menu button { display:block; width:100%; text-align:left; background:transparent; border:0; border-radius:5px; padding:6px 10px; cursor:pointer; color:var(--smm-ink, #d7dde4); }
        .smm-menu button:hover { background:var(--smm-line, #323943); }
        .smm-menu .smm-menu-danger { color:#f47067; }
        .smm-menu p { margin:4px 10px 6px; color:var(--smm-muted, #8a95a1); max-width:220px; }`;
        document.head.appendChild(style);
    }

    function zoomBy(map, f) {
        const r = map.svg.getBoundingClientRect();
        map._zoomAt(r.width / 2, r.height / 2, map.view.k * f);
    }

    function closeMenu(map) {
        if (map._menu) { map._menu.remove(); map._menu = null; }
    }

    function openMenu(map, e, n) {
        closeMenu(map);
        const s = n.data;
        const menu = document.createElement('div');
        menu.className = 'smm-menu';
        menu.setAttribute('role', 'menu');
        const title = SessionMindMap._esc(SessionMindMap._clip(s.title || s.id, 24));
        menu.innerHTML = `<p>${title}</p><button type="button" class="smm-menu-danger" data-act="trash" role="menuitem">세션 지우기</button>`;
        menu.style.left = `${e.clientX}px`;
        menu.style.top = `${e.clientY}px`;
        document.body.appendChild(menu);
        map._menu = menu;
        // 화면 밖으로 나가지 않게
        const r = menu.getBoundingClientRect();
        if (r.right > innerWidth - 8) menu.style.left = `${innerWidth - r.width - 8}px`;
        if (r.bottom > innerHeight - 8) menu.style.top = `${innerHeight - r.height - 8}px`;
        menu.addEventListener('click', ev => {
            const b = ev.target.closest('button');
            if (!b) return;
            if (b.dataset.act === 'trash') {
                // 한 번 더 눌러야 지운다
                menu.innerHTML = `<p>"${title}" 를 지울까요? 기록은 앱 휴지통(~/.claude-mindmap/trash)에 남아요.</p>
                    <button type="button" class="smm-menu-danger" data-act="yes" role="menuitem">지우기</button>
                    <button type="button" data-act="no" role="menuitem">그만두기</button>`;
                return;
            }
            if (b.dataset.act === 'yes' && map.ipc) map.ipc.send('sessions:trash', { root: n.project.root, id: s.id });
            closeMenu(map);
        });
    }

    SessionMindMap.addTools = function (map) {
        injectStyle();
        const reset = map.resetBtn;
        if (reset && !map.container.querySelector('.smm-zoom')) {
            reset.insertAdjacentHTML('afterend',
                '<button class="smm-btn smm-zoom" data-zoom="out" title="작게" aria-label="작게">−</button><button class="smm-btn smm-zoom" data-zoom="in" title="크게" aria-label="크게">＋</button>');
            for (const b of map.container.querySelectorAll('.smm-zoom')) {
                b.addEventListener('click', () => zoomBy(map, b.dataset.zoom === 'in' ? STEP : 1 / STEP));
            }
        }
        map.gNodes.addEventListener('contextmenu', e => {
            const g = e.target.closest('.smm-node');
            const n = g && map.byKey && map.byKey.get(g.dataset.key);
            e.preventDefault();
            if (!n || n.kind !== 'session' || n.data.remote) { closeMenu(map); return; }
            openMenu(map, e, n);
        });
        document.addEventListener('mousedown', e => { if (map._menu && !map._menu.contains(e.target)) closeMenu(map); });
        document.addEventListener('keydown', e => { if (e.key === 'Escape') closeMenu(map); });
    };
})();
