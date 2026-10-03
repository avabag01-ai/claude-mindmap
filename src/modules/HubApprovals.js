// 허용 창: 대화창에서 보낸 claude 가 물을 도구(명령 실행 등)를 쓰려 하면 입력칸 위에 허용 / 거절을 띄운다 (클로드 앱처럼).
// 물음은 scripts/mindmap-approve-mcp.js → 앱('approval:list') 으로 온다. 실행 중일 때만 1초마다 확인한다.
class HubApprovals {
    constructor(hub) {
        this.hub = hub;
        this.ipc = hub.ipc;
        this.items = [];
        this.answered = new Set();
        if (!this.ipc) return;
        HubApprovals._injectStyle();
        this.box = document.createElement('div');
        this.box.className = 'hub-approve';
        this.box.setAttribute('role', 'alertdialog');
        this.box.hidden = true;
        const composer = document.getElementById('hub-composer');
        composer.insertBefore(this.box, composer.firstChild);
        this.ipc.on('approval:list-result', (e, r) => this._show((r && r.items) || []));
        this.ipc.on('approval:answer-result', (e, r) => { if (r && r.error) this.hub.map._toast(r.error); this._poll(); });
        this.box.addEventListener('click', e => {
            const b = e.target.closest('button[data-ans]');
            if (!b || !this.items[0]) return;
            const id = this.items[0].id;
            this.answered.add(id);
            this.ipc.send('approval:answer', { id, allow: b.dataset.ans !== 'deny', always: b.dataset.ans === 'always' });
            this._show(this.items.slice(1));
        });
        setInterval(() => this._poll(), 1000);
    }

    _poll() {
        const run = this.hub.run;
        if ((run && !run.done) || this.items.length) this.ipc.send('approval:list', {});
    }

    static _summary(it) {
        const i = it.input || {};
        if (it.tool === 'Bash') return i.command || '';
        if (i.file_path) return i.file_path;
        if (i.url) return i.url;
        if (i.path) return i.path;
        if (i.pattern) return i.pattern;
        const s = JSON.stringify(i);
        return s.length > 300 ? s.slice(0, 300) + '…' : s;
    }

    _show(items) {
        this.items = items.filter(it => !this.answered.has(it.id));
        const it = this.items[0];
        if (!it) { this.box.hidden = true; this.box.innerHTML = ''; return; }
        const esc = SessionMindMap._esc;
        const more = this.items.length > 1 ? ` <span class="hub-approve-more">+${this.items.length - 1}개 더</span>` : '';
        const why = it.input && it.input.description ? `<div class="hub-approve-why">${esc(it.input.description)}</div>` : '';
        this.box.innerHTML = `<div class="hub-approve-head">Claude 가 <b>${esc(it.tool)}</b> 를 쓰려고 해요${more}</div>
            ${why}<pre class="hub-approve-what">${esc(HubApprovals._summary(it))}</pre>
            <div class="hub-approve-cwd">${esc(it.cwd || '')}</div>
            <div class="row">
                <button class="btn btn-primary" data-ans="once">허용</button>
                <button class="btn" data-ans="always" title="${esc(it.cwd || '')}/.claude/settings.local.json 에 ${esc(it.rule || it.tool)} 규칙을 넣어요 (클로드 앱·터미널도 같이 씀)">이 폴더에서 항상 허용</button>
                <button class="btn" data-ans="deny">거절</button>
            </div>`;
        this.box.hidden = false;
    }

    static _injectStyle() {
        if (document.getElementById('hub-approve-style')) return;
        const style = document.createElement('style');
        style.id = 'hub-approve-style';
        style.textContent = `
        .hub-approve { border:1px solid #e5a050; background:color-mix(in srgb, #e5a050 10%, var(--panel)); border-radius:8px; padding:8px 10px; margin-bottom:8px; display:grid; gap:6px; }
        .hub-approve-head { font-size:12.5px; }
        .hub-approve-more { color:var(--muted); font-size:11px; }
        .hub-approve-why { color:var(--muted); font-size:12px; }
        .hub-approve-what { margin:0; font:11.5px/1.45 var(--mono); background:var(--bg); padding:6px 8px; border-radius:6px; white-space:pre-wrap; overflow-wrap:anywhere; max-height:9em; overflow:auto; }
        .hub-approve-cwd { color:var(--muted); font-size:11px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
        .composer .hub-approve .row { flex-wrap:wrap; justify-content:flex-start; }`;
        document.head.appendChild(style);
    }
}
