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
})();
