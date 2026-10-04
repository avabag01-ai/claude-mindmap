// 오른쪽 대화창 너비: 대화창 왼쪽 세로선을 좌우로 끌어 조절. 두 번 누르면 처음 너비로.
// 너비는 .hub 의 --chat-w 로 넣고 기억한다 (localStorage 'hub.chatWidth'). 좁은 화면(한 줄로 쌓일 때)에서는 안 쓴다.
(function () {
    if (typeof document === 'undefined') return;
    const KEY = 'hub.chatWidth';
    const MIN = 280;
    const MIN_CENTER = 320; // 가운데 맵은 이만큼 남긴다

    function init() {
        const hub = document.querySelector('.hub');
        const chat = document.querySelector('section.col[aria-label="대화"]');
        if (!hub || !chat) return;
        const bar = document.createElement('div');
        bar.className = 'chat-resizer';
        bar.setAttribute('role', 'separator');
        bar.setAttribute('aria-orientation', 'vertical');
        bar.title = '끌어서 대화창 너비 조절 · 두 번 누르면 처음대로';
        chat.appendChild(bar);

        const clamp = w => {
            const hubLeft = hub.getBoundingClientRect().left;
            const left = document.querySelector('.hub-left');
            const leftW = left && left.offsetParent ? left.getBoundingClientRect().width : 0;
            const max = window.innerWidth - hubLeft - leftW - MIN_CENTER;
            return Math.round(Math.max(MIN, Math.min(w, max)));
        };
        const apply = w => hub.style.setProperty('--chat-w', `${w}px`);
        const save = w => { try { w ? localStorage.setItem(KEY, String(w)) : localStorage.removeItem(KEY); } catch { /* 미리보기 */ } };

        let saved = 0;
        try { saved = +localStorage.getItem(KEY) || 0; } catch { /* 미리보기 */ }
        if (saved) apply(clamp(saved));

        bar.addEventListener('pointerdown', e => {
            e.preventDefault();
            bar.setPointerCapture(e.pointerId);
            document.body.classList.add('chat-resizing');
            const right = chat.getBoundingClientRect().right;
            let w = chat.getBoundingClientRect().width;
            const move = ev => { w = clamp(right - ev.clientX); apply(w); };
            const up = () => {
                bar.removeEventListener('pointermove', move);
                bar.removeEventListener('pointerup', up);
                bar.removeEventListener('pointercancel', up);
                document.body.classList.remove('chat-resizing');
                save(w);
            };
            bar.addEventListener('pointermove', move);
            bar.addEventListener('pointerup', up);
            bar.addEventListener('pointercancel', up);
        });
        bar.addEventListener('dblclick', () => { hub.style.removeProperty('--chat-w'); save(0); });
        // 창이 줄면 가운데가 너무 좁아지지 않게 다시 맞춘다
        window.addEventListener('resize', () => {
            const cur = parseFloat(hub.style.getPropertyValue('--chat-w'));
            if (cur) apply(clamp(cur));
        });
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
})();
