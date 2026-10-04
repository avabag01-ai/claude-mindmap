/**
 * 클로드 데스크톱 앱 코드 탭의 사이드바 구조를 읽는다. Rust 쪽은 src-tauri/src/claude_app.rs.
 * 새로 만든 세션은 앱의 가져오기 링크로 넣는다 (importSession) — 파일은 직접 쓰지 않는다
 * 돌려주는 모양: { ok, groups: [{ id, name }], sessions: { <cliSessionId>: { appId, title, group, archived, createdAt, pinned, adopted } } }
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
            pinned: pinned.some(p => p === r.sessionId || p.endsWith(r.sessionId)),
            adopted: r.adoptedFromOtherSurface === true // 마인드맵·터미널에서 만들어 앱에 들여온 세션
        };
    }
    return { ok: true, groups: groups.map(({ id, name }) => ({ id, name })), sessions };
}

/**
 * 제목: 첫 메시지에서 내용을 알 수 있는 부분, max 자까지.
 * 마인드맵이 띄운 "툰 불러와 — 하위 세션, root: …, hub_task: NEXT 000005 할 일" 은 다 같아 보이니 할 일만 쓴다.
 */
function titleFrom(text = '', max = 40) {
    text = String(text);
    const i = text.indexOf('hub_task:');
    const body = i >= 0 ? text.slice(i + 'hub_task:'.length).trimStart().replace(/^NEXT\s*\d*/, '') : text;
    const line = body.split('\n').map(l => l.trim()).find(Boolean) || '';
    const chars = [...line];
    return chars.length > max ? chars.slice(0, max).join('') + '…' : line;
}

/**
 * 마인드맵에서 새로 만든 세션을 클로드 앱에 넣는다: 앱의 가져오기 링크(claude://resume)를 뒤에서 연다.
 * 켜져 있는 앱이 바로 사이드바에 넣고 자기 기록(local_*.json)도 만든다.
 */
function importSession(cliId) {
    if (!/^[0-9a-f-]+$/i.test(cliId || '')) return false;
    require('child_process').execFile('open', ['-g', `claude://resume?session=${cliId}`], () => {});
    return true;
}

/** 클로드 앱 안에서 새 코드 세션: 폴더와 첫 메시지만 채운다 (보내기는 사람이). 그룹 넣기 도구를 쓸 수 있는 앱 안 세션이 된다 */
function newSessionUrl(folder, prompt) {
    const enc = t => Array.from(Buffer.from(String(t), 'utf8')).map(b => /[A-Za-z0-9\-_.~]/.test(String.fromCharCode(b)) ? String.fromCharCode(b) : '%' + b.toString(16).toUpperCase().padStart(2, '0')).join('');
    return `claude://code/new?folder=${enc(folder)}&q=${enc([...String(prompt)].slice(0, 14000).join(''))}`;
}

function newInApp(folder, prompt) {
    if (!folder || !fs.existsSync(folder)) return false;
    require('child_process').execFile('open', [newSessionUrl(folder, prompt)], () => {});
    return true;
}

const validAppId = id => /^local_[A-Za-z0-9-]{1,64}$/.test(id || '');
const continueUrl = appId => `claude://code/continue?session=${appId}`;

/** 마인드맵에서 고른 앱 세션으로 클로드 앱 화면을 바꾼다 (Electron 판: 링크만, 앞으로 돌리기·보내기는 Tauri 판 claude_app_ax.rs) */
function focus(appId) {
    if (!validAppId(appId)) return false;
    require('child_process').execFile('open', ['-g', continueUrl(appId)], () => {});
    return true;
}

/** 클로드 앱 세션에 보낼 글: 클립보드에 넣고 그 세션을 앱 앞으로 연다 (붙여넣고 Enter 는 사람이). appId 가 있으면 앱 세션 링크 */
function handOff(cliId, text, appId) {
    const url = validAppId(appId) ? continueUrl(appId) : /^[0-9a-f-]+$/i.test(cliId || '') ? `claude://resume?session=${cliId}` : null;
    if (!url) return false;
    try { require('child_process').execFileSync('pbcopy', { input: String(text) }); } catch { return false; }
    require('child_process').execFile('open', [url], () => {});
    return true;
}

// 마인드맵에서 돌린 세션을 클로드 앱에도 보이게 (가져오기 링크)
const showInApp = importSession;

module.exports = { read, importSession, showInApp, titleFrom, appDirPath, newSessionUrl, newInApp, handOff, focus, continueUrl, validAppId };
