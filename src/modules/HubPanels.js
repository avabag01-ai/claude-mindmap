/**
 * HubPanels.js
 * =============================================================================
 * 세션 허브 왼쪽 패널의 파인더 탭과 메모 탭
 *
 * 파인더: 폴더를 둘러보고, 파일을 대화창·세션으로 끌어다 놓으면 첨부된다 (두 번 누르면 바로 첨부).
 *         폴더 목록만 읽고 파일 내용은 읽지 않는다 (main.js 'fs:list').
 * 메모:   주소·코드 조각·비밀(API 키, 비밀번호)을 저장하고 바로 복사하거나 입력창에 넣는다.
 *         비밀 메모는 맥 키체인(safeStorage)으로 암호화해 저장하고, 목록에서는 가려 둔다.
 */

// 끌어다 놓기로 넘기는 경로 목록의 데이터 형식
const MINDMAP_PATHS = 'application/x-mindmap-paths';

class HubFinder {
    constructor(hub, options = {}) {
        this.hub = hub;
        this.ipc = hub.ipc;
        this.preview = options.previewFs || null; // 미리보기: { dir: entries[] }
        this.dir = null;
        this.home = null;
        this.showHidden = false;
        this.filter = '';
        this.entries = [];
        this.error = null;
        this.el = id => document.getElementById(id);
        this._bind();
        if (this.ipc) this.ipc.on('fs:list-result', (e, r) => this._onList(r));
    }

    open(dir) {
        this.error = null;
        if (this.ipc) {
            this.ipc.send('fs:list', { dir: dir || this.dir || null, showHidden: this.showHidden });
        } else if (this.preview) {
            const want = dir || this.dir;
            const d = want && this.preview[want] ? want : Object.keys(this.preview)[0]; // 미리보기에 없는 폴더면 첫 폴더
            const entries = this.preview[d] || [];
            const parent = d.replace(/\/[^/]*$/, '') || null;
            this._onList({ dir: d, parent: parent && parent !== d ? parent : null, home: Object.keys(this.preview)[0], entries });
        }
    }

    // 처음 열 때: 고른 세션의 폴더, 없으면 홈
    show() {
        if (this.dir) return this._render();
        const s = this.hub._selSession();
        this.open(s ? s.cwd : (this.hub.sel && this.hub.sel.root) || null);
    }

    _onList(r) {
        if (!r) return;
        this.home = r.home || this.home;
        if (r.error) { this.error = r.error; this._render(); return; }
        this.dir = r.dir;
        this.parent = r.parent;
        this.entries = r.entries || [];
        this.filter = '';
        const f = this.el('finder-filter');
        if (f) f.value = '';
        this._render();
    }

    _render() {
        const esc = SessionMindMap._esc;
        const body = this.el('finder-body');
        if (!body) return;
        this.el('finder-path').textContent = this.dir ? this._short(this.dir) : '';
        this.el('finder-path').title = this.dir || '';
        this.el('finder-up').disabled = !this.parent;
        if (this.error) { body.innerHTML = `<p class="hub-empty">${esc(this.error)}</p>`; return; }
        const q = this.filter;
        const list = this.entries.filter(e => !q || e.name.toLowerCase().includes(q));
        if (!list.length) { body.innerHTML = `<p class="hub-empty">${q ? '찾는 파일이 없어요' : '빈 폴더예요'}</p>`; return; }
        body.innerHTML = list.map(e => `<div class="finder-item${e.isDir ? ' is-dir' : ''}" draggable="true" data-path="${esc(e.path)}" data-dir="${e.isDir ? 1 : 0}" title="${esc(e.path)}${e.isDir ? '' : ' · 두 번 누르면 첨부'}">
            <span class="finder-icon" aria-hidden="true">${e.isDir ? '📁' : HubFinder.icon(e.name)}</span>
            <span class="finder-name">${esc(e.name)}</span>
            <span class="finder-meta">${e.isDir ? '' : HubFinder.size(e.size)}</span></div>`).join('');
    }

    _short(p) {
        return this.home && p.startsWith(this.home) ? '~' + p.slice(this.home.length) : p;
    }

    _bind() {
        const body = this.el('finder-body');
        if (!body) return;
        body.addEventListener('dblclick', e => {
            const it = e.target.closest('.finder-item');
            if (!it) return;
            if (it.dataset.dir === '1') this.open(it.dataset.path);
            else this.hub.addAttachments([it.dataset.path]);
        });
        body.addEventListener('keydown', e => {
            const it = e.target.closest('.finder-item');
            if (it && e.key === 'Enter') it.dispatchEvent(new MouseEvent('dblclick', { bubbles: true }));
        });
        body.addEventListener('dragstart', e => {
            const it = e.target.closest('.finder-item');
            if (!it) return;
            e.dataTransfer.setData(MINDMAP_PATHS, JSON.stringify([it.dataset.path]));
            e.dataTransfer.setData('text/plain', it.dataset.path);
            e.dataTransfer.effectAllowed = 'copy';
            document.body.classList.add('hub-dragging-file');
        });
        body.addEventListener('dragend', () => document.body.classList.remove('hub-dragging-file'));
        this.el('finder-up').addEventListener('click', () => { if (this.parent) this.open(this.parent); });
        this.el('finder-home').addEventListener('click', () => this.open(this.home || null));
        this.el('finder-session').addEventListener('click', () => {
            const s = this.hub._selSession();
            const root = s ? s.cwd : this.hub.sel && this.hub.sel.root;
            if (root) this.open(root);
            else this.hub.map._toast('먼저 세션이나 폴더를 고르세요');
        });
        this.el('finder-hidden').addEventListener('change', e => { this.showHidden = e.target.checked; this.open(this.dir); });
        this.el('finder-filter').addEventListener('input', e => { this.filter = e.target.value.trim().toLowerCase(); this._render(); });
    }

