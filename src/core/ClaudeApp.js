/**
 * 클로드 데스크톱 앱 코드 탭의 사이드바 구조를 읽는다. Rust 쪽은 src-tauri/src/claude_app.rs.
 * 쓰는 것은 하나: 마인드맵에서 새로 만든 세션의 기록(local_<uuid>.json)을 넣어 클로드 앱 사이드바에도 보이게 (register)
 * 돌려주는 모양: { ok, groups: [{ id, name }], sessions: { <cliSessionId>: { appId, title, group, archived, createdAt, pinned } } }
 */
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDirPath = () => process.env.MINDMAP_CLAUDE_APP_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Claude');

function readJson(p) {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; }
}

function firstScope(base) {
    try {
        const acct = fs.readdirSync(base, { withFileTypes: true }).find(e => e.isDirectory());
        const org = fs.readdirSync(path.join(base, acct.name), { withFileTypes: true }).find(e => e.isDirectory());
        return `${acct.name}/${org.name}`;
    } catch { return null; }
}

function read(dir = appDirPath()) {
    const cfg = readJson(path.join(dir, 'claude_desktop_config.json'));
    const prefs = (cfg && cfg.preferences && cfg.preferences.epitaxyPrefs) || {};
    const sections = prefs['dframe-code-sections'] || {};
    const scopes = prefs['dframe-group-scopes'] || {};
    const scope = Object.keys(sections)[0] || Object.keys(scopes)[0] || firstScope(path.join(dir, 'claude-code-sessions'));
    if (!scope) return { ok: false, groups: [], sessions: {} };

    const groups = ((sections[scope] && sections[scope].sections) || []).filter(s => s.kind === 'manual')
        .map(s => ({ order: s.order || 0, id: s.id, name: s.name || '' }));
    for (const g of (scopes[scope] && scopes[scope].groups) || []) {
        if (g.id && !groups.some(x => x.id === g.id)) groups.push({ order: Infinity, id: g.id, name: g.name || '' });
    }
    groups.sort((a, b) => a.order - b.order);
    const assignments = (scopes[scope] && scopes[scope].assignments) || {};
    const pinned = (prefs['starred-local-code-sessions'] || []).filter(x => typeof x === 'string');

    const sessions = {};
    let names = [];
    try { names = fs.readdirSync(path.join(dir, 'claude-code-sessions', scope)); } catch { /* 없음 */ }
    for (const n of names) {
        if (!n.startsWith('local_') || !n.endsWith('.json')) continue;
        const r = readJson(path.join(dir, 'claude-code-sessions', scope, n));
        if (!r || !r.sessionId || !r.cliSessionId) continue;
        sessions[r.cliSessionId] = {
            appId: r.sessionId, title: r.title === undefined ? null : r.title, group: assignments[`code:${r.sessionId}`] || null,
            archived: !!r.isArchived, createdAt: r.createdAt === undefined ? null : r.createdAt,
            pinned: pinned.some(p => p === r.sessionId || p.endsWith(r.sessionId))
        };
    }
    return { ok: true, groups: groups.map(({ id, name }) => ({ id, name })), sessions };
}

/** 제목: 첫 메시지 첫 줄, 40자까지 */
function titleFrom(text = '') {
    const line = String(text).split('\n').map(l => l.trim()).find(Boolean) || '';
    const chars = [...line];
    return chars.length > 40 ? chars.slice(0, 40).join('') + '…' : line;
}

/** 마인드맵에서 새로 만든 세션을 클로드 앱 기록에 넣는다. 이미 있으면 그대로 둔다. 클로드 앱은 켤 때 읽으므로 다시 켜야 보일 수 있다 */
function register(cliId, cwd, title, permissionMode = 'auto', dir = appDirPath(), now = Date.now()) {
    if (!cliId || !cwd) return { ok: false, error: '세션 id 나 폴더가 없어요' };
    const cfg = readJson(path.join(dir, 'claude_desktop_config.json'));
    const sections = (cfg && cfg.preferences && cfg.preferences.epitaxyPrefs && cfg.preferences.epitaxyPrefs['dframe-code-sections']) || {};
    const scope = Object.keys(sections)[0] || firstScope(path.join(dir, 'claude-code-sessions'));
    if (!scope) return { ok: false, error: '클로드 앱 기록 폴더가 없어요' };
    const found = read(dir).sessions[cliId];
    if (found) return { ok: true, existed: true, appId: found.appId };
    const appId = `local_${require('crypto').randomUUID()}`;
    const rec = { sessionId: appId, cliSessionId: cliId, cwd, originCwd: cwd, createdAt: now, lastActivityAt: now, isArchived: false, title, titleSource: 'manual', permissionMode };
    const recDir = path.join(dir, 'claude-code-sessions', scope);
    try {
        // 반쯤 쓴 파일을 앱이 읽지 않게 임시 파일에 쓰고 이름을 바꾼다
        fs.mkdirSync(recDir, { recursive: true });
        const tmp = path.join(recDir, `.${appId}.tmp`);
        fs.writeFileSync(tmp, JSON.stringify(rec));
        fs.renameSync(tmp, path.join(recDir, `${appId}.json`));
        return { ok: true, existed: false, appId };
    } catch (e) { return { ok: false, error: e.message }; }
}

module.exports = { read, register, titleFrom, appDirPath };
