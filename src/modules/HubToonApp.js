// 툰으로 이어가기 — 클로드 앱 세션: 마인드맵이 따로 돌리지 않고 앱 안에서 이어간다.
// ① 지금 세션(앱)에 "툰 저장" 글을 AX 로 보낸다 ('claude-app:send', HubAppLink.js 와 같은 길)
// ② 그 세션 기록(jsonl)에서 보낸 뒤 쓰인 답의 ```toon-next 를 기다린다 ('claude-app:wait-toon')
// ③ 클로드 앱에 새 세션을 열고 첫 메시지 보내기까지 누른다 ('claude-app:new' send) — '작업 공간 신뢰'는 사람이
// ④ 새 세션이 목록에 생기면 마인드맵에서 원래 세션의 다음 칸(같은 줄기·주제)에 붙이고 툰이 준 제목을 단다
// 앱 밖 세션은 예전대로 SessionHub.toonAndContinue (마인드맵이 툰 저장·새 세션을 돌림).
// 붙인 동안(body.claude-docked) 아래 '보내기' 자리에 '툰으로 이어가기' 단추 — 두 번 눌러야 시작.
(function () {
    if (typeof SessionHub === 'undefined') return;
    const P = SessionHub.prototype;
    const toast = (hub, m) => { if (hub.map && hub.map._toast) hub.map._toast(m); };

    /** 툰 답에서 새 세션 첫 메시지와 제목 (제목 — 툰 불러와 — …) */
    SessionHub.toonNextFrom = function (text, cwd) {
        const prompt = SessionHub.withTitle(SessionHub.nextPrompt(text, `툰 불러와 — root: ${cwd}`), `${SessionMindMap._base(cwd)} 이어서`);
        const m = /^(.+?)\s+—\s+툰\s*불러/.exec(prompt);
        return { prompt, title: m ? m[1].trim() : null };
    };

    /** 목록에서 새로 생긴 이어가기 세션 찾기: 시작 전에 없던 세션 중 첫 메시지가 그 제목으로 시작하는 것 */
    SessionHub.findContinued = function (projects, known, title) {
        for (const p of projects || []) {
            for (const s of p.sessions || []) {
                if (s.remote || known.has(s.id)) continue;
                if (title && String(s.firstPrompt || s.title || '').trim().startsWith(title)) return { p, s };
            }
        }
        return null;
    };

    const original = P.toonAndContinue;
    P.toonAndContinue = function () {
        const s = this._selSession();
        const appId = s && SessionHub.appIdOf(this.data && this.data.claudeApp, s.id);
        if (!appId || !this.ipc) return original.apply(this, arguments);
        if (this._toonApp) return toast(this, '툰 이어가기가 이미 진행 중이에요');
        this.toonAsk = false;
        this._toonApp = { stage: 'size', fromId: s.id, appId, root: this.sel.root, cwd: s.cwd, topic: s.topic || null, file: s.file };
        this.ipc.send('claude-app:file-size', { file: s.file });
        toast(this, '1/3 클로드 앱 세션에 툰 저장을 보내요');
        this._renderChat();
    };

    P._toonAppStep = function (ch, r) {
        const f = this._toonApp;
        if (!f || !r) return;
        const fail = m => { this._toonApp = null; toast(this, m); this._renderChat(); };
        if (ch === 'size' && f.stage === 'size' && r.file === f.file) {
            f.stage = 'save';
            f.offset = r.size || 0;
            this.ipc.send('claude-app:send', { id: f.fromId, appId: f.appId, text: SessionHub.TOON_SAVE_TEXT });
        } else if (ch === 'send' && f.stage === 'save' && r.appId === f.appId) {
            if (!r.ok) return fail(`툰 저장을 못 보냈어요 — ${r.message || r.reason || ''}`);
            f.stage = 'wait';
            this.ipc.send('claude-app:wait-toon', { file: f.file, offset: f.offset });
            toast(this, '2/3 툰 저장 답을 기다려요 (클로드 앱에서 진행돼요)');
        } else if (ch === 'wait' && f.stage === 'wait' && r.file === f.file) {
            if (!r.ok) return fail('툰 저장 답에서 시작 메시지를 못 찾았어요');
            const { prompt, title } = SessionHub.toonNextFrom(r.text, f.cwd);
            const app = this.data && this.data.claudeApp;
            const a = app && app.sessions && app.sessions[f.fromId];
            const group = a && app.groups.find(g => g.id === a.group);
            const folder = SessionHub.mainRoot(f.cwd);
            f.stage = 'new';
            f.title = title;
            f.known = new Set((this.data.projects || []).flatMap(p => p.sessions.map(x => x.id)));
            f.until = Date.now() + 15 * 60 * 1000;
            this.ipc.send('claude-app:new', { folder, prompt: SessionHub.withGroup(prompt, group, folder), send: true });
        } else if (ch === 'new' && f.stage === 'new') {
            if (!r.ok) return fail('클로드 앱에 새 세션을 못 열었어요');
            f.stage = 'attach';
            toast(this, r.sent === false ? `3/3 새 세션을 열었어요. ${r.message || '앱에서 Enter 를 눌러 주세요'}` : `3/3 새 세션 "${f.title || ''}" 을 시작했어요`);
            this._toonAttach();
        }
    };

    /** 새 세션이 목록에 생기면 원래 세션 옆(다음 칸)에 붙이고 제목을 단다 */
    P._toonAttach = function () {
        const f = this._toonApp;
        if (!f || f.stage !== 'attach' || !this.data) return;
        if (Date.now() > f.until) { this._toonApp = null; return; }
        const hit = SessionHub.findContinued(this.data.projects, f.known, f.title);
        if (!hit) return;
        this._toonApp = null;
        this.ipc.send('sessions:meta', { root: hit.p.root, id: hit.s.id, prevId: f.fromId, topic: f.topic || SessionHub.topicOf(hit.s.firstPrompt) || undefined });
        if (f.title) this.ipc.send('sessions:rename', { root: hit.p.root, id: hit.s.id, title: f.title });
        toast(this, `새 세션을 원래 세션 옆에 붙였어요: ${f.title || ''}`);
    };

    const onIndex = P._onIndex;
    P._onIndex = function () {
        const r = onIndex.apply(this, arguments);
        this._toonAttach();
        return r;
    };

    // 아래 단추: 붙인 동안 '보내기' 대신 '툰으로 이어가기' (입력은 클로드 앱 창에서 하니까)
    P._toonBottom = function () {
        const send = typeof document !== 'undefined' && document.getElementById('hub-send');
        if (!send || document.getElementById('hub-toon-bottom')) return;
        const b = document.createElement('button');
        b.id = 'hub-toon-bottom';
        b.type = 'button';
        b.className = 'btn btn-primary hub-toon-bottom';
        const label = '툰으로 이어가기';
        b.textContent = label;
        b.title = '지금 세션에 툰을 저장하고, 새 세션을 이 세션 옆에 만들어 이어가요';
        let armed = null;
        b.addEventListener('click', () => {
            if (!this._selSession()) return toast(this, '왼쪽이나 맵에서 세션을 먼저 고르세요');
            if (!armed) {
                b.textContent = '한 번 더 누르면 시작';
                armed = setTimeout(() => { armed = null; b.textContent = label; }, 3000);
                return;
            }
            clearTimeout(armed);
            armed = null;
            b.textContent = label;
            this.toonAndContinue();
        });
        send.insertAdjacentElement('afterend', b);
    };

    const start = P.start;
    P.start = function () {
        const r = start.apply(this, arguments);
        if (this.ipc) {
            this.ipc.on('claude-app:file-size-result', (e, x) => this._toonAppStep('size', x));
            this.ipc.on('claude-app:send-result', (e, x) => this._toonAppStep('send', x));
            this.ipc.on('claude-app:wait-toon-result', (e, x) => this._toonAppStep('wait', x));
            this.ipc.on('claude-app:new-result', (e, x) => this._toonAppStep('new', x));
        }
        this._toonBottom();
        return r;
    };
})();
