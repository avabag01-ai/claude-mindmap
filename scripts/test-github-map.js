// GitHubMap 테스트: 가짜 gh 로 저장소 목록·로컬 폴더 잇기·PR·최근 브랜치
// 실행: node scripts/test-github-map.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const GitHubMap = require('../src/core/GitHubMap.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ghmap-')));
const fake = path.join(tmp, 'fake-gh.sh');
fs.writeFileSync(fake, `#!/bin/sh
case "$2" in
  user) echo '{"login":"me"}';;
  user/repos*page=1) echo '[{"name":"a","full_name":"me/a","html_url":"https://github.com/me/a","pushed_at":"2026-10-01T00:00:00Z","language":"Rust","private":true,"fork":false,"archived":false,"default_branch":"main","description":"d"}]';;
  repos/me/a) echo '{"default_branch":"main"}';;
  repos/me/a/pulls*) echo '[{"number":3,"title":"p","draft":false,"head":{"ref":"feat"},"html_url":"u","user":{"login":"me"},"updated_at":"x"}]';;
  repos/me/a/branches*) echo '[{"name":"old","commit":{"sha":"s1"}},{"name":"main","commit":{"sha":"s2"}},{"name":"feat","commit":{"sha":"s3"}}]';;
  repos/me/a/commits/s1) echo '{"commit":{"committer":{"date":"2026-01-01T00:00:00Z"}}}';;
  repos/me/a/commits/s2) echo '{"commit":{"committer":{"date":"2026-09-01T00:00:00Z"}}}';;
  repos/me/a/commits/s3) echo '{"commit":{"committer":{"date":"2026-10-01T00:00:00Z"}}}';;
  *) echo "gh: not logged in, run: gh auth login" >&2; exit 1;;
esac
`, { mode: 0o755 });

const clone = path.join(tmp, 'clone');
const plain = path.join(tmp, 'plain');
fs.mkdirSync(clone);
fs.mkdirSync(plain);
execFileSync('git', ['init', '-q'], { cwd: clone });
execFileSync('git', ['remote', 'add', 'origin', 'git@github.com:me/a.git'], { cwd: clone });

const gm = new GitHubMap({ ghBin: fake, home: tmp });

(async () => {
    const r = await gm.repos([clone, plain, '/없는/폴더']);
    assert.strictEqual(r.account, 'me');
    assert.strictEqual(r.repos[0].fullName, 'me/a');
    assert.strictEqual(r.repos[0].private, true);
    assert.deepStrictEqual(r.local, { [clone]: 'me/a' }, 'origin 이 GitHub 인 폴더만 이어진다');

    const d = await gm.detail('me/a');
    assert.strictEqual(d.prs[0].headRefName, 'feat');
    assert.strictEqual(d.branchCount, 3);
    assert.deepStrictEqual(d.branches, [
        { name: 'feat', date: '2026-10-01T00:00:00Z', isDefault: false },
        { name: 'main', date: '2026-09-01T00:00:00Z', isDefault: true },
        { name: 'old', date: '2026-01-01T00:00:00Z', isDefault: false }
    ], '최근 것부터, 기본 브랜치 표시');
    await assert.rejects(gm.detail('../x'), /저장소 이름이 올바르지 않아요/);
    await assert.rejects(gm.detail('me/b'), /gh 로그인이 필요해요/);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('GitHubMap: 모든 테스트 통과');
})().catch(e => { console.error(e); process.exit(1); });
