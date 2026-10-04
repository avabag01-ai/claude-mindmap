/**
 * GitHubMap.js
 * =============================================================================
 * GitHub 마인드맵 데이터 (메인 프로세스 전용). Tauri 판은 src-tauri/src/github_map.rs.
 *
 * - 내 저장소 목록, 저장소 하나의 열린 PR · 최근 브랜치를 gh api(REST)로 읽는다 (GraphQL 쓰지 않음).
 * - 로컬 폴더(세션 폴더)의 origin 을 읽어 "저장소 ↔ 로컬 폴더"를 이어 준다.
 * - 읽기만 한다. 푸시·브랜치 지우기 같은 일은 하지 않는다.
 */

const fs = require('fs');
const os = require('os');
const GitPanel = require('./GitPanel.js');

const BRANCH_PROBE = 20; // 날짜를 읽어 볼 브랜치 수
const BRANCH_SHOW = 8;   // 보여 줄 최근 브랜치 수

class GitHubMap {
    constructor(options = {}) {
        this.git = options.gitPanel || new GitPanel(options);
        this.home = options.home || os.homedir();
    }

    async _json(path, empty) {
        const out = await this.git.gh(this.home, ['api', path]);
        return JSON.parse(out || empty);
    }

    static repoOf(r) {
        return {
            name: r.name, fullName: r.full_name, url: r.html_url, pushedAt: r.pushed_at, language: r.language,
            private: !!r.private, fork: !!r.fork, archived: !!r.archived, defaultBranch: r.default_branch, description: r.description
        };
    }

    /** { account, repos, local: { 폴더: "주인/이름" } } */
    async repos(roots = []) {
        const user = await this._json('user', '{}');
        const repos = [];
        for (let page = 1; page <= 10; page++) {
            const arr = await this._json(`user/repos?per_page=100&affiliation=owner&sort=pushed&page=${page}`, '[]');
            repos.push(...arr.map(GitHubMap.repoOf));
            if (arr.length < 100) break;
        }
        return { account: user.login, repos, local: await this.localSlugs(roots) };
    }

    async localSlugs(roots) {
        const out = {};
        for (const root of roots) {
            if (!root || out[root] || !fs.existsSync(root) || !fs.statSync(root).isDirectory()) continue;
            const remote = (await this.git.git(root, ['remote', 'get-url', 'origin']).catch(() => '')).trim();
            const web = GitPanel.webUrl(remote);
            if (web) out[root] = web.replace('https://github.com/', '');
        }
        return out;
    }

    /** { slug, prs, branches: [{ name, date, isDefault }], branchCount } */
    async detail(slug) {
        if (!/^[\w.-]+\/[\w.-]+$/.test(String(slug || '')) || slug.includes('..')) throw new Error('저장소 이름이 올바르지 않아요');
        const info = await this._json(`repos/${slug}`, '{}');
        const def = info.default_branch || '';
        const prs = (await this._json(`repos/${slug}/pulls?state=open&per_page=30`, '[]')).map(GitPanel.prFromRest);
        const all = (await this._json(`repos/${slug}/branches?per_page=100`, '[]')).map(b => ({ name: b.name, sha: b.commit && b.commit.sha }));
        // 기본 브랜치를 먼저, 나머지는 앞에서부터 (날짜는 브랜치마다 한 번씩 읽어야 해서 개수를 줄인다)
        const probe = [...all.filter(b => b.name === def), ...all.filter(b => b.name !== def)].slice(0, BRANCH_PROBE);
        const dates = await Promise.all(probe.map(b => b.sha
            ? this._json(`repos/${slug}/commits/${b.sha}`, '{}').then(c => (c.commit && c.commit.committer && c.commit.committer.date) || '').catch(() => '')
            : ''));
        const branches = probe.map((b, i) => ({ name: b.name, date: dates[i], isDefault: b.name === def }))
            .sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0)).slice(0, BRANCH_SHOW);
        return { slug, prs, branches, branchCount: all.length };
    }
}

if (typeof module !== 'undefined' && module.exports) module.exports = GitHubMap;
