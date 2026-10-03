/**
 * SessionIndexer.js
 * =============================================================================
 * Claude Code 세션 기록(~/.claude/projects/<인코딩된 cwd>/<sessionId>.jsonl)을 읽어
 * "프로젝트 → 세션 → 수정한 파일" 구조로 정리하는 모듈 (메인 프로세스 전용, Node)
 *
 * 결과 구조:
 *   {
 *     generatedAt, claudeDir,
 *     projects: [{ root, name, lastAt, hub: { path, next[], topics[] } | null,
 *                  sessions: [{ id, title, cwd, gitBranch, firstAt, lastAt, status,
 *                               costUSD, git: 'dirty'|'ahead'|'pushed'|null (attachGit 후),
 *                               files: [{ path, rel, edits }] }] }]
 *   }
 *
 * 성능: 기록 파일이 수 MB 이상일 수 있어서 한 줄씩 읽고, 필요한 줄만 JSON.parse 한다.
 *       파일 크기·수정 시각이 같으면 이전 결과를 재사용한다(캐시).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');

const EDIT_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const WORKING_MS = 10 * 60 * 1000;      // 마지막 기록이 10분 안이면 "작업 중"
const RECENT_MS = 24 * 60 * 60 * 1000;  // 24시간 안이면 "최근"

const TS_RE = /"timestamp":"([^"]+)"/;
const CWD_RE = /"cwd":"((?:[^"\\]|\\.)*)"/;
const BRANCH_RE = /"gitBranch":"((?:[^"\\]|\\.)*)"/;
// 답마다 적힌 사용량: 세 값을 더하면 그때 세션 분량(컨텍스트 토큰). 맨 앞(최상위 usage) 값을 쓴다
const IN_RE = /"input_tokens":(\d+)/;
const CACHE_NEW_RE = /"cache_creation_input_tokens":(\d+)/;
const CACHE_READ_RE = /"cache_read_input_tokens":(\d+)/;
const MODEL_RE = /"model":"([^"]+)"/;
const TTL_1H_RE = /"ephemeral_1h_input_tokens":([1-9]\d*)/;
const TTL_5M_RE = /"ephemeral_5m_input_tokens":([1-9]\d*)/;

class SessionIndexer {
    /**
     * @param {object} [options]
     * @param {string} [options.claudeDir]  기본값 ~/.claude
     * @param {number} [options.maxSessions] 최근 세션 몇 개까지 읽을지 (기본 150)
     * @param {number} [options.maxFilesPerSession] 세션당 파일 노드 상한 (기본 60)
     * @param {() => number} [options.now] 테스트용 시계
     */
    constructor(options = {}) {
        this.claudeDir = options.claudeDir || path.join(os.homedir(), '.claude');
        this.maxSessions = options.maxSessions || 150;
        this.maxFilesPerSession = options.maxFilesPerSession || 60;
        this.now = options.now || (() => Date.now());
        this.cache = new Map(); // 기록 파일 경로 → { key, session }
        // 세션 묶기(하위 세션) 정보: Claude Code 에는 없는 개념이라 FlowCode 가 따로 저장한다
        this.linksFile = options.linksFile || path.join(os.homedir(), '.flowcode', 'session-links.json');
        this.lastSessions = new Map(); // "root::id" → session (마지막 index 결과)
    }

    async index() {
        const projectsDir = path.join(this.claudeDir, 'projects');
        const transcripts = this._listTranscripts(projectsDir)
            .sort((a, b) => b.mtimeMs - a.mtimeMs)
            .slice(0, this.maxSessions);

        const sessions = [];
        for (const t of transcripts) {
            const session = await this._readSessionCached(t);
            if (session) sessions.push(session);
        }

        // 프로젝트 루트별로 묶기
        const byRoot = new Map();
        for (const s of sessions) {
            const root = this._projectRoot(s.cwd);
            if (!byRoot.has(root)) byRoot.set(root, []);
            byRoot.get(root).push(s);
        }

        const links = this._readLinks();
        const projects = [];
        this.lastSessions = new Map();
        for (const [root, list] of byRoot) {
            list.sort((a, b) => b.lastAt - a.lastAt);
            const ids = new Set(list.map(s => s.id));
            for (const s of list) {
                s.files = s.files.map(f => ({ ...f, rel: this._relative(root, f.path) }));
                const parent = links.parents[`${root}::${s.id}`];
                s.parentId = parent && ids.has(parent) && parent !== s.id ? parent : null;
                // 줄기: 툰 이어가기로 이어진 앞 세션
                const prev = links.prev[`${root}::${s.id}`];
                s.prevId = prev && ids.has(prev) && prev !== s.id ? prev : null;
                // 주제 가지: 정해 둔 것 → 첫 메시지의 "topic: X"
                const key = `${root}::${s.id}`;
                s.topic = key in links.topics ? links.topics[key] : SessionIndexer.topicOf(s.firstPrompt);
                // 종류: 정해 둔 것 → 코드 파일을 고쳤으면 code, 아니면 chat (대화·관제)
                s.kind = links.kinds[key] === 'chat' || links.kinds[key] === 'code' ? links.kinds[key] : SessionIndexer.kindOf(s.files);
                this.lastSessions.set(`${root}::${s.id}`, s);
            }
            projects.push({
                root,
                name: path.basename(root) || root,
                lastAt: list[0].lastAt,
                hub: this._readHub(root),
                sessions: list
            });
        }
        projects.sort((a, b) => b.lastAt - a.lastAt);
        this.lastRoots = new Set(projects.map(p => p.root));

        return { generatedAt: this.now(), claudeDir: this.claudeDir, projects };
    }

    // ---------------------------------------------------------------------
    // 세션 묶기 / 다른 폴더로 복사
    // ---------------------------------------------------------------------
    _readLinks() {
        try {
            const d = JSON.parse(fs.readFileSync(this.linksFile, 'utf8'));
            const obj = k => (d && d[k] && typeof d[k] === 'object' ? d[k] : {});
            return { version: 1, parents: obj('parents'), prev: obj('prev'), topics: obj('topics'), kinds: obj('kinds') };
        } catch {
            return { version: 1, parents: {}, prev: {}, topics: {}, kinds: {} };
        }
    }

    _writeLinks(links) {
        fs.mkdirSync(path.dirname(this.linksFile), { recursive: true });
        const tmp = this.linksFile + '.tmp';
        fs.writeFileSync(tmp, JSON.stringify(links, null, 2));
        fs.renameSync(tmp, this.linksFile);
    }

    /** 세션을 같은 폴더의 다른 세션 아래에 붙인다 (parentId 가 null 이면 떼어낸다) */
    setParent(root, id, parentId) {
        if (!this.lastSessions.has(`${root}::${id}`)) throw new Error('세션 목록에 없는 세션이에요');
        if (parentId && !this.lastSessions.has(`${root}::${parentId}`)) throw new Error('같은 폴더의 세션에만 붙일 수 있어요');
        const links = this._readLinks();
        if (parentId) {
            // 자기 자신이나 자기 하위 세션 아래로는 못 붙인다
            for (let cur = parentId, guard = 0; cur; cur = links.parents[`${root}::${cur}`], guard++) {
                if (cur === id || guard > 1000) throw new Error('자기 하위 세션 아래로는 붙일 수 없어요');
            }
            links.parents[`${root}::${id}`] = parentId;
        } else {
            delete links.parents[`${root}::${id}`];
        }
        this._writeLinks(links);
        return { root, id, parentId: parentId || null };
    }

    /**
     * 새로 만든 세션을 제자리에 붙인다 (한 번에 쓰기): 하위 세션(parentId), 줄기의 앞 세션(prevId), 주제(topic)
     * 값이 undefined 면 그대로, null 이면 지운다.
     */
    setMeta(root, id, { parentId, prevId, topic, kind } = {}) {
        if (kind !== undefined && kind !== null && kind !== 'chat' && kind !== 'code') throw new Error('세션 종류는 chat 또는 code 예요');
        if (!this.lastSessions.has(`${root}::${id}`)) throw new Error('세션 목록에 없는 세션이에요');
        if (topic && !/^[\w.-]+$/.test(topic)) throw new Error('주제 이름이 올바르지 않아요');
        if (parentId !== undefined) this.setParent(root, id, parentId);
        const links = this._readLinks();
        const key = `${root}::${id}`;
        if (prevId !== undefined) {
            if (prevId && (prevId === id || !this.lastSessions.has(`${root}::${prevId}`))) throw new Error('같은 폴더의 세션만 이을 수 있어요');
            for (let cur = prevId, guard = 0; cur; cur = links.prev[`${root}::${cur}`], guard++) {
                if (cur === id || guard > 1000) throw new Error('돌고 도는 줄기는 만들 수 없어요');
            }
            if (prevId) links.prev[key] = prevId; else delete links.prev[key];
        }
        if (topic !== undefined) {
            if (topic) links.topics[key] = topic; else links.topics[key] = null; // null = 주제 없음으로 고정
        }
        if (kind !== undefined) {
            if (kind) links.kinds[key] = kind; else delete links.kinds[key]; // null = 다시 자동
        }
        this._writeLinks(links);
        return { root, id, parentId, prevId, topic, kind };
    }

    /**
     * 세션을 다른 폴더로 복사한다. 원본은 그대로 두고, 기록의 sessionId 와 cwd 를 바꿔
     * ~/.claude/projects/<새 폴더>/<새 id>.jsonl 로 쓴다. 그 폴더에서 claude --resume <새 id> 로 이어갈 수 있다.
     */
    copySession(root, id, toRoot) {
        const s = this.lastSessions.get(`${root}::${id}`);
        if (!s) throw new Error('세션 목록에 없는 세션이에요');
        if (!toRoot || !fs.existsSync(toRoot) || !fs.statSync(toRoot).isDirectory()) throw new Error(`폴더가 없어요: ${toRoot}`);
        const newId = require('crypto').randomUUID();
        const fromCwd = s.cwd;
        const lines = fs.readFileSync(s.file, 'utf8').split('\n');
        const out = lines.map(line => {
            if (!line.trim()) return line;
            let d;
            try { d = JSON.parse(line); } catch { return line; }
            if (d.sessionId) d.sessionId = newId;
            if (typeof d.cwd === 'string' && fromCwd && (d.cwd === fromCwd || d.cwd.startsWith(fromCwd + path.sep))) {
                d.cwd = toRoot + d.cwd.slice(fromCwd.length);
            }
            return JSON.stringify(d);
        });
        const dir = path.join(this.claudeDir, 'projects', SessionIndexer.encodeCwd(toRoot));
        fs.mkdirSync(dir, { recursive: true });
        const file = path.join(dir, newId + '.jsonl');
        fs.writeFileSync(file, out.join('\n'));
        return { root: toRoot, id: newId, file, from: { root, id } };
    }

    // ---------------------------------------------------------------------
    // 기록 파일 목록
    // ---------------------------------------------------------------------
    _listTranscripts(projectsDir) {
        let dirs;
        try {
            dirs = fs.readdirSync(projectsDir, { withFileTypes: true });
        } catch {
            return [];
        }
        const out = [];
        for (const d of dirs) {
            if (!d.isDirectory()) continue;
            const dir = path.join(projectsDir, d.name);
            let files;
            try {
                files = fs.readdirSync(dir);
            } catch {
                continue;
            }
            for (const name of files) {
                if (!name.endsWith('.jsonl')) continue;
                const file = path.join(dir, name);
                try {
                    const st = fs.statSync(file);
                    if (st.isFile() && st.size > 0) out.push({ file, mtimeMs: st.mtimeMs, size: st.size });
                } catch {
                    // 읽는 사이에 지워진 파일은 건너뛴다
                }
            }
        }
        return out;
    }

    async _readSessionCached(t) {
        const key = `${t.size}:${t.mtimeMs}`;
        const hit = this.cache.get(t.file);
        let session;
        if (hit && hit.key === key) {
            session = { ...hit.session, files: hit.session.files.map(f => ({ ...f })) };
        } else {
            session = await this._readSession(t.file, t.mtimeMs);
            if (session) this.cache.set(t.file, { key, session: { ...session, files: session.files.map(f => ({ ...f })) } });
        }
        if (session) session.status = this._status(session.lastAt);
        return session;
    }

    // ---------------------------------------------------------------------
    // 기록 한 개 읽기
    // ---------------------------------------------------------------------
    async _readSession(file, mtimeMs) {
        const s = {
            id: path.basename(file, '.jsonl'),
            file,
            title: '',
            firstPrompt: '',
            cwd: '',
            gitBranch: '',
            firstAt: 0,
            lastAt: 0,
            costUSD: null,
            context: null, // { tokens, model, ttl: '1h'|'5m'|null, at } 마지막 답 기준
            files: []
        };
        const edits = new Map(); // 파일 경로 → 수정 횟수

        const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
        for await (const line of rl) {
            if (!line) continue;

            const ts = TS_RE.exec(line);
            if (ts) {
                const ms = Date.parse(ts[1]);
                if (!Number.isNaN(ms)) {
                    if (!s.firstAt || ms < s.firstAt) s.firstAt = ms;
                    if (ms > s.lastAt) s.lastAt = ms;
                }
            }
            if (!s.cwd) {
                const m = CWD_RE.exec(line);
                if (m) s.cwd = JSON.parse(`"${m[1]}"`);
            }
            if (!s.gitBranch) {
                const m = BRANCH_RE.exec(line);
                if (m) s.gitBranch = JSON.parse(`"${m[1]}"`);
            }

            // 세션 분량: 하위 에이전트 말고 본 대화의 마지막 답 (JSON 파싱 없이 숫자만)
            if (line.includes('"usage"') && line.includes('"type":"assistant"') && !line.includes('"isSidechain":true')) {
                const a = IN_RE.exec(line), b = CACHE_NEW_RE.exec(line), c = CACHE_READ_RE.exec(line);
                if (a) {
                    const m = MODEL_RE.exec(line);
                    const ttl = TTL_1H_RE.test(line) ? '1h' : TTL_5M_RE.test(line) ? '5m' : (s.context && s.context.ttl) || null;
                    s.context = { tokens: +a[1] + (b ? +b[1] : 0) + (c ? +c[1] : 0), model: m ? m[1] : (s.context && s.context.model) || '', ttl, at: ts ? Date.parse(ts[1]) || 0 : 0 };
                }
            }

            // 필요한 줄만 파싱
            const wantTitle = line.includes('"ai-title"');
            const wantCost = line.includes('"cost-state"');
            const wantTool = line.includes('"tool_use"') && line.includes('"assistant"');
            const wantPrompt = !s.firstPrompt && line.includes('"type":"user"');
            if (!wantTitle && !wantCost && !wantTool && !wantPrompt) continue;

            let d;
            try {
                d = JSON.parse(line);
            } catch {
                continue;
            }

            if (d.type === 'ai-title' && d.aiTitle) s.title = d.aiTitle;
            else if (d.type === 'cost-state' && typeof d.totalCostUSD === 'number') s.costUSD = d.totalCostUSD;
            else if (d.type === 'user' && !s.firstPrompt) s.firstPrompt = this._promptText(d);
            else if (d.type === 'assistant') {
                const content = d.message && Array.isArray(d.message.content) ? d.message.content : [];
                for (const b of content) {
                    if (!b || b.type !== 'tool_use' || !EDIT_TOOLS.has(b.name) || !b.input) continue;
                    const p = b.input.file_path || b.input.notebook_path;
                    if (typeof p === 'string' && p) edits.set(p, (edits.get(p) || 0) + 1);
                }
            }
        }

        if (!s.cwd && !s.firstAt) return null; // 대화가 없는 기록
        if (!s.lastAt) s.lastAt = mtimeMs;
        if (!s.firstAt) s.firstAt = s.lastAt;
        if (!s.title) s.title = s.firstPrompt ? s.firstPrompt.slice(0, 60) : s.id.slice(0, 8);

        s.files = [...edits.entries()]
            .sort((a, b) => b[1] - a[1])
            .slice(0, this.maxFilesPerSession)
            .map(([p, n]) => ({ path: p, edits: n }));
        return s;
    }

    _promptText(d) {
        const c = d.message && d.message.content;
        if (typeof c === 'string') return c.trim();
        if (Array.isArray(c)) {
            const t = c.find(b => b && b.type === 'text' && typeof b.text === 'string');
            if (t) return t.text.trim();
        }
        return '';
    }

    _status(lastAt) {
        const age = this.now() - lastAt;
        if (age < WORKING_MS) return 'working';
        if (age < RECENT_MS) return 'recent';
        return 'idle';
    }

    // ---------------------------------------------------------------------
    // 프로젝트 루트, 툰 허브
    // ---------------------------------------------------------------------
    _projectRoot(cwd) {
        if (!cwd) return '(알 수 없음)';
        let dir = cwd;
        for (;;) {
            try {
                if (fs.existsSync(path.join(dir, '.git'))) return dir;
            } catch {
                break;
            }
            const parent = path.dirname(dir);
            if (parent === dir) break;
            dir = parent;
        }
        return cwd; // git 저장소가 아니거나 지금은 없는 폴더
    }

    _relative(root, p) {
        const rel = path.relative(root, p);
        if (rel && !rel.startsWith('..') && !path.isAbsolute(rel)) return rel;
        const home = os.homedir();
        return p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p;
    }

    _readHub(root) {
        const hubPath = path.join(root, '.toon', 'HUB.toon');
        let text;
        try {
            text = fs.readFileSync(hubPath, 'utf8');
        } catch {
            return null;
        }
        const next = text.split('\n')
            .map(l => l.trim())
            .filter(l => /NEXT/.test(l) && l.length > 4)
            .slice(0, 6)
            .map(l => (l.length > 160 ? l.slice(0, 157) + '…' : l));
        let topics = [];
        try {
            topics = fs.readdirSync(path.join(root, '.toon'), { withFileTypes: true })
                .filter(d => d.isDirectory() && fs.existsSync(path.join(root, '.toon', d.name, 'HUB.toon')))
                .map(d => d.name);
        } catch {
            // 주제 허브 없음
        }
        return { path: hubPath, next, topics, titles: SessionIndexer._topicTitles(root, topics) };
    }
}

