// GitPanel 테스트: 임시 git 저장소와 로컬 원격(bare)으로 상태·커밋·푸시·가져오기·브랜치·diff
// 실행: node scripts/test-git-panel.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const GitPanel = require('../src/core/GitPanel.js');

// 이 컴퓨터의 전역 git 설정(서명 등)이 테스트에 끼지 않게
const emptyCfg = path.join(os.tmpdir(), 'gitp-empty-gitconfig');
fs.writeFileSync(emptyCfg, '');
process.env.GIT_CONFIG_GLOBAL = emptyCfg;
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'gitp-')));
const bare = path.join(tmp, 'remote.git');
const repo = path.join(tmp, 'repo');
const other = path.join(tmp, 'other');
const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' });
const ident = ['-c', 'user.name=t', '-c', 'user.email=t@t'];

g(tmp, 'init', '-q', '--bare', '-b', 'main', bare);
g(tmp, 'clone', '-q', bare, repo);
process.env.GIT_AUTHOR_NAME = process.env.GIT_COMMITTER_NAME = 't';
process.env.GIT_AUTHOR_EMAIL = process.env.GIT_COMMITTER_EMAIL = 't@t';
fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
g(repo, ...ident, 'add', '.');
g(repo, ...ident, 'commit', '-q', '-m', '처음');
g(repo, 'push', '-q', '-u', 'origin', 'HEAD:main');

const gp = new GitPanel();

(async () => {
    // 저장소 아님
    const none = await gp.info(tmp);
    assert.strictEqual(none.isRepo, false);

    // 하위 폴더에서도 저장소 루트를 찾는다
    fs.mkdirSync(path.join(repo, 'sub'));
    fs.writeFileSync(path.join(repo, 'a.txt'), 'one\ntwo\n');
    fs.writeFileSync(path.join(repo, 'sub', 'new.txt'), 'new\n');
    let info = await gp.info(path.join(repo, 'sub'));
    assert.strictEqual(info.root, repo);
    assert.strictEqual(info.branch, 'main');
    assert.strictEqual(info.upstream, 'origin/main');
    assert.deepStrictEqual(info.changes.map(c => [c.label, c.path]).sort(), [['새 파일', 'sub/'], ['수정', 'a.txt']].sort());
    assert.strictEqual(info.log[0].subject, '처음');

    // diff: 수정 파일, 추적 전 새 파일
    assert.ok((await gp.diff(repo, 'a.txt')).diff.includes('+two'));
    assert.ok((await gp.diff(repo, 'sub/new.txt')).diff.startsWith('새 파일'));

    // 커밋 (모두) → ahead 1 → 푸시 → ahead 0
    await assert.rejects(gp.action(repo, { action: 'commit', message: '  ', all: true }), /메시지/);
    await gp.action(repo, { action: 'commit', message: '둘째 줄\n\n본문', all: true });
    info = await gp.info(repo);
    assert.strictEqual(info.changes.length, 0);
    assert.strictEqual(info.ahead, 1);
    assert.strictEqual(info.log[0].subject, '둘째 줄');
    await gp.action(repo, { action: 'push' });
    assert.strictEqual((await gp.info(repo)).ahead, 0);

    // 다른 클론에서 커밋 → 가져오기
    g(tmp, 'clone', '-q', bare, other);
    fs.writeFileSync(path.join(other, 'b.txt'), 'b\n');
    g(other, ...ident, 'add', '.'); g(other, ...ident, 'commit', '-q', '-m', '다른 곳'); g(other, 'push', '-q');
    await gp.action(repo, { action: 'pull' });
    assert.strictEqual((await gp.info(repo)).log[0].subject, '다른 곳');

    // 새 브랜치, 이름 검사, 모르는 작업
    await gp.action(repo, { action: 'branch', name: 'claude/test-1' });
    assert.strictEqual((await gp.info(repo)).branch, 'claude/test-1');
    await assert.rejects(gp.action(repo, { action: 'branch', name: 'a b' }), /이름/);
    await assert.rejects(gp.action(repo, { action: 'branch', name: 'a..b' }), /이름/);
    await assert.rejects(gp.action(repo, { action: 'reset' }), /모르는/);

    // 파싱
    assert.strictEqual(GitPanel.webUrl('git@github.com:avabag01-ai/flowcode.git'), 'https://github.com/avabag01-ai/flowcode');
    assert.strictEqual(GitPanel.webUrl('https://github.com/avabag01-ai/flowcode'), 'https://github.com/avabag01-ai/flowcode');
    assert.strictEqual(GitPanel.webUrl('/local/remote.git'), null);
    const st = GitPanel.parseStatus('## feat...origin/feat [ahead 2, behind 1]\0R  new.js\0old.js\0 M x.js\0');
    assert.deepStrictEqual([st.branch, st.upstream, st.ahead, st.behind], ['feat', 'origin/feat', 2, 1]);
    assert.deepStrictEqual(st.changes.map(c => [c.label, c.path, c.from || null]), [['이름 바꿈', 'new.js', 'old.js'], ['수정', 'x.js', null]]);

    // REST 응답 → 화면용
    assert.deepStrictEqual(GitPanel.prFromRest({ number: 5, title: 't', draft: true, head: { ref: 'b' }, html_url: 'u', user: { login: 'x' }, updated_at: 'd' }),
        { number: 5, title: 't', isDraft: true, headRefName: 'b', url: 'u', author: 'x', updatedAt: 'd' });
    await assert.rejects(gp.ghList(repo, 'prs'), /GitHub 저장소가 아니에요/, '로컬 원격이면 GitHub 아님');

    // gh 가 없을 때 알아듣게 (GitHub 원격처럼 보이게 바꿔서)
    g(repo, 'remote', 'set-url', 'origin', 'https://github.com/x/y.git');
    const noGh = new GitPanel({ ghBin: 'gh-does-not-exist' });
    await assert.rejects(noGh.ghList(repo, 'prs'), /gh\(GitHub CLI\)가 없어요/);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('GitPanel: 모든 테스트 통과');
})().catch(e => { console.error(e); process.exit(1); });
