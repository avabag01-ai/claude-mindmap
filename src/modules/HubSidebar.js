// 왼쪽 사이드바 열기·닫기 (클로드 앱처럼). 창 왼쪽 위 신호등 옆 단추, 또는 ⌘B.
// 닫으면 왼쪽 칸을 숨기고 가운데·대화창이 넓어진다. 고른 것은 기억 (localStorage 'hub.leftHidden').
(function () {
    if (typeof document === 'undefined') return;
    const KEY = 'hub.leftHidden';
    const ICON = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" aria-hidden="true"><rect x="1.5" y="2.5" width="13" height="11" rx="2"/><line x1="6" y1="2.5" x2="6" y2="13.5"/></svg>';

    function set(hidden) {
        document.body.classList.toggle('left-hidden', hidden);
        const b = document.getElementById('hub-sidebar-toggle');
        if (b) {
            b.setAttribute('aria-pressed', String(!hidden));
            b.title = hidden ? '사이드바 열기 (⌘B)' : '사이드바 닫기 (⌘B)';
            b.setAttribute('aria-label', b.title);
        }
        try { localStorage.setItem(KEY, hidden ? '1' : '0'); } catch { /* 미리보기 */ }
    }
    const toggle = () => set(!document.body.classList.contains('left-hidden'));

    function init() {
        const b = document.createElement('button');
        b.id = 'hub-sidebar-toggle';
        b.className = 'hub-sidebar-toggle';
        b.innerHTML = ICON;
        b.addEventListener('click', toggle);
        document.body.appendChild(b);
        let hidden = false;
        try { hidden = localStorage.getItem(KEY) === '1'; } catch { /* 미리보기 */ }
        set(hidden);
        document.addEventListener('keydown', e => {
            if ((e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'b') { e.preventDefault(); toggle(); }
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
