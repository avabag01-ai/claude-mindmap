/**
 * GitPanel.js
 * =============================================================================
 * 세션 허브 GitHub 탭의 git / gh 실행 (메인 프로세스 전용)
 *
 * - git: 상태, 최근 커밋, 변경 diff, 가져오기(pull --ff-only), 커밋, 푸시, 새 브랜치
 * - gh (GitHub CLI): PR 목록, 이슈 목록, PR 만들기(draft), 현재 브랜치 PR 체크
 * - 맥 앱을 Finder 에서 켜면 PATH 가 짧아 gh(/opt/homebrew/bin)를 못 찾으므로 로그인 셸의 PATH 로 실행한다.
 * - 되돌리기 어려운 명령(force push, reset, 브랜치 삭제)은 만들지 않는다.
 */

const { spawn } = require('child_process');
const { childEnv } = require('./loginPath.js');
const fs = require('fs');
const path = require('path');

class GitPanel {
    constructor(options = {}) {
        this.timeoutMs = options.timeoutMs || 60000;
        this.ghBin = options.ghBin || process.env.FLOWCODE_GH_BIN || 'gh';
    }

    /** 로그인 셸 PATH 로 실행: { code, stdout, stderr } (명령이 없으면 code 127) */
    run(bin, args, cwd, { input, timeoutMs } = {}) {
        return new Promise((resolve, reject) => {
            const child = spawn(bin, args, {
                cwd, env: childEnv({ GIT_TERMINAL_PROMPT: '0', GH_PROMPT_DISABLED: '1', NO_COLOR: '1' }), stdio: ['pipe', 'pipe', 'pipe']
            });
            let stdout = '', stderr = '';
            const timer = setTimeout(() => { child.kill('SIGKILL'); reject(new Error(`${bin} 가 너무 오래 걸려서 멈췄어요`)); }, timeoutMs || this.timeoutMs);
            child.stdout.on('data', d => { stdout += d; });
            child.stderr.on('data', d => { stderr += d; });
            child.on('error', err => {
                clearTimeout(timer);
                if (err.code === 'ENOENT' && fs.existsSync(cwd)) resolve({ code: 127, stdout: '', stderr: `${bin}: command not found` });
                else reject(err.code === 'ENOENT' ? new Error(`폴더가 없어요: ${cwd}`) : err);
            });
            child.on('close', code => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
            if (input != null) child.stdin.end(input); else child.stdin.end();
        });
    }

    async git(cwd, args, opts) {
        const r = await this.run('git', args, cwd, opts);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || `git ${args[0]} 실패`).trim());
        return r.stdout;
    }

    async gh(cwd, args, opts) {
        const r = await this.run(this.ghBin, args, cwd, opts);
        if (r.code !== 0) {
            const msg = (r.stderr || r.stdout || '').trim();
            if (r.code === 127 || /command not found|not found: gh/.test(msg)) throw new Error('gh(GitHub CLI)가 없어요. 터미널에서 brew install gh && gh auth login');
            if (/auth login|not logged/i.test(msg)) throw new Error('gh 로그인이 필요해요. 터미널에서 gh auth login');
            throw new Error(msg || `gh ${args[0]} 실패`);
        }
        return r.stdout;
    }

    _checkDir(cwd) {
        if (!cwd || !fs.existsSync(cwd) || !fs.statSync(cwd).isDirectory()) throw new Error(`폴더가 없어요: ${cwd}`);
    }

    /** 저장소 상태 한 번에 */
    async info(cwd) {
        this._checkDir(cwd);
        let root;
        try {
            root = (await this.git(cwd, ['rev-parse', '--show-toplevel'])).trim();
        } catch {
            return { cwd, isRepo: false };
        }
        const [statusOut, logOut, remoteOut] = await Promise.all([
            this.git(root, ['status', '--porcelain=v1', '--branch', '-z']),
            this.git(root, ['log', '-15', '--date=iso-strict', '--pretty=format:%h%x1f%s%x1f%an%x1f%ad']).catch(() => ''),
            this.git(root, ['remote', 'get-url', 'origin']).catch(() => '')
        ]);
        return { cwd, root, isRepo: true, ...GitPanel.parseStatus(statusOut), log: GitPanel.parseLog(logOut), remote: remoteOut.trim(), web: GitPanel.webUrl(remoteOut.trim()) };
    }

    async diff(root, file) {
        this._checkDir(root);
        const args = ['diff', '--no-color', 'HEAD', '--'];
        let out = await this.git(root, file ? [...args, file] : args).catch(() => '');
        if (!out && file) {
            // 새 파일(추적 전)은 내용 앞부분을 보여 준다
            const full = path.join(root, file);
            if (fs.existsSync(full) && fs.statSync(full).isFile()) out = `새 파일: ${file}\n\n` + fs.readFileSync(full, 'utf8').slice(0, 20000);
        }
        return { root, file, diff: out.length > 200000 ? out.slice(0, 200000) + '\n… (너무 길어서 잘랐어요)' : out };
    }

    async action(root, req) {
        this._checkDir(root);
        switch (req.action) {
            case 'pull':
                return { out: await this.git(root, ['pull', '--ff-only'], { timeoutMs: 120000 }) };
            case 'commit': {
                const msg = String(req.message || '').trim();
                if (!msg) throw new Error('커밋 메시지를 써 주세요');
                if (req.all) await this.git(root, ['add', '-A']);
                else if (req.files && req.files.length) await this.git(root, ['add', '--', ...req.files]);
                return { out: await this.git(root, ['commit', '-F', '-'], { input: msg }) };
            }
            case 'push': {
                const branch = (await this.git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim();
                if (branch === 'HEAD') throw new Error('브랜치가 없는 상태(detached)라서 푸시하지 않아요');
                const r = await this.run('git', ['push', '-u', 'origin', branch], root, { timeoutMs: 180000 });
                if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim());
                return { out: (r.stderr + r.stdout).trim() };
            }
            case 'branch': {
                const name = String(req.name || '').trim();
                if (!/^[\w./-]+$/.test(name) || name.includes('..')) throw new Error('브랜치 이름이 올바르지 않아요');
                return { out: await this.git(root, ['switch', '-c', name]) };
            }
            case 'pr-create': {
                const args = ['pr', 'create', '--draft'];
                if (req.title) args.push('--title', String(req.title), '--body', String(req.body || ''));
                else args.push('--fill');
                return { out: await this.gh(root, args, { timeoutMs: 120000 }) };
            }
            default:
                throw new Error('모르는 작업이에요');
        }
    }

    // gh api(REST)로 읽는다: GraphQL 이 막힌 환경에서도 동작
    async _repoSlug(root) {
        const remote = (await this.git(root, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
        const web = GitPanel.webUrl(remote);
        if (!web) throw new Error('GitHub 저장소가 아니에요 (origin 이 github.com 이 아님)');
        return web.replace('https://github.com/', '');
    }

    async ghList(root, what) {
        this._checkDir(root);
        const slug = await this._repoSlug(root);
        if (what === 'prs') {
            const items = JSON.parse(await this.gh(root, ['api', `repos/${slug}/pulls?state=open&per_page=30`]) || '[]');
            return { what, items: items.map(GitPanel.prFromRest) };
        }
        if (what === 'issues') {
            const items = JSON.parse(await this.gh(root, ['api', `repos/${slug}/issues?state=open&per_page=30`]) || '[]');
            return { what, items: items.filter(x => !x.pull_request).map(x => ({ number: x.number, title: x.title, url: x.html_url, labels: (x.labels || []).map(l => l.name), updatedAt: x.updated_at })) };
        }
        if (what === 'checks') {
            const sha = (await this.git(root, ['rev-parse', 'HEAD'])).trim();
            const data = JSON.parse(await this.gh(root, ['api', `repos/${slug}/commits/${sha}/check-runs?per_page=50`]) || '{}');
            const runs = (data.check_runs || []).map(c => ({ name: c.name, state: (c.conclusion || c.status || '').toUpperCase(), link: c.html_url }));
            return { what, items: runs, note: runs.length ? undefined : '이 커밋에 체크가 없어요 (푸시 전이거나 CI 가 없음)' };
        }
        throw new Error('모르는 목록이에요');
    }

    static prFromRest(p) {
        return { number: p.number, title: p.title, isDraft: !!p.draft, headRefName: p.head && p.head.ref, url: p.html_url, author: p.user && p.user.login, updatedAt: p.updated_at };
    }

    // ---------------------------------------------------------------------
    // 파싱
    // ---------------------------------------------------------------------
    static parseStatus(out) {
        const parts = out.split('\0').filter(Boolean);
        const res = { branch: null, upstream: null, ahead: 0, behind: 0, changes: [] };
        for (let i = 0; i < parts.length; i++) {
            const p = parts[i];
            if (p.startsWith('## ')) {
                const head = p.slice(3);
                const m = /^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$/.exec(head);
                if (m) {
                    res.branch = m[1].replace(/^No commits yet on /, '');
                    res.upstream = m[2] || null;
                    const a = /ahead (\d+)/.exec(m[3] || ''), b = /behind (\d+)/.exec(m[3] || '');
                    res.ahead = a ? +a[1] : 0;
                    res.behind = b ? +b[1] : 0;
                }
                continue;
            }
            const xy = p.slice(0, 2);
            const file = p.slice(3);
            const change = { xy, path: file, staged: xy[0] !== ' ' && xy[0] !== '?', label: GitPanel.label(xy) };
            if (xy[0] === 'R' || xy[0] === 'C') { change.from = parts[++i]; }
            res.changes.push(change);
        }
        return res;
    }

    static label(xy) {
        if (xy === '??') return '새 파일';
        const c = xy[0] !== ' ' ? xy[0] : xy[1];
        return { M: '수정', A: '추가', D: '삭제', R: '이름 바꿈', C: '복사', U: '충돌' }[c] || xy.trim();
    }

    static parseLog(out) {
        return out.split('\n').filter(Boolean).map(l => {
            const [sha, subject, author, date] = l.split('\x1f');
            return { sha, subject, author, date };
        });
    }

    /** origin 주소 → GitHub 웹 주소 (아니면 null) */
    static webUrl(remote) {
        const m = /github\.com[:/]([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/.exec(remote || '');
        return m ? `https://github.com/${m[1]}/${m[2]}` : null;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = GitPanel;
}
