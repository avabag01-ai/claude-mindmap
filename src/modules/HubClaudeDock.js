// 클로드 앱 붙이기: 가운데 탭 줄의 단추. 누르면 대화창 칸의 대화 내용·입력칸을 숨기고 그 자리(#hub-claude-hole)를
// 투명한 구멍으로 비운다. 클로드 앱 창이 구멍 뒤에 딱 맞춰 붙고, 위 머리줄·아래 버튼 줄은 그대로 쓴다 (src-tauri/src/claude_dock.rs).
// 대화 입력은 클로드 앱 창에서. 구멍 크기가 바뀌면(창 크기·대화창 너비 끌기) 클로드 창도 다시 맞춘다.
// 클로드 창이 앱 최소 크기 때문에 구멍보다 넓으면 대화창 칸을 그만큼 넓힌다.
// 고른 것은 기억 (localStorage 'hub.claudeDock') — 다음에 켜면 다시 붙인다. Tauri 판만 (Electron 판은 단추 없음).
(function () {
    if (typeof document === 'undefined') return;
    const KEY = 'hub.claudeDock';
    const T = () => window.__TAURI__ && window.__TAURI__.core;
    const toast = m => { const h = window.sessionHub; if (h && h.map && h.map._toast) h.map._toast(m); };
    const docked = () => document.body.classList.contains('claude-docked');

    function holeRect() {
        const r = document.getElementById('hub-claude-hole').getBoundingClientRect();
        return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) };
    }

    function render(b, on) {
        b.setAttribute('aria-pressed', String(on));
        b.textContent = on ? '클로드 앱 떼기' : '클로드 앱 붙이기';
        b.title = on ? '클로드 앱 창을 떼고 대화창을 되돌려요' : '대화창 가운데에 클로드 앱 창을 끼워요 (위아래 버튼은 그대로)';
        document.body.classList.toggle('claude-docked', on);
    }

    const nextFrame = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));

    /** 지금 구멍 자리로 클로드 창을 맞춘다. 클로드 창이 더 넓으면 대화창 칸을 넓히고 한 번 더 */
    async function fit(widened) {
        const hole = holeRect();
        const r = await T().invoke('claude_dock', { on: true, hole });
        if (!widened && r && r.width > hole.w + 2) {
            const col = document.querySelector('.hub > section.col[aria-label="대화"]');
            const hub = document.querySelector('.hub');
            if (col && hub) {
                hub.style.setProperty('--chat-w', Math.ceil(col.getBoundingClientRect().width + r.width - hole.w) + 'px');
                await nextFrame();
                return fit(true);
            }
        }
        return r;
    }

    async function set(b, on) {
        try {
            if (!on) {
                await T().invoke('claude_dock', { on: false });
                render(b, false);
            } else {
                render(b, true);
                await nextFrame();
                await fit(false);
            }
            try { localStorage.setItem(KEY, on ? '1' : '0'); } catch { /* 미리보기 */ }
        } catch (e) {
            render(b, false);
            toast(String(e && e.message || e));
        }
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
        b.addEventListener('click', () => set(b, !docked()));
        head.appendChild(b); // 탭 줄 오른쪽 끝 (탭은 아님)

        // 구멍 크기가 바뀌면 다시 맞춘다 (잠깐 모아서)
        let timer = null;
        const refit = () => {
            if (!docked()) return;
            clearTimeout(timer);
            timer = setTimeout(() => fit(true).catch(e => toast(String(e && e.message || e))), 120);
        };
        if (typeof ResizeObserver !== 'undefined') new ResizeObserver(refit).observe(document.getElementById('hub-claude-hole'));
        window.addEventListener('resize', refit);

        let saved = false;
        try { saved = localStorage.getItem(KEY) === '1'; } catch { /* 미리보기 */ }
        if (saved) set(b, true);
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