/** 첫 메시지 "툰 불러와 — …, topic: X, …" 의 주제 */
SessionIndexer.topicOf = function (prompt) {
    const m = /\btopic:\s*([\w.-]+)/.exec(String(prompt || '').slice(0, 2000));
    return m ? m[1] : null;
};

/** 세션 종류 짐작: 문서·툰·설정 말고 코드 파일을 고쳤으면 code, 아니면 chat */
SessionIndexer.kindOf = function (files) {
    return (files || []).some(f => !/\.(md|markdown|toon|txt|json|ya?ml|csv)$/i.test(f.path) && !/[\\/]\.toon[\\/]/.test(f.path)) ? 'code' : 'chat';
};

/** 주제 허브의 화면 이름: HUB.toon 앞부분의 "title: …" (없으면 폴더 이름) */
SessionIndexer._topicTitles = function (root, topics) {
    const out = {};
    for (const t of topics) {
        try {
            const head = fs.readFileSync(path.join(root, '.toon', t, 'HUB.toon'), 'utf8').slice(0, 2000);
            const m = /^title:\s*(.+)$/m.exec(head);
            out[t] = m ? m[1].trim() : t;
        } catch {
            out[t] = t;
        }
    }
    return out;
};

/** Claude Code 가 기록 폴더 이름을 만드는 방식: 영문·숫자 말고는 모두 '-' */
SessionIndexer.encodeCwd = cwd => String(cwd).replace(/[^a-zA-Z0-9]/g, '-');

