// MachineSync + 세션 git 상태 테스트: 진짜 git 저장소(+ 빈 원격)와 가짜 공유 폴더로 확인한다.
// 실행: node scripts/test-machine-sync.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const SessionIndexer = require('../src/core/SessionIndexer.js');
const MachineSync = require('../src/core/MachineSync.js');

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'msync-')));
const NOW = Date.parse('2026-10-03T15:00:00Z');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } });

// 저장소: a.js(푸시됨) · b.js(커밋만) · c.js(미커밋) · d.js(새 파일, 추적 안 함)
const remote = path.join(tmp, 'remote.git');
const repo = path.join(tmp, 'app');
fs.mkdirSync(repo);
git(tmp, 'init', '-q', '--bare', remote);
git(repo, 'init', '-q', '-b', 'main');
for (const f of ['a.js', 'b.js', 'c.js']) fs.writeFileSync(path.join(repo, f), '1\n');
git(repo, 'add', '.');
git(repo, 'commit', '-q', '-m', 'first');
git(repo, 'remote', 'add', 'origin', remote);
git(repo, 'push', '-q', '-u', 'origin', 'main');
fs.writeFileSync(path.join(repo, 'b.js'), '2\n');
git(repo, 'commit', '-q', '-am', 'b');
fs.writeFileSync(path.join(repo, 'c.js'), '3\n');
fs.mkdirSync(path.join(repo, 'new'));
fs.writeFileSync(path.join(repo, 'new', 'd.js'), '4\n');

// 올릴 곳 없는 저장소
const lonely = path.join(tmp, 'lonely');
fs.mkdirSync(lonely);
git(lonely, 'init', '-q', '-b', 'main');
fs.writeFileSync(path.join(lonely, 'x.js'), '1\n');
git(lonely, 'add', '.');
git(lonely, 'commit', '-q', '-m', 'x');

const sess = (id, root, files, extra = {}) => ({
    id, title: id, cwd: root, gitBranch: 'main', firstAt: NOW - 3600e3, lastAt: NOW - 60e3, status: 'working', costUSD: 1,
    parentId: null, file: `/x/${id}.jsonl`, files: files.map(f => ({ path: path.join(root, f), rel: f, edits: 1 })), ...extra
});