    static icon(name) {
        const ext = (name.split('.').pop() || '').toLowerCase();
        if (['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'heic'].includes(ext)) return '🖼️';
        if (['mid', 'midi', 'wav', 'mp3', 'aif', 'aiff', 'm4a', 'flac'].includes(ext)) return '🎵';
        if (['pdf'].includes(ext)) return '📕';
        if (['md', 'txt', 'toon'].includes(ext)) return '📝';
        if (['js', 'ts', 'py', 'swift', 'cpp', 'h', 'c', 'json', 'html', 'css', 'sh', 'rs', 'go'].includes(ext)) return '📄';
        return '📄';
    }

    static size(n) {
        if (!n) return '0 B';
        const u = ['B', 'KB', 'MB', 'GB'];
        let i = 0;
        while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
        return `${n < 10 && i ? n.toFixed(1) : Math.round(n)} ${u[i]}`;
    }
}

class HubMemos {
    constructor(hub, options = {}) {
        this.hub = hub;
        this.ipc = hub.ipc;
        this.el = id => document.getElementById(id);
        this.memos = [];
        this.canEncrypt = true;
        this.query = '';
        this.editing = null;        // { id?, title, kind, body }
        this.revealed = new Map();  // id → 본문 (비밀 메모를 보기로 연 것)
        this.confirm = null;        // { id, action: 'delete' | 'insert' }
        this.loaded = false;
        // 미리보기: 메모를 메모리에만 둔다
        this.previewMemos = options.previewMemos ? options.previewMemos.map(m => ({ ...m })) : null;
        this._bind();
        if (this.ipc) {
            this.ipc.on('memos:result', (e, r) => this._onResult(r));
            this.ipc.on('memos:reveal-result', (e, r) => this._onReveal(r));
        }
    }

    show() {
        if (!this.loaded) this.reload();
        else this._render();
    }

    reload() {
        if (this.ipc) this.ipc.send('memos:list');
        else this._onResult({ ok: true, canEncrypt: true, memos: this._previewList() });
    }

    _previewList() {
        return (this.previewMemos || []).slice().sort((a, b) => b.updatedAt - a.updatedAt)
            .map(m => m.kind === 'secret' ? { id: m.id, title: m.title, kind: m.kind, updatedAt: m.updatedAt, encrypted: true, length: m.body.length } : m);
    }

    _onResult(r) {
        if (!r) return;
        this.loaded = true;
        this.memos = r.memos || [];
        this.canEncrypt = r.canEncrypt !== false;
        if (!r.ok) this.hub.map._toast(r.error || '메모를 저장하지 못했어요');
        else if (r.saved) { this.editing = null; this.hub.map._toast('저장했어요'); }
        else if (r.deleted) this.hub.map._toast('지웠어요');
        this._render();
    }

    _render() {
        const esc = SessionMindMap._esc;
        const body = this.el('memo-body');
        if (!body) return;
        this._renderEditor();
        const q = this.query;
        const list = this.memos.filter(m => !q || m.title.toLowerCase().includes(q) || (m.body && m.body.toLowerCase().includes(q)));
        if (!list.length) {
            body.innerHTML = `<p class="hub-empty">${q ? '찾는 메모가 없어요' : '주소, 자주 쓰는 코드, API 키 같은 걸 저장해 두세요'}</p>`;
            return;
        }
        const KIND = { memo: '메모', code: '코드', secret: '비밀' };
        body.innerHTML = list.map(m => {
            const secret = m.kind === 'secret';
            const shown = secret ? this.revealed.get(m.id) : m.body;
            const text = secret && shown == null ? '•'.repeat(Math.min(16, Math.max(6, m.length || 8))) : (shown || '');
            const conf = this.confirm && this.confirm.id === m.id ? this.confirm.action : null;
            return `<div class="memo-item memo-${m.kind}" data-id="${esc(m.id)}">
                <div class="memo-top"><span class="memo-kind">${KIND[m.kind]}</span><b class="memo-title">${esc(m.title)}</b>
                  ${secret && !m.encrypted ? '<span class="memo-warn" title="이 컴퓨터에서는 암호화를 못 해서 가려서만 저장됐어요">암호화 안 됨</span>' : ''}</div>
                <pre class="memo-text${m.kind === 'code' ? ' is-code' : ''}${secret && shown == null ? ' is-masked' : ''}">${esc(text)}</pre>
                ${conf === 'delete' ? `<div class="memo-confirm">지울까요? <button class="btn" data-act="memo-delete-yes">지우기</button><button class="btn" data-act="memo-cancel">취소</button></div>` : ''}
                ${conf === 'insert' ? `<div class="memo-confirm">비밀이 대화 기록에 남아요. 넣을까요? <button class="btn" data-act="memo-insert-yes">넣기</button><button class="btn" data-act="memo-cancel">취소</button></div>` : ''}
                <div class="memo-actions">
                  <button class="hub-link" data-act="memo-copy">복사</button>
                  <button class="hub-link" data-act="memo-insert">입력창에 넣기</button>
                  ${secret ? `<button class="hub-link" data-act="memo-reveal">${shown == null ? '보기' : '가리기'}</button>` : ''}
                  <button class="hub-link" data-act="memo-edit">고치기</button>
                  <button class="hub-link memo-danger" data-act="memo-delete">지우기</button>
                </div></div>`;
        }).join('');
    }

    _renderEditor() {
        const box = this.el('memo-editor');
        if (!box) return;
        const e = this.editing;
        if (!e) { box.hidden = true; box.innerHTML = ''; return; }
        const esc = SessionMindMap._esc;
        box.hidden = false;
        const secretEdit = e.id && e.kind === 'secret' && e.body == null;
        box.innerHTML = `<label class="memo-field">제목<input id="memo-title" value="${esc(e.title || '')}" placeholder="예: 서버 주소, OpenAI 키, 폴더 순회 반복문"></label>
            <div class="memo-kinds" role="radiogroup" aria-label="종류">
              ${[['memo', '메모'], ['code', '코드'], ['secret', '비밀']].map(([k, l]) => `<label><input type="radio" name="memo-kind" value="${k}"${e.kind === k ? ' checked' : ''}> ${l}</label>`).join('')}
            </div>
            <label class="memo-field">내용
              <textarea id="memo-text" rows="5" spellcheck="false" placeholder="${secretEdit ? '비워 두면 원래 내용 그대로예요' : '내용'}">${esc(e.body || '')}</textarea></label>
            ${e.kind === 'secret' ? `<p class="hub-muted">${this.canEncrypt ? '비밀 메모는 맥 키체인으로 암호화해서 저장하고, 목록에서는 가려 보여요.' : '이 컴퓨터에서는 암호화를 못 해요. 가려서 보여 주지만 파일에는 암호화 없이 저장돼요.'}</p>` : ''}
            <div class="row"><button class="btn btn-primary" data-act="memo-save">저장</button><button class="btn" data-act="memo-cancel-edit">취소</button></div>`;
        const t = this.el('memo-title');
        if (t && !e.focused) { t.focus(); e.focused = true; }
    }

    _bind() {
        const body = this.el('memo-body');
        if (!body) return;
        this.el('memo-new').addEventListener('click', () => { this.editing = { title: '', kind: 'memo', body: '' }; this._render(); });
        this.el('memo-search').addEventListener('input', e => { this.query = e.target.value.trim().toLowerCase(); this._render(); });
        this.el('memo-editor').addEventListener('change', e => {
            if (e.target.name === 'memo-kind' && this.editing) {
                this._syncEditor();
                this.editing.kind = e.target.value;
                this._renderEditor();
            }
        });
        this.el('memo-editor').addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            if (b.dataset.act === 'memo-cancel-edit') { this.editing = null; this._render(); return; }
            if (b.dataset.act === 'memo-save') this._save();
        });
        this.el('memo-editor').addEventListener('keydown', e => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); this._save(); }
        });
        body.addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            const item = e.target.closest('.memo-item');
            if (!b || !item) return;
            const m = this.memos.find(x => x.id === item.dataset.id);
            if (!m) return;
            const act = b.dataset.act;
            if (act === 'memo-cancel') { this.confirm = null; this._render(); return; }
            if (act === 'memo-delete') { this.confirm = { id: m.id, action: 'delete' }; this._render(); return; }
            if (act === 'memo-delete-yes') { this.confirm = null; this._delete(m.id); return; }
            if (act === 'memo-edit') {
                this.editing = { id: m.id, title: m.title, kind: m.kind, body: m.kind === 'secret' ? (this.revealed.get(m.id) ?? null) : m.body };
                this._render();
                return;
            }
            if (act === 'memo-reveal') {
                if (this.revealed.has(m.id)) { this.revealed.delete(m.id); this._render(); }
                else this._withText(m, 'reveal');
                return;
            }
            if (act === 'memo-copy') { this._withText(m, 'copy'); return; }
            if (act === 'memo-insert') {
                if (m.kind === 'secret') { this.confirm = { id: m.id, action: 'insert' }; this._render(); return; }
                this._withText(m, 'insert');
                return;
            }
            if (act === 'memo-insert-yes') { this.confirm = null; this._withText(m, 'insert'); this._render(); }
        });
    }

    _syncEditor() {
        if (!this.editing) return;
        const t = this.el('memo-title'), x = this.el('memo-text');
        if (t) this.editing.title = t.value;
        if (x) {
            const secretKeep = this.editing.id && this.editing.kind === 'secret' && this.editing.body == null && !x.value;
            this.editing.body = secretKeep ? null : x.value;
        }
    }

    _save() {
        this._syncEditor();
        const e = this.editing;
        if (!e) return;
        const memo = { id: e.id || null, title: e.title, kind: e.kind, body: e.body };
        if (this.ipc) { this.ipc.send('memos:save', memo); return; }
        // 미리보기
        if (!memo.title.trim()) { this.hub.map._toast('제목을 써 주세요'); return; }
        const now = Date.now();
        let m = memo.id && this.previewMemos.find(x => x.id === memo.id);
        if (!m) { m = { id: 'p' + now }; this.previewMemos.push(m); }
        Object.assign(m, { title: memo.title.trim(), kind: memo.kind, updatedAt: now });
        if (memo.body != null) m.body = memo.body;
        this.revealed.delete(m.id);
        this._onResult({ ok: true, saved: { id: m.id }, canEncrypt: true, memos: this._previewList() });
    }

    _delete(id) {
        if (this.ipc) { this.ipc.send('memos:delete', { id }); return; }
        this.previewMemos = this.previewMemos.filter(m => m.id !== id);
        this._onResult({ ok: true, deleted: { id }, canEncrypt: true, memos: this._previewList() });
    }

    // 본문이 필요한 일: 비밀 메모는 그때그때 꺼낸다
    _withText(m, purpose) {
        if (m.kind !== 'secret') { this._use(m.body || '', purpose, m.id); return; }
        if (this.revealed.has(m.id)) { this._use(this.revealed.get(m.id), purpose, m.id); return; }
        if (this.ipc) { this.ipc.send('memos:reveal', { id: m.id, purpose }); return; }
        const pm = this.previewMemos.find(x => x.id === m.id);
        this._onReveal({ ok: true, id: m.id, purpose, body: pm ? pm.body : '' });
    }

    _onReveal(r) {
        if (!r) return;
        if (!r.ok) { this.hub.map._toast(r.error || '비밀 메모를 열지 못했어요'); return; }
        if (r.purpose === 'reveal') { this.revealed.set(r.id, r.body); this._render(); return; }
        this._use(r.body, r.purpose, r.id);
    }

    _use(text, purpose) {
        if (purpose === 'insert') { this.hub.insertText(text); return; }
        if (purpose === 'copy') HubMemos.copy(text).then(ok => this.hub.map._toast(ok ? '복사했어요' : '복사하지 못했어요'));
    }

    static async copy(text) {
        try {
            if (typeof require === 'function') {
                const { clipboard } = require('electron');
                if (clipboard) { clipboard.writeText(text); return true; }
            }
        } catch {
            // 브라우저(미리보기)에서는 아래로
        }
        try { await navigator.clipboard.writeText(text); return true; } catch { return false; }
    }
}