/**
 * 툰 허브 전문 읽기: <root>/.toon/HUB.toon, 또는 주제 허브 <root>/.toon/<topic>/HUB.toon
 * @returns {{ root, topic, path, text, mtimeMs, topics: string[] }}
 */
SessionIndexer.readHub = function (root, topic) {
    if (topic && !/^[\w.-]+$/.test(topic)) throw new Error('주제 이름이 올바르지 않아요');
    const toonDir = path.join(root, '.toon');
    const hubPath = topic ? path.join(toonDir, topic, 'HUB.toon') : path.join(toonDir, 'HUB.toon');
    const st = fs.statSync(hubPath);
    if (st.size > 2 * 1024 * 1024) throw new Error('허브 파일이 너무 커요');
    let topics = [];
    try {
        topics = fs.readdirSync(toonDir, { withFileTypes: true })
            .filter(d => d.isDirectory() && fs.existsSync(path.join(toonDir, d.name, 'HUB.toon')))
            .map(d => d.name).sort();
    } catch {
        // 주제 허브 없음
    }
    return { root, topic: topic || null, path: hubPath, text: fs.readFileSync(hubPath, 'utf8'), mtimeMs: st.mtimeMs, topics, titles: SessionIndexer._topicTitles(root, topics) };
};

/**
 * 대화창용: 기록 파일을 사람/Claude 메시지 목록으로 바꾼다.
 * - 사람이 쓴 메시지만 user 로 (도구 결과, 하위 에이전트, 메타 메시지는 뺀다)
 * - 이어진 assistant 기록은 한 덩어리로 합치고, 도구 호출은 { name, target } 로 요약
 * @returns {Promise<{ messages: Array<{role, text, tools, at}>, mtimeMs: number, truncated: boolean }>}
 */
