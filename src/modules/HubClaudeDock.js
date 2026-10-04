// 클로드 앱 붙이기: 가운데 탭 줄의 단추. 누르면 대화창을 숨기고 그 자리(마인드맵 창 오른쪽)에 클로드 앱 창을 붙인다.
// 마인드맵 창을 옮기거나 크기를 바꾸면 따라온다 (src-tauri/src/claude_dock.rs). 다시 누르면 떼고 대화창을 되돌린다.
// 고른 것은 기억 (localStorage 'hub.claudeDock') — 다음에 켜면 다시 붙인다. Tauri 판만 (Electron 판은 단추 없음).
(function () {
    if (typeof document === 'undefined') return;
    const KEY = 'hub.claudeDock';
    const T = () => window.__TAURI__ && window.__TAURI__.core;
    const toast = m => { const h = window.hub || window.sessionHub; if (h && h.map && h.map._toast) h.map._toast(m); };

    function chatWidth() {
        const col = document.querySelector('.hub > section.col[aria-label="대화"]');
        return col ? Math.round(col.getBoundingClientRect().width) : 420;
    }

    function render(b, on) {
        b.setAttribute('aria-pressed', String(on));
        b.textContent = on ? '클로드 앱 떼기' : '클로드 앱 붙이기';
        b.title = on ? '클로드 앱 창을 떼고 대화창을 되돌려요' : '대화창 자리에 클로드 앱 창을 붙여요 (마인드맵을 옮기면 따라와요)';
        document.body.classList.toggle('claude-docked', on);
    }

    function set(b, on) {
        const width = chatWidth();
        return T().invoke('claude_dock', { on, width }).then(() => {
            render(b, on);
            try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 미리보기 */ }
        }).catch(e => { render(b, false); toast(String(e && e.message || e)); });
    }

    function init() {
        if (!T()) return;
        const head = document.querySelector('.center-tabs');
        if (!head || document.getElementById('hub-claude-dock')) return;
        const b = document.createElement('button');
        b.id = 'hub-claude-dock';
        b.type = 'button';
        b.className = 'hub-claude-dock';
        render(b, false);
        b.addEventListener('click', () => set(b, b.getAttribute('aria-pressed') !== 'true'));
        head.appendChild(b); // 탭 줄 오른쪽 끝 (탭은 아님)
        let saved = false;
        try { saved = localStorage.getItem(KEY) === '1'; } catch { /* 미리보기 */ }
        if (saved) set(b, true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
