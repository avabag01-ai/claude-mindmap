// Tauri 화면용 IPC: Electron ipcRenderer 와 같은 모양 { send, on } 을 window.ipcRenderer 로 만든다.
// send = invoke('ipc_send'), 답은 Rust 가 같은 이름의 이벤트로 보낸다 (예: 'sessions:index-result').
(function () {
    const T = window.__TAURI__;
    if (!T || window.ipcRenderer) return;
    const handlers = new Map();
    window.ipcRenderer = {
        send(channel, payload) {
            T.core.invoke('ipc_send', { channel, payload: payload === undefined ? null : payload })
                .catch(e => console.error('ipc_send', channel, e));
        },
        on(channel, fn) {
            if (!handlers.has(channel)) {
                handlers.set(channel, []);
                T.event.listen(channel, ev => { for (const f of handlers.get(channel)) f({}, ev.payload); });
            }
            handlers.get(channel).push(fn);
        }
    };

    // 창 끌기: Tauri 는 CSS -webkit-app-region 을 모른다. 맨 위 머리줄(.col-head·.hub-tabs)의 빈칸을 누르면 창을 옮기고,
    // 두 번 누르면 크게/원래대로. 버튼·입력칸 위는 그대로 둔다.
    const NO_DRAG = 'button, input, select, textarea, a, label, [contenteditable], [role=button], .hub-usage';
    const dragHead = el => {
        if (!(el instanceof Element) || el.closest(NO_DRAG)) return null;
        const head = el.closest('.col-head, .hub-tabs');
        return head && !head.closest('.hub-panel') ? head : null;
    };
    document.addEventListener('mousedown', e => {
        if (e.button !== 0 || !dragHead(e.target)) return;
        e.preventDefault();
        const win = T.window.getCurrentWindow();
        (e.detail === 2 ? win.toggleMaximize() : win.startDragging()).catch(err => console.error('창 끌기', err));
    });
})();