SessionIndexer.readTranscript = async function (file, { limit = 300 } = {}) {
    const st = fs.statSync(file);
    const messages = [];
    const rl = readline.createInterface({ input: fs.createReadStream(file, { encoding: 'utf8' }), crlfDelay: Infinity });
    for await (const line of rl) {
        if (!line || (!line.includes('"type":"user"') && !line.includes('"type":"assistant"'))) continue;
        let d;
        try {
            d = JSON.parse(line);
        } catch {
            continue;
        }
        if (d.isSidechain || d.isMeta || !d.message) continue;
        const at = Date.parse(d.timestamp) || 0;
        const content = d.message.content;

        if (d.type === 'user') {
            let text = '';
            if (typeof content === 'string') text = content;
            else if (Array.isArray(content)) {
                if (content.some(b => b && b.type === 'tool_result')) continue;
                text = content.filter(b => b && b.type === 'text').map(b => b.text).join('\n');
            }
            text = text.trim();
            if (!text || /^<(command-|local-command|system-reminder)/.test(text)) continue;
            messages.push({ role: 'user', text, tools: [], at });
            continue;
        }

        // assistant
        const blocks = Array.isArray(content) ? content : [];
        let last = messages[messages.length - 1];
        if (!last || last.role !== 'assistant') {
            last = { role: 'assistant', text: '', tools: [], at };
            messages.push(last);
        }
        for (const b of blocks) {
            if (!b) continue;
            if (b.type === 'text' && b.text) last.text += (last.text ? '\n\n' : '') + b.text.trim();
            else if (b.type === 'tool_use') last.tools.push({ name: b.name, target: toolTarget(b.input || {}) });
        }
        last.at = at || last.at;
    }
    const cleaned = messages.filter(m => m.text || m.tools.length);
    return {
        messages: cleaned.slice(-limit),
        truncated: cleaned.length > limit,
        mtimeMs: st.mtimeMs
    };
};