(async () => {
    // --- git 상태 ---
    const st = await SessionIndexer.gitState(repo);
    assert.deepStrictEqual([...st.dirty].sort(), ['c.js', 'new/d.js'], '미커밋: 고친 파일 + 새 파일(폴더 안까지)');
    assert.deepStrictEqual([...st.ahead], ['b.js'], '푸시 전: @{u}..HEAD');
    assert.strictEqual(st.upstream, 'origin/main');
    assert.strictEqual(await SessionIndexer.gitState(tmp), null, 'git 저장소가 아니면 null');

    const index = {
        generatedAt: NOW,
        projects: [
            { root: repo, name: 'app', lastAt: NOW, hub: null, sessions: [
                sess('s-pushed', repo, ['a.js']),
                sess('s-ahead', repo, ['a.js', 'b.js']),
                sess('s-dirty', repo, ['b.js', 'new/d.js']),
                sess('s-none', repo, []),
                sess('s-outside', repo, ['../elsewhere.js'])
            ] },
            { root: lonely, name: 'lonely', lastAt: NOW - 1, hub: null, sessions: [sess('s-lonely', lonely, ['x.js'])] },
            { root: path.join(tmp, 'plain'), name: 'plain', lastAt: NOW - 2, hub: null, sessions: [sess('s-plain', path.join(tmp, 'plain'), ['y.js'])] }
        ]
    };
    await SessionIndexer.attachGit(index);
    const gitOf = id => index.projects.flatMap(p => p.sessions).find(s => s.id === id).git;
    assert.strictEqual(gitOf('s-pushed'), 'pushed');
    assert.strictEqual(gitOf('s-ahead'), 'ahead');
    assert.strictEqual(gitOf('s-dirty'), 'dirty', '미커밋이 푸시 전보다 먼저');
    assert.strictEqual(gitOf('s-none'), null, '고친 파일이 없으면 표시 안 함');
    assert.strictEqual(gitOf('s-outside'), null, '저장소 밖 파일만 고쳤으면 표시 안 함');
    assert.strictEqual(gitOf('s-lonely'), 'ahead', '올릴 곳이 없으면 커밋해도 이 기기에만 있음');
    assert.strictEqual(gitOf('s-plain'), null, 'git 아닌 폴더');

    // upstream 없는 새 브랜치: main 에 이미 올라간 것은 푸시됨, 새 브랜치에서 커밋한 것만 푸시 전
    git(repo, 'stash', '-u', '-q');
    git(repo, 'push', '-q', 'origin', 'main');
    git(repo, 'checkout', '-q', '-b', 'feature');
    fs.writeFileSync(path.join(repo, 'a.js'), '5\n');
    git(repo, 'commit', '-q', '-am', 'feature a');
    const st3 = await SessionIndexer.gitState(repo);
    assert.strictEqual(st3.upstream, null);
    assert.deepStrictEqual([...st3.ahead], ['a.js'], 'upstream 없으면 원격 브랜치에 없는 커밋만');
    git(repo, 'checkout', '-q', 'main');
    git(repo, 'stash', 'pop', '-q');

    // 이름 바꾸기도 미커밋으로
    git(repo, 'mv', 'a.js', 'a2.js');
    const st2 = await SessionIndexer.gitState(repo);
    assert.ok(st2.dirty.has('a.js') && st2.dirty.has('a2.js'), '이름 바꾼 파일: 옛 이름·새 이름 모두');
    git(repo, 'mv', 'a2.js', 'a.js');

    // --- 기기 이름 ---
    assert.strictEqual(MachineSync.shortModel('MacBook Pro'), 'MacBook');
    assert.strictEqual(MachineSync.shortModel('Mac mini'), 'Mac mini');
    assert.strictEqual(MachineSync.shortModel('Mac Studio'), 'Mac Studio');
    assert.strictEqual(MachineSync.shortModel(''), '');
    const settingsDir = path.join(tmp, 'flowcode');
    fs.mkdirSync(settingsDir);
    fs.writeFileSync(path.join(settingsDir, 'machine.json'), JSON.stringify({ name: 'Mac mini' }));
    assert.strictEqual(new MachineSync({ settingsDir, platform: 'linux' }).name(), 'Mac mini', 'machine.json 이 먼저');
    assert.ok(new MachineSync({ settingsDir: path.join(tmp, 'none'), platform: 'linux' }).name(), '없으면 호스트 이름');

    // --- 공유 폴더 없음 ---
    const noDir = new MachineSync({ name: 'Mac mini', dir: null });
    assert.deepStrictEqual(noDir.publish(index), { ok: false, reason: 'no-dir' });
    assert.deepStrictEqual(noDir.readOthers(), []);

    // --- 두 기기가 같은 공유 폴더에 ---
    const dir = path.join(tmp, 'icloud', 'FlowCode');
    const mini = new MachineSync({ name: 'Mac mini', dir, now: () => NOW });
    const book = new MachineSync({ name: 'MacBook', dir, now: () => NOW });
    assert.ok(mini.publish(index).ok);
    const written = JSON.parse(fs.readFileSync(path.join(dir, 'machines', 'Mac mini.json'), 'utf8'));
    assert.strictEqual(written.machine, 'Mac mini');
    const w = written.projects[0].sessions.find(s => s.id === 's-dirty');
    assert.strictEqual(w.git, 'dirty', 'git 상태도 같이 쓴다');
    assert.strictEqual(w.file, undefined, '기록 파일 경로(대화 내용)는 쓰지 않는다');

    // 맥북: 같은 저장소의 세션 하나(s-ahead 와 같은 id) + 맥북에만 있는 폴더
    const bookIndex = {
        generatedAt: NOW,
        projects: [
            { root: repo, name: 'app', lastAt: NOW - 5000, hub: null, sessions: [sess('s-ahead', repo, ['b.js'], { lastAt: NOW - 5000 }), sess('s-book', repo, ['c.js'], { lastAt: NOW - 2 * 864e5, git: 'dirty' })] },
            { root: '/Users/kim/only-book', name: 'only-book', lastAt: NOW - 100, hub: null, sessions: [sess('s-far', '/Users/kim/only-book', [], { lastAt: NOW - 100 })] }
        ]
    };
    assert.ok(book.publish(bookIndex).ok);
    // 오래된 기기·깨진 파일은 건너뛴다
    fs.writeFileSync(path.join(dir, 'machines', 'iMac.json'), JSON.stringify({ machine: 'iMac', generatedAt: NOW - 40 * 864e5, projects: [] }));
    fs.writeFileSync(path.join(dir, 'machines', 'broken.json'), '{ 쓰는 중');

    const others = mini.readOthers();
    assert.deepStrictEqual(others.map(o => o.machine), ['MacBook'], '나 자신·오래된 기기·깨진 파일은 빼고');

    const merged = MachineSync.merge(index, others, NOW);
    assert.deepStrictEqual(merged.machines, ['MacBook']);
    const app = merged.projects.find(p => p.root === repo);
    const ids = app.sessions.map(s => s.id);
    assert.strictEqual(ids.filter(id => id === 's-ahead').length, 1, '같은 세션 id 는 한 번만');
    assert.ok(!app.sessions.find(s => s.id === 's-ahead').remote, '이 기기에 있으면 이 기기 것');
    const far = app.sessions.find(s => s.id === 's-book');
    assert.strictEqual(far.remote, true);
    assert.strictEqual(far.machine, 'MacBook');
    assert.strictEqual(far.file, null, '다른 기기 세션은 대화 파일 없음');
    assert.strictEqual(far.git, 'dirty');
    assert.strictEqual(far.status, 'idle', '상태는 시각으로 다시 계산');
    const only = merged.projects.find(p => p.root === '/Users/kim/only-book');
    assert.ok(only && only.remoteOnly, '다른 기기에만 있는 폴더는 remoteOnly');
    assert.strictEqual(only.sessions[0].status, 'working');
    assert.deepStrictEqual(merged.projects.map(p => p.lastAt), merged.projects.map(p => p.lastAt).sort((a, b) => b - a), '최근 순으로 섞인다');
    assert.strictEqual(index.projects[0].sessions.some(s => s.remote), false, '원래 목록은 그대로');

    // 다시 publish 해도 다른 기기 세션은 내 파일에 들어가지 않는다
    mini.publish(merged);
    const again = JSON.parse(fs.readFileSync(path.join(dir, 'machines', 'Mac mini.json'), 'utf8'));
    assert.ok(!again.projects.some(p => p.sessions.some(s => s.id === 's-book' || s.id === 's-far')), '남의 세션은 다시 쓰지 않는다');

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('MachineSync: 모든 테스트 통과');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
