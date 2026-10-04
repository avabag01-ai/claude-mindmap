// 클로드 앱 연동: 마인드맵에서 앱 세션을 고르면 클로드 앱 화면도 그 세션으로 바뀌고,
// 대화창에서 보내면 복사·붙여넣기 없이 앱 입력칸에 넣어 보낸다 (src-tauri/src/claude_app_ax.rs).
// - 바꾸기: 'claude-app:focus' { appId } — 앱이 앞으로 나와도 마인드맵을 다시 앞으로 돌린다
// - 보내기: 'claude-app:send' { id, appId, text } → 'claude-app:send-result' { ok, reason, message }
//   앱 입력칸에 쓰던 글이 있거나(typing) 그 세션이 일하는 중(busy)이면 멈추고 글은 대화창에 돌려 둔다.
//   권한이 없거나 화면을 확인 못 하면 예전처럼 글을 복사하고 앱을 연다 (붙여넣기는 사람이).
(function () {
    if (typeof SessionHub === 'undefined') return;

    /** 앱이 아는(보관 안 한) 세션이면 앱 세션 id (local_…) */
    SessionHub.appIdOf = function (app, id) {
        const a = app && app.ok && app.sessions && app.sessions[id];
        return a && !a.archived && /^local_[A-Za-z0-9-]{1,64}$/.test(a.appId || '') ? a.appId : null;
    };

    /** 보내기가 멈춘 까닭 중 사람이 봐야 하는 것 (복사로 넘기지 않음). not-sent 는 글이 이미 앱 입력칸에 있다 */
    SessionHub.APP_SEND_STOP = ['typing', 'busy', 'not-taken', 'not-sent'];

    const P = SessionHub.prototype;
    const toast = (hub, m) => { if (hub.map && hub.map._toast) hub.map._toast(m); };

    const select = P.selectSession;
    P.selectSession = function (root, id) {
        const changed = !this.sel || this.sel.root !== root || this.sel.id !== id;
        const r = select.apply(this, arguments);
        const appId = SessionHub.appIdOf(this.data && this.data.claudeApp, id);
        if (changed && appId && this.ipc) this.ipc.send('claude-app:focus', { appId });
        return r;
    };

    P._handOff = function (s, text) {
        if (!SessionHub.inApp(this.data && this.data.claudeApp, s.id) || !this.ipc) return false;
        const appId = SessionHub.appIdOf(this.data.claudeApp, s.id);
        if (!appId) {
            this.ipc.send('claude-app:handoff', { id: s.id, text });
            toast(this, '클로드 앱 세션이라 앱에서 이어가요. 글을 복사해 뒀으니 붙여넣고 Enter 하세요');
            return true;
        }
        this._appSend = { id: s.id, appId, text };
        this.ipc.send('claude-app:send', { id: s.id, appId, text });
        toast(this, '클로드 앱 세션에 보내는 중…');
        return true;
    };

    P._onAppSend = function (r) {
        const sent = this._appSend;
        if (!r || !sent || r.appId !== sent.appId) return;
        this._appSend = null;
        if (r.ok) return toast(this, '클로드 앱 세션에 보냈어요. 답은 앱에서 이어져요');
        if (SessionHub.APP_SEND_STOP.includes(r.reason)) {
            // 대화창이 비어 있으면 글을 돌려 둔다 (not-sent 는 앱 입력칸에 이미 있어서 안 돌림)
            const input = typeof document !== 'undefined' && document.getElementById('hub-input');
            if (input && !input.value.trim() && r.reason !== 'not-sent') input.value = sent.text;
            return toast(this, r.message || '보내지 못했어요');
        }
        this.ipc.send('claude-app:handoff', { id: sent.id, appId: sent.appId, text: sent.text });
        toast(this, `${r.message ? r.message + ' — ' : ''}글을 복사해 뒀으니 앱에서 붙여넣고 Enter 하세요`);
    };

    const start = P.start;
    P.start = function () {
        const r = start.apply(this, arguments);
        if (this.ipc) this.ipc.on('claude-app:send-result', (e, x) => this._onAppSend(x));
        return r;
    };
})();