if (typeof window !== 'undefined') {
    window.HubFinder = HubFinder;
    window.HubMemos = HubMemos;
    window.MINDMAP_PATHS = MINDMAP_PATHS;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { HubFinder, HubMemos, MINDMAP_PATHS };

/**
 * GitHub 탭: 고른 세션(또는 폴더)의 저장소 상태, 커밋·푸시·가져오기·브랜치, PR·이슈·체크,
 * 그리고 "Claude에게 맡기기" (입력창에 할 일을 넣어 준다).
 */
class HubGitHub {
    constructor(hub) {
        this.hub = hub;
        this.ipc = hub.ipc;
        this.el = id => document.getElementById(id);
        this.info = null;
        this.cwd = null;
        this.diff = null;
        this.lists = {};          // prs / issues / checks → { items, error, note, loading }
        this.confirm = null;      // 'push' | 'pr'
        this.busy = null;         // 진행 중인 작업 이름
        this._bind();
        if (this.ipc) {
            this.ipc.on('git:info-result', (e, r) => this._onInfo(r));
            this.ipc.on('git:diff-result', (e, r) => { if (r.ok) { this.diff = r; this._render(); } else this.hub.map._toast(r.error); });
            this.ipc.on('git:action-result', (e, r) => this._onAction(r));
            this.ipc.on('gh:list-result', (e, r) => { if (!this.info || r.root !== this.info.root) return; this.lists[r.what] = r.ok ? r : { error: r.error }; this._render(); });
        }
    }

    // 고른 세션의 폴더 (없으면 고른 폴더)
    _targetCwd() {
        const s = this.hub._selSession();
        return s ? s.cwd : this.hub.sel && this.hub.sel.root || null;
    }

    show() {
        const cwd = this._targetCwd();
        if (!cwd) { this.info = null; this._render(); return; }
        if (cwd !== this.cwd || !this.info) this.load(cwd);
        else this._render();
    }

    load(cwd) {
        this.cwd = cwd || this.cwd;
        this.diff = null;
        this.lists = {};
        this.confirm = null;
        if (!this.ipc) { this.info = { cwd: this.cwd, isRepo: false, preview: true }; this._render(); return; }
        this.loading = true;
        this._render();
        this.ipc.send('git:info', { cwd: this.cwd });
    }

    _onInfo(r) {
        if (r.cwd !== this.cwd) return;
        this.loading = false;
        this.info = r.ok ? r : { cwd: r.cwd, error: r.error };
        this._render();
        if (this.info.isRepo && this.info.web) for (const what of ['prs', 'checks']) this._list(what);
    }

    _list(what) {
        if (!this.ipc || !this.info || !this.info.root) return;
        this.lists[what] = { loading: true };
        this.ipc.send('gh:list', { root: this.info.root, what });
    }

    _onAction(r) {
        this.busy = null;
        if (!r.ok) { this.hub.map._toast(r.error.split('\n')[0]); this._lastError = r.error; this._render(); return; }
        this._lastError = null;
        const done = { pull: '가져왔어요', commit: '커밋했어요', push: '푸시했어요', branch: '새 브랜치로 옮겼어요', 'pr-create': 'PR 을 만들었어요' }[r.action] || '했어요';
        this.hub.map._toast(done);
        if (r.action === 'commit') { const m = this.el('gh-message'); if (m) m.value = ''; }
        this.load(this.cwd);
    }

    _act(action, extra = {}) {
        if (!this.ipc || !this.info || !this.info.root) return;
        this.busy = action;
        this.confirm = null;
        this._render();
        this.ipc.send('git:action', { root: this.info.root, action, ...extra });
    }

    _render() {
        const box = this.el('gh-body');
        if (!box) return;
        const esc = SessionMindMap._esc;
        const i = this.info;
        const head = this.el('gh-repo');
        if (!this._targetCwd() && !i) { head.textContent = ''; box.innerHTML = '<p class="hub-empty">세션이나 폴더를 고르면 그 저장소를 보여 줘요</p>'; return; }
        if (this.loading || !i) { box.innerHTML = '<p class="hub-empty">저장소 읽는 중…</p>'; return; }
        if (i.preview) { head.textContent = ''; box.innerHTML = '<p class="hub-empty">미리보기에서는 git 을 실행할 수 없어요 (맥 앱에서 돼요)</p>'; return; }
        if (i.error) { box.innerHTML = `<p class="hub-empty">${esc(i.error)}</p>`; return; }
        if (!i.isRepo) { head.textContent = i.cwd; box.innerHTML = '<p class="hub-empty">git 저장소가 아니에요</p>'; return; }

        const name = i.web ? i.web.replace('https://github.com/', '') : i.root.split('/').pop();
        head.innerHTML = `<b>${esc(name)}</b>`;
        const sync = [i.ahead ? `↑${i.ahead}` : '', i.behind ? `↓${i.behind}` : ''].filter(Boolean).join(' ');
        const busy = a => this.busy === a ? ' disabled' : '';
        const list = (what, render, empty) => {
            const l = this.lists[what];
            if (!i.web) return '<p class="hub-muted">GitHub 저장소가 아니에요 (origin 이 github.com 이 아님)</p>';
            if (!l || l.loading) return '<p class="hub-muted">불러오는 중…</p>';
            if (l.error) return `<p class="hub-muted">${esc(l.error)}</p>`;
            if (!l.items.length) return `<p class="hub-muted">${esc(l.note || empty)}</p>`;
            return `<ul class="gh-list">${l.items.map(render).join('')}</ul>`;
        };
        const changes = i.changes.length
            ? `<ul class="gh-list">${i.changes.map(c => `<li class="gh-change${this.diff && this.diff.file === c.path ? ' is-on' : ''}" data-file="${esc(c.path)}">
                <span class="gh-badge gh-${c.xy === '??' ? 'new' : c.xy.trim()[0]}">${esc(c.label)}</span><button class="hub-link gh-file" data-act="gh-diff">${esc(c.path)}</button>
                <button class="hub-link" data-act="gh-attach" title="대화창에 첨부">첨부</button></li>`).join('')}</ul>`
            : '<p class="hub-muted">바뀐 파일이 없어요</p>';
        const diff = this.diff ? `<div class="gh-diff-head"><b>${esc(this.diff.file || '전체')}</b><button class="hub-link" data-act="gh-diff-close">닫기</button></div>
            <pre class="gh-diff">${HubGitHub.diffHtml(this.diff.diff)}</pre>` : '';

        box.innerHTML = `
          <div class="gh-status"><span class="hub-pill">⎇ ${esc(i.branch || '?')}</span>${sync ? `<span class="hub-pill">${sync}</span>` : ''}
            ${i.upstream ? `<span class="hub-muted">${esc(i.upstream)}</span>` : '<span class="hub-muted">원격 브랜치 없음</span>'}</div>
          <div class="gh-actions">
            <button class="btn" data-act="gh-pull"${busy('pull')}>가져오기</button>
            <button class="btn" data-act="gh-push-ask"${busy('push')}>푸시</button>
            ${i.web ? '<button class="btn" data-act="gh-pr-ask">PR 만들기</button>' : ''}
            ${i.web ? `<button class="hub-link" data-act="gh-web" data-url="${esc(i.web)}">GitHub 에서 열기</button>` : ''}
          </div>
          ${this.confirm === 'push' ? `<div class="hub-confirm"><p><b>${esc(i.branch)}</b> 를 origin 에 푸시해요.</p><div class="row"><button class="btn btn-primary" data-act="gh-push">푸시</button><button class="btn" data-act="gh-cancel">취소</button></div></div>` : ''}
          ${this.confirm === 'pr' ? `<div class="hub-confirm"><p><b>${esc(i.branch)}</b> 로 draft PR 을 만들어요. 제목과 본문은 커밋에서 채워요.</p><div class="row"><button class="btn btn-primary" data-act="gh-pr">만들기</button><button class="btn" data-act="gh-cancel">취소</button></div></div>` : ''}
          ${this.busy ? `<p class="hub-muted">${esc(this.busy)} 하는 중…</p>` : ''}
          ${this._lastError ? `<pre class="hub-err">${esc(this._lastError.slice(0, 1500))}</pre>` : ''}

          <h3 class="gh-h">바뀐 파일 ${i.changes.length}</h3>${changes}${diff}
          ${i.changes.length ? `<div class="gh-commit"><textarea id="gh-message" rows="2" placeholder="커밋 메시지"></textarea>
            <button class="btn btn-primary" data-act="gh-commit"${busy('commit')}>모두 커밋</button></div>` : ''}

          <h3 class="gh-h">Claude 에게 맡기기</h3>
          <div class="gh-ask">${HubGitHub.ASKS.map((a, k) => `<button class="btn" data-act="gh-ask" data-k="${k}">${esc(a.label)}</button>`).join('')}</div>
          <p class="hub-muted">누르면 대화창에 할 일이 들어가요. 확인하고 보내면 고른 세션이 처리해요.</p>

          <h3 class="gh-h">열린 PR <button class="hub-link" data-act="gh-reload" data-what="prs">새로고침</button></h3>
          ${list('prs', p => `<li><button class="hub-link" data-act="gh-web" data-url="${esc(p.url)}">#${p.number}</button> ${esc(p.title)}
              ${p.isDraft ? '<span class="gh-badge">draft</span>' : ''}<div class="hub-muted">${esc(p.headRefName || '')}${p.author ? ` · ${esc(p.author)}` : ''}</div></li>`, '열린 PR 이 없어요')}
          <h3 class="gh-h">이 브랜치 체크 <button class="hub-link" data-act="gh-reload" data-what="checks">새로고침</button></h3>
          ${list('checks', c => `<li><span class="gh-check gh-${String(c.state).toLowerCase()}">${esc(c.state)}</span> ${c.link ? `<button class="hub-link" data-act="gh-web" data-url="${esc(c.link)}">${esc(c.name)}</button>` : esc(c.name)}</li>`, '체크가 없어요')}
          <h3 class="gh-h">열린 이슈 <button class="hub-link" data-act="gh-reload" data-what="issues">불러오기</button></h3>
          ${this.lists.issues ? list('issues', x => `<li><button class="hub-link" data-act="gh-web" data-url="${esc(x.url)}">#${x.number}</button> ${esc(x.title)}</li>`, '열린 이슈가 없어요') : ''}
          <h3 class="gh-h">최근 커밋</h3>
          <ul class="gh-list gh-log">${i.log.map(c => `<li><code>${esc(c.sha)}</code> ${esc(c.subject)}<div class="hub-muted">${esc(c.author)} · ${SessionMindMap._fmt(Date.parse(c.date))}</div></li>`).join('')}</ul>`;
    }

    _bind() {
        const box = this.el('gh-body');
        if (!box) return;
        this.el('gh-refresh').addEventListener('click', () => this.load(this._targetCwd() || this.cwd));
        box.addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            const act = b.dataset.act;
            const li = b.closest('[data-file]');
            if (act === 'gh-diff' && li) { this.ipc && this.ipc.send('git:diff', { root: this.info.root, file: li.dataset.file }); return; }
            if (act === 'gh-diff-close') { this.diff = null; this._render(); return; }
            if (act === 'gh-attach' && li) { this.hub.addAttachments([this.info.root + '/' + li.dataset.file.replace(/\/$/, '')]); return; }
            if (act === 'gh-pull') return this._act('pull');
            if (act === 'gh-push-ask') { this.confirm = 'push'; this._render(); return; }
            if (act === 'gh-pr-ask') { this.confirm = 'pr'; this._render(); return; }
            if (act === 'gh-cancel') { this.confirm = null; this._render(); return; }
            if (act === 'gh-push') return this._act('push');
            if (act === 'gh-pr') return this._act('pr-create');
            if (act === 'gh-commit') {
                const msg = (this.el('gh-message') || {}).value || '';
                if (!msg.trim()) { this.hub.map._toast('커밋 메시지를 써 주세요'); return; }
                return this._act('commit', { message: msg, all: true });
            }
            if (act === 'gh-reload') return this._list(b.dataset.what);
            if (act === 'gh-web') { HubGitHub.openUrl(this.hub, b.dataset.url); return; }
            if (act === 'gh-ask') {
                const a = HubGitHub.ASKS[+b.dataset.k];
                if (!this.hub._selSession() && this.info && this.info.root) this.hub.newSessionIn(this.info.root);
                this.hub.insertText(a.text(this.info));
            }
        });
    }

    // 링크: 브라우저 탭이 있으면 거기로(진짜 크롬·사파리), 없으면 기본 브라우저
    static openUrl(hub, url) {
        if (hub.browser) hub.browser.openUrl(url);
        else if (hub.ipc) hub.ipc.send('open-external', { url });
        else window.open(url, '_blank', 'noopener');
    }

    static diffHtml(text) {
        const esc = SessionMindMap._esc;
        return String(text || '(차이 없음)').split('\n').map(l => {
            const cls = l.startsWith('+') && !l.startsWith('+++') ? 'add' : l.startsWith('-') && !l.startsWith('---') ? 'del' : l.startsWith('@@') ? 'hunk' : '';
            return cls ? `<span class="d-${cls}">${esc(l)}</span>` : esc(l);
        }).join('\n');
    }
}

HubGitHub.ASKS = [
    { label: '정리해서 커밋·푸시', text: i => `지금 바뀐 파일을 살펴보고 의미 단위로 나눠 커밋한 다음 ${i && i.branch ? i.branch : '현재 브랜치'} 를 푸시해줘. 비밀키나 큰 파일은 커밋하지 마.` },
    { label: 'draft PR 만들기', text: i => `${i && i.branch ? i.branch : '현재 브랜치'} 로 draft PR 을 만들어줘. 변경 내용을 요약해서 본문을 써줘.` },
    { label: 'PR 리뷰 코멘트 처리', text: () => '이 브랜치 PR 의 리뷰 코멘트를 확인하고, 고칠 건 고쳐서 푸시하고 답글을 달아줘.' },
    { label: 'CI 실패 고치기', text: () => '이 브랜치 PR 의 CI 체크 중 실패한 걸 찾아서 원인을 고치고 푸시해줘.' },
    { label: 'main 따라잡기', text: () => 'main 브랜치의 새 커밋을 이 브랜치에 merge 하고 충돌이 있으면 풀어줘. force push 는 하지 마.' }
];

if (typeof window !== 'undefined') window.HubGitHub = HubGitHub;
if (typeof module !== 'undefined' && module.exports) module.exports.HubGitHub = HubGitHub;

/**
 * 브라우저 탭: 맥의 진짜 크롬·사파리·Brave·Edge 를 조종한다 (앱 안 브라우저가 아님).
 * 주소창(주소면 열고 아니면 검색), 탭 목록·옮기기, 앞 탭 읽기 → 대화창에 넣기, 뒤로·앞으로·새로고침,
 * 그리고 "Claude 에 연결": MCP 서버로 등록해 모든 Claude 세션이 browser_* 도구로 같은 브라우저를 조종한다.
 */
class HubBrowser {
    constructor(hub) {
        this.hub = hub;
        this.ipc = hub.ipc;
        this.el = id => document.getElementById(id);
        this.settings = { browser: 'chrome', engine: 'google' };
        this.tabs = null;
        this.page = null;
        this.error = null;
        this.loaded = false;
        this._bind();
        if (this.ipc) {
            this.ipc.on('browser:settings', (e, r) => { this.settings = { ...this.settings, ...r }; this._render(); });
            this.ipc.on('browser:result', (e, r) => this._onResult(r));
            this.ipc.on('browser:register-result', (e, r) => {
                this.registering = false;
                if (r.ok) { this.settings.mcp = true; this.hub.map._toast('Claude 에 연결했어요. 새로 여는 세션부터 browser_* 도구를 써요'); }
                else this.hub.map._toast('연결하지 못했어요: ' + String(r.error).split('\n')[0]);
                this._render();
            });
        }
    }

    show() {
        if (!this.loaded && this.ipc) { this.loaded = true; this.ipc.send('browser:get'); this.refreshTabs(); }
        this._render();
    }

    _do(op, args) {
        if (!this.ipc) { this.hub.map._toast('미리보기에서는 브라우저를 조종할 수 없어요 (맥 앱에서 돼요)'); return; }
        this.busy = op;
        this._render();
        this.ipc.send('browser:do', { op, args });
    }

    refreshTabs() { this._do('tabs'); }

    // 다른 탭(GitHub 등)의 링크: 고른 브라우저로, 안 되면 기본 브라우저로
    openUrl(url) {
        if (!this.ipc) { window.open(url, '_blank', 'noopener'); return; }
        this._fallbackUrl = url;
        this._do('open', { url, newTab: true });
    }

    go(text) {
        const t = String(text || '').trim();
        if (!t) return;
        if (HubBrowser.looksLikeUrl(t)) this._do('open', { url: t, newTab: true });
        else this._do('search', { query: t, engine: this.settings.engine });
    }

    /**
     * 세션에 페이지를 읽히는 메시지: 전문(최대 2만 자)을 한 번 보내고, 요약은 세션이 툰 형식으로 한다.
     * 세션이 요약을 들고 있으니 다음부터는 요약만 쓰고, 전문은 다시 보내지 않는다.
     */
    static readPrompt(page, maxChars = 20000) {
        const text = String(page.text || '');
        const body = text.length > maxChars ? text.slice(0, maxChars) + '\n…(뒤는 잘렸어요)' : text;
        return `아래 웹 페이지를 읽고 핵심을 툰 형식으로 짧게 요약해 둬 (제목·주소·요점·숫자·할 일). 앞으로는 이 요약을 기준으로 이야기하자.\n\n[페이지] ${page.title}\n${page.url}\n\n${body}`;
    }

    static looksLikeUrl(s) {
        return /^(https?|file):/i.test(s) || /^[\w-]+(\.[\w-]+)+(:\d+)?(\/\S*)?$/.test(s) || /^localhost(:\d+)?(\/\S*)?$/.test(s);
    }

    _onResult(r) {
        this.busy = null;
        if (!r.ok && r.op === 'open' && this._fallbackUrl) {
            this.ipc.send('open-external', { url: this._fallbackUrl });
            this._fallbackUrl = null;
        }
        if (r.op === 'open') this._fallbackUrl = null;
        if (!r.ok) {
            this.error = r.error;
            if (r.op !== 'tabs') this.hub.map._toast(r.error);
            this._render();
            return;
        }
        this.error = null;
        if (r.op === 'tabs') this.tabs = r.data;
        else if (r.op === 'read') this.page = r.data;
        if (['open', 'search', 'activate', 'navigate'].includes(r.op)) setTimeout(() => this.refreshTabs(), 700);
        this._render();
    }

    _render() {
        const box = this.el('br-body');
        if (!box) return;
        const esc = SessionMindMap._esc;
        const sel = this.el('br-browser'), eng = this.el('br-engine');
        if (sel && sel.value !== this.settings.browser) sel.value = this.settings.browser;
        if (eng && eng.value !== this.settings.engine) eng.value = this.settings.engine;
        if (!this.ipc) {
            box.innerHTML = '<p class="hub-empty">맥 앱에서는 여기서 진짜 크롬·사파리의 탭을 보고, 열고, 읽고, Claude 가 조종하게 할 수 있어요.</p>';
            return;
        }
        const tabs = this.tabs;
        const list = !tabs ? '<p class="hub-muted">탭 읽는 중…</p>'
            : !tabs.length ? '<p class="hub-muted">열린 탭이 없어요</p>'
            : `<ul class="br-tabs">${tabs.map(t => `<li class="${t.active ? 'is-on' : ''}"><button class="br-tab" data-act="br-activate" data-w="${t.window}" data-t="${t.tab}" title="${esc(t.url)}">
                <span class="br-title">${t.active ? '▶ ' : ''}${esc(t.title || t.url)}</span><span class="br-url">${esc(t.url)}</span></button></li>`).join('')}</ul>`;
        const page = this.page ? `<div class="br-page"><div class="br-page-head"><b>${esc(this.page.title)}</b><button class="hub-link" data-act="br-page-close">닫기</button></div>
            <div class="br-url">${esc(this.page.url)}</div>
            <pre class="br-text">${esc(this.page.text.slice(0, 3000))}${this.page.text.length > 3000 || this.page.truncated ? '\n…' : ''}</pre>
            <div class="row"><button class="btn btn-primary" data-act="br-session-read" title="지금 세션에 이 페이지를 보내고 툰 형식으로 요약하게 해요">세션에서 읽고 툰 요약</button>
              <button class="btn" data-act="br-insert-page">대화창에 넣기</button><button class="btn" data-act="br-insert-url">주소만 넣기</button></div></div>` : '';
        const mcp = this.settings.mcp
            ? '<p class="br-mcp is-on">● Claude 에 연결됨 — 세션에서 "크롬에서 ○○ 찾아줘"처럼 시키면 browser_* 도구로 이 브라우저를 조종해요.</p>'
            : `<div class="br-mcp"><p>Claude 세션이 이 브라우저를 직접 조종하게 하려면 연결하세요 (MCP 서버 등록, 한 번만).</p>
                <button class="btn btn-primary" data-act="br-register"${this.registering ? ' disabled' : ''}>${this.registering ? '연결하는 중…' : 'Claude 에 연결'}</button></div>`;
        box.innerHTML = `
          <div class="row br-nav"><button class="btn" data-act="br-nav" data-a="back" title="뒤로">←</button><button class="btn" data-act="br-nav" data-a="forward" title="앞으로">→</button>
            <button class="btn" data-act="br-nav" data-a="reload" title="새로고침">↻</button><button class="btn" data-act="br-read" title="앞 탭의 글 읽기">읽기</button>
            <button class="btn" data-act="br-tabs">탭 새로고침</button></div>
          ${this.busy ? `<p class="hub-muted">${esc(this.busy)} 하는 중…</p>` : ''}
          ${this.error ? `<p class="br-error">${esc(this.error)}</p>` : ''}
          ${page}
          <h3 class="gh-h">열린 탭 ${tabs ? tabs.length : ''}</h3>${list}
          <h3 class="gh-h">Claude 조종</h3>${mcp}
          <details class="br-help"><summary>처음 한 번 켜 둘 것</summary>
            <ul><li>크롬·Brave·Edge: 보기 &gt; 개발자 정보 &gt; <b>Apple Events의 자바스크립트 허용</b> (읽기·누르기·입력에 필요)</li>
            <li>사파리: 설정 &gt; 고급 &gt; 개발자용 메뉴 보기 → 개발자용 &gt; <b>Apple Events의 JavaScript 허용</b></li>
            <li>처음 조종할 때 맥이 "제어하려고 합니다"를 물으면 <b>허용</b></li></ul></details>`;
    }

    _bind() {
        const box = this.el('br-body');
        if (!box) return;
        const send = () => { this.go(this.el('br-address').value); };
        this.el('br-go').addEventListener('click', send);
        this.el('br-address').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); send(); } });
        this.el('br-browser').addEventListener('change', e => { this.settings.browser = e.target.value; this.tabs = null; this.ipc && this.ipc.send('browser:set', { browser: e.target.value }); this.refreshTabs(); });
        this.el('br-engine').addEventListener('change', e => { this.settings.engine = e.target.value; this.ipc && this.ipc.send('browser:set', { engine: e.target.value }); });
        box.addEventListener('click', e => {
            const b = e.target.closest('[data-act]');
            if (!b) return;
            const act = b.dataset.act;
            if (act === 'br-activate') return this._do('activate', { window: +b.dataset.w, tab: +b.dataset.t });
            if (act === 'br-nav') return this._do('navigate', { action: b.dataset.a });
            if (act === 'br-read') return this._do('read');
            if (act === 'br-tabs') return this.refreshTabs();
            if (act === 'br-page-close') { this.page = null; this._render(); return; }
            if (act === 'br-insert-page' && this.page) { this.hub.insertText(`[브라우저 페이지] ${this.page.title}\n${this.page.url}\n\n${this.page.text.slice(0, 8000)}\n`); return; }
            if (act === 'br-insert-url' && this.page) { this.hub.insertText(this.page.url); return; }
            if (act === 'br-session-read' && this.page) { this.hub.sendNow(HubBrowser.readPrompt(this.page)); return; }
            if (act === 'br-register' && this.ipc) { this.registering = true; this._render(); this.ipc.send('browser:register'); }
        });
    }
}

if (typeof window !== 'undefined') window.HubBrowser = HubBrowser;
if (typeof module !== 'undefined' && module.exports) module.exports.HubBrowser = HubBrowser;