/**
 * 세션마다 git 상태를 붙인다 (그 세션이 고친 파일 기준)
 *   dirty  = 고친 파일 중 커밋 안 한 것이 있음 (git status --porcelain)
 *   ahead  = 커밋했지만 아직 푸시 전 (git log @{u}..HEAD, upstream 이 없으면 어느 원격 브랜치에도 없는 커밋)
 *   pushed = 모두 GitHub 에 올라감
 * 고친 파일이 없거나 git 저장소가 아니면 git 을 붙이지 않는다 (null).
 * @param {object} index  index() 결과 (그대로 고친다)
 * @param {(args: string[], cwd: string) => Promise<{code: number, stdout: string}>} [run]  git 실행기 (테스트용)
 */
SessionIndexer.attachGit = async function (index, run = SessionIndexer.runGit) {
    await Promise.all(index.projects.map(async p => {
        const withFiles = p.sessions.filter(s => s.files && s.files.length);
        if (!withFiles.length) return;
        const st = await SessionIndexer.gitState(p.root, run).catch(() => null);
        for (const s of p.sessions) s.git = null;
        if (!st) return;
        for (const s of withFiles) {
            const rels = s.files.map(f => path.relative(p.root, f.path)).filter(r => r && !r.startsWith('..') && !path.isAbsolute(r));
            if (!rels.length) continue;
            s.git = rels.some(r => st.dirty.has(r)) ? 'dirty' : rels.some(r => st.ahead.has(r)) ? 'ahead' : 'pushed';
        }
    }));
    return index;
};

