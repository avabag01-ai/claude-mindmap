/**
 * MachineSync.js
 * =============================================================================
 * 세션이 맥북·맥미니 여러 대에 흩어져 있을 때, 서로의 세션 목록을 보게 한다 (메인 프로세스 전용)
 *
 * - 이 기기 이름: ~/.flowcode/machine.json 의 { "name": "Mac mini" } → 없으면 맥 모델 이름
 *   (system_profiler 의 Model Name: MacBook Pro → "MacBook", Mac mini → "Mac mini") → 없으면 호스트 이름
 * - 공유 폴더: FLOWCODE_SYNC_DIR → ~/.flowcode/sync.json 의 { "dir": … } → iCloud Drive/FlowCode (있으면)
 *   각 기기가 machines/<기기>.json 에 자기 세션 목록을 쓴다. 대화 내용은 넣지 않는다 (제목·폴더·시각·고친 파일·git 상태만).
 * - 다른 기기 세션은 읽기 전용으로 섞는다 (remote: true, machine: "MacBook"). 대화는 그 기기에서 연다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const FRESH_MS = 30 * 864e5; // 30일 넘게 소식 없는 기기는 빼기

class MachineSync {
    constructor(options = {}) {
        this.home = options.home || os.homedir();
        this.settingsDir = options.settingsDir || path.join(this.home, '.flowcode');
        this.platform = options.platform || process.platform;
        this.now = options.now || (() => Date.now());
        this._name = options.name || null;
        this._dir = options.dir !== undefined ? options.dir : undefined;
    }

    name() {
        if (this._name) return this._name;
        try {
            const d = JSON.parse(fs.readFileSync(path.join(this.settingsDir, 'machine.json'), 'utf8'));
            if (d.name) return (this._name = String(d.name));
        } catch { /* 설정 없음 */ }
        let model = '';
        if (this.platform === 'darwin') {
            try {
                const out = execFileSync('system_profiler', ['SPHardwareDataType'], { encoding: 'utf8', timeout: 8000 });
                const m = /Model Name:\s*(.+)/.exec(out);
                if (m) model = m[1].trim();
            } catch { /* 못 읽음 */ }
        }
        return (this._name = MachineSync.shortModel(model) || os.hostname().replace(/\.local$/, ''));
    }

    /** "MacBook Pro" → "MacBook", "Mac mini" → "Mac mini" … */
    static shortModel(model) {
        const m = String(model || '');
        if (/MacBook/i.test(m)) return 'MacBook';
        if (/Mac\s*mini/i.test(m)) return 'Mac mini';
        if (/Mac\s*Studio/i.test(m)) return 'Mac Studio';
        if (/iMac/i.test(m)) return 'iMac';
        if (/Mac\s*Pro/i.test(m)) return 'Mac Pro';
        return '';
    }

    dir() {
        if (this._dir !== undefined) return this._dir;
        if (process.env.FLOWCODE_SYNC_DIR) return (this._dir = process.env.FLOWCODE_SYNC_DIR);
        try {
            const d = JSON.parse(fs.readFileSync(path.join(this.settingsDir, 'sync.json'), 'utf8'));
            if (d.dir) return (this._dir = d.dir);
        } catch { /* 설정 없음 */ }
        const icloud = path.join(this.home, 'Library', 'Mobile Documents', 'com~apple~CloudDocs');
        return (this._dir = fs.existsSync(icloud) ? path.join(icloud, 'FlowCode') : null);
    }

    static fileName(machine) {
        return String(machine).replace(/[^\w가-힣 .-]/g, '_') + '.json';
    }

    /** 이 기기의 세션 목록을 공유 폴더에 쓴다 (대화 내용 없이) */
    publish(index) {
        const dir = this.dir();
        if (!dir) return { ok: false, reason: 'no-dir' };
        const machine = this.name();
        const snapshot = {
            version: 1, machine, generatedAt: index.generatedAt || this.now(),
            projects: index.projects.map(p => ({
                root: p.root, name: p.name, lastAt: p.lastAt,
                sessions: p.sessions.filter(s => !s.remote).map(s => ({
                    id: s.id, title: s.title, cwd: s.cwd, gitBranch: s.gitBranch, firstAt: s.firstAt, lastAt: s.lastAt,
                    costUSD: s.costUSD, parentId: s.parentId || null, git: s.git || null, context: s.context || null, kind: s.kind || null, topic: s.topic || null,
                    files: (s.files || []).map(f => ({ path: f.path, rel: f.rel, edits: f.edits }))
                }))
            })).filter(p => p.sessions.length)
        };
        const out = path.join(dir, 'machines');
        fs.mkdirSync(out, { recursive: true });
        const file = path.join(out, MachineSync.fileName(machine));
        fs.writeFileSync(file + '.tmp', JSON.stringify(snapshot));
        fs.renameSync(file + '.tmp', file);
        return { ok: true, file };
    }

    /** 다른 기기들의 목록 */
    readOthers() {
        const dir = this.dir();
        if (!dir) return [];
        const mdir = path.join(dir, 'machines');
        let names;
        try { names = fs.readdirSync(mdir).filter(n => n.endsWith('.json')); } catch { return []; }
        const me = this.name();
        const out = [];
        for (const n of names) {
            try {
                const d = JSON.parse(fs.readFileSync(path.join(mdir, n), 'utf8'));
                if (!d || d.machine === me || !Array.isArray(d.projects)) continue;
                if (this.now() - (d.generatedAt || 0) > FRESH_MS) continue;
                out.push(d);
            } catch { /* 쓰는 중이거나 깨진 파일 */ }
        }
        return out;
    }

    /**
     * 이 기기 목록에 다른 기기 세션을 섞는다.
     * 같은 폴더 경로면 한 프로젝트로, 같은 세션 id 가 이 기기에도 있으면 이 기기 것을 쓴다.
     */
    static merge(local, others, now) {
        const projects = local.projects.map(p => ({ ...p, sessions: [...p.sessions] }));
        const byRoot = new Map(projects.map(p => [p.root, p]));
        const have = new Set(projects.flatMap(p => p.sessions.map(s => s.id)));
        for (const o of others) {
            for (const rp of o.projects) {
                let p = byRoot.get(rp.root);
                if (!p) { p = { root: rp.root, name: rp.name, lastAt: rp.lastAt, hub: null, sessions: [], remoteOnly: true }; byRoot.set(rp.root, p); projects.push(p); }
                for (const s of rp.sessions) {
                    if (have.has(s.id)) continue;
                    have.add(s.id);
                    p.sessions.push({ ...s, remote: true, machine: o.machine, file: null, status: MachineSync.status(s.lastAt, now) });
                }
                p.sessions.sort((a, b) => b.lastAt - a.lastAt);
                p.lastAt = Math.max(p.lastAt || 0, ...p.sessions.map(s => s.lastAt));
            }
        }
        projects.sort((a, b) => b.lastAt - a.lastAt);
        return { ...local, projects, machines: [...new Set(others.map(o => o.machine))] };
    }

    static status(lastAt, now) {
        const age = (now || Date.now()) - lastAt;
        return age < 10 * 60e3 ? 'working' : age < 864e5 ? 'recent' : 'idle';
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = MachineSync;
}
