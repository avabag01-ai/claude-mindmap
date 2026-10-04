// 마인드맵 도구: 자리 되돌리기 옆 − / ＋ 확대 버튼, 세션 노드 우클릭 → 세션 지우기 (앱 휴지통으로),
// 위 "코드 보기" 켜기/끄기(코드 파일 노드), 파일 노드의 "코드 보기" → 코드 창.
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
        .smm-menu p { margin:4px 10px 6px; color:var(--smm-muted, #8a95a1); max-width:220px; }
        .smm-codebtn[aria-pressed=true] { background:var(--smm-accent, #4ec9b0); color:#0b1512; border-color:var(--smm-accent, #4ec9b0); font-weight:600; }
        .smm-code { position:absolute; z-index:30; left:12px; right:12px; top:var(--smm-code-top, 48px); bottom:12px; display:flex; flex-direction:column;
          background:var(--smm-panel, #1f2329); border:1px solid var(--smm-line, #323943); border-radius:10px; box-shadow:0 10px 30px rgba(0,0,0,.5); }
        .smm-code-head { display:flex; gap:8px; align-items:center; padding:8px 10px; border-bottom:1px solid var(--smm-line, #323943); min-width:0; }
        .smm-code-name { font-weight:700; white-space:nowrap; }
        .smm-code-path { color:var(--smm-muted, #8a95a1); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; flex:1; direction:rtl; text-align:left; }
        .smm-code-body { flex:1; overflow:auto; margin:0; padding:8px 0; font:12px/1.55 ui-monospace, Menlo, monospace; color:var(--smm-ink, #d7dde4); counter-reset:ln; user-select:text; }
        .smm-code-body span { display:block; padding:0 12px 0 0; white-space:pre; }
        .smm-code-body span::before { counter-increment:ln; content:counter(ln); display:inline-block; width:4.2em; padding-right:12px; text-align:right; color:var(--smm-muted, #8a95a1); opacity:.6; user-select:none; }
        .smm-code-msg { padding:16px; color:var(--smm-muted, #8a95a1); }`;
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

    // 코드 창: 파일 노드 → 정보 패널 "코드 보기" → 'read-file' → 'read-file-result'
    function showCode(map, r) {
        const esc = SessionMindMap._esc;
        let box = map.container.querySelector('.smm-code');
        if (!box) {
            box = document.createElement('div');
            box.className = 'smm-code';
            box.setAttribute('role', 'dialog');
            map.container.querySelector('.smm-root').appendChild(box);
            box.addEventListener('click', e => { if (e.target.closest('[data-act=code-close]')) box.remove(); });
        }
        box.style.setProperty('--smm-code-top', `${map._toolbarBottom ? map._toolbarBottom() : 48}px`);
        const name = SessionMindMap._base ? SessionMindMap._base(r.path || '') : r.path;
        const body = r.loading ? '<div class="smm-code-msg">읽는 중…</div>'
            : r.error ? `<div class="smm-code-msg">${esc(r.error)}</div>`
            : `<pre class="smm-code-body">${String(r.text).split('\n').map(l => `<span>${esc(l) || ' '}</span>`).join('')}</pre>${r.truncated ? '<div class="smm-code-msg">512KB 까지만 보여요</div>' : ''}`;
        box.innerHTML = `<div class="smm-code-head"><span class="smm-code-name">${esc(name)}</span><span class="smm-code-path" title="${esc(r.path || '')}">${esc(r.path || '')}</span>
            <button class="smm-btn" data-act="code-close" aria-label="코드 창 닫기">닫기</button></div>${body}`;
    }

    SessionMindMap.addTools = function (map) {
        injectStyle();
        // 위 "코드 보기": 켜야 코드(파일) 노드가 나온다. 켜면 "파일 모두"도 같이 보인다
        const allFiles = map.container.querySelector('.smm-allfiles');
        const allLabel = allFiles && allFiles.closest('label');
        if (allLabel && !map.container.querySelector('.smm-codebtn')) {
            allLabel.insertAdjacentHTML('beforebegin', '<button class="smm-btn smm-codebtn" aria-pressed="false" title="세션이 고친 코드 파일 노드 보이기">코드 보기</button>');
            const btn = map.container.querySelector('.smm-codebtn');
            allLabel.hidden = true;
            btn.addEventListener('click', () => {
                map.showCode = !map.showCode;
                btn.setAttribute('aria-pressed', String(map.showCode));
                allLabel.hidden = !map.showCode;
                if (!map.showCode) { const box = map.container.querySelector('.smm-code'); if (box) box.remove(); }
                map._fitPending = true;
                map.render();
            });
        }
        if (map.ipc) map.ipc.on('read-file-result', (e, r) => { if (r && map.container.querySelector('.smm-code')) showCode(map, r); });
        map.container.addEventListener('click', e => {
            const b = e.target.closest('[data-act=open-code]');
            if (b && map.ipc) showCode(map, { path: b.dataset.path, loading: true });
        }, true);
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
