/**
 * 허용 묻기 (Electron 판, Rust 는 src-tauri/src/approvals.rs)
 * scripts/mindmap-approve-mcp.js 가 ~/.claude-mindmap/approvals/<id>.req.json 에 물음을 쓰면
 * 화면이 'approval:list' 로 읽어 허용 / 거절 창을 띄우고, 'approval:answer' 로 <id>.ans.json 을 쓴다.
 * "이 폴더에서 항상 허용" 은 클로드 앱·터미널 claude 와 같은 자리(<폴더>/.claude/settings.local.json)에 규칙으로 남긴다.
 */
const fs = require('fs');
const path = require('path');
const { settingsFile } = require('./appDir.js');

const STALE_MS = 11 * 60 * 1000; // 묻는 쪽은 10분 기다림
const dir = () => settingsFile('approvals');

function ruleFor(tool, input) {
    return tool === 'Bash' && input && typeof input.command === 'string' ? `Bash(${input.command})` : String(tool || '');
}

function list(d = dir()) {
    let names = [];
    try { names = fs.readdirSync(d).filter(n => n.endsWith('.req.json')); } catch { return []; }
    const out = [];
    for (const n of names) {
        let v;
        try { v = JSON.parse(fs.readFileSync(path.join(d, n), 'utf8')); } catch { continue; }
        if (!v || !v.id || Date.now() - (v.at || 0) >= STALE_MS) continue;
        if (fs.existsSync(path.join(d, v.id + '.ans.json'))) continue;
        out.push({ ...v, rule: ruleFor(v.tool, v.input) });
    }
    return out.sort((a, b) => a.at - b.at);
}

function addRule(cwd, rule) {
    const file = path.join(cwd, '.claude', 'settings.local.json');
    let v = {};
    try { v = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* 없음 */ }
    if (!v || typeof v !== 'object' || Array.isArray(v)) throw new Error(`${file} 가 JSON 객체가 아니에요`);
    if (!v.permissions || typeof v.permissions !== 'object') v.permissions = {};
    if (!Array.isArray(v.permissions.allow)) v.permissions.allow = [];
    if (!v.permissions.allow.includes(rule)) v.permissions.allow.push(rule);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(v, null, 2) + '\n');
}

function answer(id, allow, always, d = dir()) {
    if (!/^[0-9a-fA-F-]{1,64}$/.test(id || '')) throw new Error('물음 번호가 올바르지 않아요');
    let req;
    try { req = JSON.parse(fs.readFileSync(path.join(d, id + '.req.json'), 'utf8')); } catch { throw new Error('이미 끝난 물음이에요'); }
    let rule = null;
    if (allow && always && req.cwd) { rule = ruleFor(req.tool, req.input); addRule(req.cwd, rule); }
    const ans = path.join(d, id + '.ans.json');
    fs.writeFileSync(ans + '.tmp', JSON.stringify(allow ? { allow: true } : { allow: false, message: '사용자가 마인드맵에서 거절했어요' }));
    fs.renameSync(ans + '.tmp', ans);
    return { id, allow: !!allow, rule };
}

module.exports = { list, answer, addRule, ruleFor, dir };
