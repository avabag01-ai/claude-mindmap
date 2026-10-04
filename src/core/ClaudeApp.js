/**
 * 클로드 데스크톱 앱 코드 탭의 사이드바 구조를 읽기만 한다 (쓰지 않음). Rust 쪽은 src-tauri/src/claude_app.rs.
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

module.exports = { read, appDirPath };
