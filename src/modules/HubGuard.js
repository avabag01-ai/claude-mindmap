// 충돌 막기: 이미 있는 세션에 보내기 전에, 그 기록이 방금 다른 곳(클로드 앱·터미널)에서 바뀌었으면 한 번 묻는다.
// 같은 기록 파일에 두 군데서 동시에 쓰면 대화가 엉키기 때문. 마인드맵이 직접 보낸 지 얼마 안 된 것은 묻지 않는다.
// SessionHub._startRun 을 감싼다 (보내기 · 자세히 · 툰 저장 모두 여기로 지나간다).
(function () {
    if (typeof SessionHub === 'undefined') return;
    const P = SessionHub.prototype;
    const BUSY_MS = 90 * 1000;   // 이 안에 기록이 바뀌었으면 "쓰는 중"으로 본다

    /** 다른 곳에서 쓰는 중인가: 기록이 BUSY_MS 안에 바뀌었고, 그게 마인드맵이 보낸 것 때문이 아니면 */
    SessionHub.busyElsewhere = function (s, ownAt, now) {
        if (!s || s.remote) return false;
        const last = s.lastAt || 0;
        if (now - last > BUSY_MS) return false;
        return !(ownAt && last <= ownAt + 5000);
    };

    const startRun = P._startRun;
    P._startRun = function (args) {
        if (!args.sessionId || args.force) return startRun.call(this, args);
        const p = this.data && this.data.projects.find(x => x.root === args.root);
        const s = p && p.sessions.find(x => x.id === args.sessionId);
        const own = (this._ownRunAt || {})[args.sessionId];
        if (!SessionHub.busyElsewhere(s, own, this.now())) return startRun.call(this, args);
        this._busyAsk = { args, typed: this.el('hub-input') ? this.el('hub-input').value : '', attachments: [...(this.attachments || [])] };
        setTimeout(() => this._renderBusyAsk(), 0); // send() 가 입력창을 비운 뒤에 그린다
        return null;
    };

    // 마인드맵이 보낸 것은 끝난 시각을 기억해 둔다 (그 뒤 기록이 바뀐 건 우리 것)
    const onRunExit = P._onRunExit;
    P._onRunExit = function (r) {
        if (this.run && this.run.runId === r.runId) {
            const id = this.run.sessionId || this.run.newSessionId;
            if (id) (this._ownRunAt = this._ownRunAt || {})[id] = this.now();
        }
        return onRunExit.call(this, r);
    };

    // 다른 세션을 고르면 묻던 것은 닫는다
    const selectSession = P.selectSession;
    P.selectSession = function (root, id) {
        if (this._busyAsk && this._busyAsk.args.sessionId !== id) { this._busyAsk = null; this._renderBusyAsk(); }
        return selectSession.call(this, root, id);
    };

    P._renderBusyAsk = function () {
        const composer = this.el('hub-composer');
        let box = document.getElementById('hub-busy-ask');
        if (!this._busyAsk) { if (box) box.remove(); return; }
        if (!composer) return;
        if (!box) {
            box = document.createElement('div');
            box.id = 'hub-busy-ask';
            box.className = 'hub-confirm';
            box.setAttribute('role', 'alertdialog');
            composer.parentNode.insertBefore(box, composer);
            box.addEventListener('click', e => {
                const b = e.target.closest('button');
                if (b) this._answerBusy(b.dataset.act === 'busy-go');
            });
        }
        box.innerHTML = `<p><b>이 세션은 방금 다른 곳(클로드 앱이나 터미널)에서 쓰고 있어요.</b> 지금 보내면 같은 기록에 두 군데서 써서 대화가 엉킬 수 있어요. 그쪽이 끝난 뒤에 보내는 게 안전해요.</p>
            <div class="row"><button class="btn" data-act="busy-cancel">그만두기</button><button class="btn" data-act="busy-go">그래도 보내기</button></div>`;
    };

    P._answerBusy = function (go) {
        const ask = this._busyAsk;
        this._busyAsk = null;
        this._renderBusyAsk();
        if (!ask) return;
        if (go) {
            const runId = startRun.call(this, { ...ask.args, force: true });
            if (this.toonFlow && !this.toonFlow.runId) this.toonFlow.runId = runId;
            return;
        }
        if (this.toonFlow && !this.toonFlow.runId) this.toonFlow = null;
        const input = this.el('hub-input');
        if (input && ask.typed && !input.value) input.value = ask.typed; // 쓴 글·첨부는 돌려놓는다
        if (ask.attachments.length && !this.attachments.length) { this.attachments = ask.attachments; this._renderAttachments(); }
        this._renderChat();
    };
})();