/** 저장소 한 개의 상태: { dirty: Set<rel>, ahead: Set<rel>, upstream } (git 저장소가 아니면 null) */
SessionIndexer.gitState = async function (root, run = SessionIndexer.runGit) {
    const status = await run(['status', '--porcelain=v1', '-z', '--untracked-files=all'], root);
    if (status.code !== 0) return null;
    const dirty = new Set();
    const parts = status.stdout.split('\0');
    for (let i = 0; i < parts.length; i++) {
        const e = parts[i];
        if (e.length < 4) continue;
        dirty.add(e.slice(3));
        if (e[0] === 'R' || e[0] === 'C') dirty.add(parts[++i]); // 이름 바꾸기: 다음 칸이 옛 이름
    }
    const up = await run(['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}'], root);
    const upstream = up.code === 0 ? up.stdout.trim() : null;
    // 올릴 곳(upstream)이 없는 새 브랜치면 어느 원격 브랜치에도 없는 커밋만 (원격이 아예 없으면 전부)
    const range = upstream ? ['@{u}..HEAD'] : ['HEAD', '--not', '--remotes'];
    const log = await run(['log', ...range, '--name-only', '--pretty=format:', '-n', '500'], root);
    const ahead = new Set(log.code === 0 ? log.stdout.split('\n').map(l => l.trim()).filter(Boolean) : []);
    return { dirty, ahead, upstream };
};

/** 로그인 셸 PATH 로 git 실행 (실패해도 던지지 않고 code 를 돌려준다) */
SessionIndexer.runGit = function (args, cwd) {
    const { execFile } = require('child_process');
    const { childEnv } = require('./loginPath.js');
    return new Promise(resolve => {
        execFile('git', args, { cwd, env: childEnv({ GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' }), timeout: 15000, maxBuffer: 8 * 1024 * 1024 },
            (err, stdout) => resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '') }));
    });
};

function toolTarget(input) {
    const v = input.file_path || input.notebook_path || input.path || input.pattern || input.command || input.url || input.description || input.query || '';
    const s = String(v).replace(/\s+/g, ' ').trim();
    return s.length > 80 ? s.slice(0, 79) + '…' : s;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = SessionIndexer;
}
