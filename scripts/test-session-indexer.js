// SessionIndexer 테스트: 가짜 ~/.claude 를 만들어 읽어 본다.
// 실행: node scripts/test-session-indexer.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const SessionIndexer = require('../src/core/SessionIndexer.js');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'smm-'));
const claudeDir = path.join(tmp, '.claude');
const repo = path.join(tmp, 'logic-pro-mcp');
const NOW = Date.parse('2026-10-03T15:00:00Z');

// git 저장소 + 툰 허브
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });
fs.mkdirSync(path.join(repo, '.toon', 'logic-ax'), { recursive: true });
fs.writeFileSync(path.join(repo, '.toon', 'HUB.toon'), 'GOAL: x\nNEXT 000000 AMT 후보 3개 듣기\nNEXT 000001 MLX 검토\nother\n');
fs.writeFileSync(path.join(repo, '.toon', 'logic-ax', 'HUB.toon'), 'topic\n');

const line = o => JSON.stringify(o) + '\n';
const user = (ts, cwd, text) => line({ type: 'user', timestamp: ts, cwd, gitBranch: 'main', sessionId: 'x', message: { role: 'user', content: text } });
const edit = (ts, name, p) => line({ type: 'assistant', timestamp: ts, message: { role: 'assistant', content: [{ type: 'tool_use', name, input: { file_path: p } }] } });

// 답의 사용량 (sidechain = 하위 에이전트, 세지 않음)
const usage = (ts, u, sidechain) => line({ type: 'assistant', timestamp: ts, isSidechain: !!sidechain, message: { model: 'claude-x', role: 'assistant', content: [{ type: 'text', text: '"input_tokens":7' }], usage: u } });

function writeSession(dirName, id, body) {
    const dir = path.join(claudeDir, 'projects', dirName);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, id + '.jsonl'), body);
}

// 세션 A: 저장소 하위 폴더에서 작업, 파일 3개(하나는 두 번), 제목·비용 있음, 5분 전
const sub = path.join(repo, '.local-tools', 'amt');
writeSession('-logic-pro-mcp', 'sess-a',
    user('2026-10-03T14:00:00Z', sub, 'AMT 빠르게 해줘') +
    edit('2026-10-03T14:10:00Z', 'Edit', path.join(sub, 'fast_sample.py')) +
    edit('2026-10-03T14:20:00Z', 'Edit', path.join(sub, 'fast_sample.py')) +
    edit('2026-10-03T14:30:00Z', 'Write', path.join(sub, 'batch_sample.py')) +
    edit('2026-10-03T14:40:00Z', 'Read', path.join(sub, 'ignored.py')) +
    line({ type: 'ai-title', aiTitle: 'AMT 반주 최적화', sessionId: 'sess-a' }) +
    line({ type: 'cost-state', totalCostUSD: 3.24 }) +
    usage('2026-10-03T14:44:00Z', { input_tokens: 5, cache_creation_input_tokens: 1000, cache_read_input_tokens: 50000, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 1000 } }) +
    usage('2026-10-03T14:45:00Z', { input_tokens: 3, cache_creation_input_tokens: 0, cache_read_input_tokens: 90000 }) +
    usage('2026-10-03T14:46:00Z', { input_tokens: 999999, cache_read_input_tokens: 1 }, true) +
    'not json\n' +
    edit('2026-10-03T14:55:00Z', 'NotebookEdit', path.join(repo, 'nb.ipynb')).replace('file_path', 'notebook_path'));

// 세션 B: 같은 저장소, 같은 파일을 고침, 제목 없음 → 첫 프롬프트, 2일 전
writeSession('-logic-pro-mcp', 'sess-b',
    user('2026-10-01T10:00:00Z', repo, [{ type: 'text', text: '툰 불러와 logic-pro-mcp' }]) +
    edit('2026-10-01T10:05:00Z', 'MultiEdit', path.join(sub, 'fast_sample.py')));

// 세션 C: git 아닌 폴더, 파일 없음, 3시간 전
writeSession('-notes', 'sess-c', user('2026-10-03T12:00:00Z', path.join(tmp, 'notes'), '메모'));

// 빈 기록, 대화 없는 기록은 무시
writeSession('-empty', 'sess-empty', '');
writeSession('-empty', 'sess-meta', line({ type: 'mode', mode: 'normal' }));

(async () => {
    const indexer = new SessionIndexer({ claudeDir, now: () => NOW });
    const r = await indexer.index();

    assert.strictEqual(r.projects.length, 2, '프로젝트 2개 (git 루트로 묶임 + git 아닌 폴더)');
    const p = r.projects[0];
    assert.strictEqual(p.root, repo, '하위 폴더 세션도 git 루트로 묶인다');
    assert.strictEqual(p.name, 'logic-pro-mcp');
    assert.deepStrictEqual(p.sessions.map(s => s.id), ['sess-a', 'sess-b'], '최근 세션이 먼저');

    const a = p.sessions[0];
    assert.strictEqual(a.title, 'AMT 반주 최적화');
    assert.strictEqual(a.costUSD, 3.24);
    assert.strictEqual(a.gitBranch, 'main');
    assert.strictEqual(a.status, 'working', '5분 전이면 작업 중');
    assert.deepStrictEqual(a.files.map(f => [f.rel, f.edits]), [
        ['.local-tools/amt/fast_sample.py', 2],
        ['.local-tools/amt/batch_sample.py', 1],
        ['nb.ipynb', 1]
    ], 'Edit/Write/NotebookEdit 만 세고, Read 는 뺀다');

    assert.deepStrictEqual({ ...a.context, at: 0 }, { tokens: 90003, model: 'claude-x', ttl: '1h', at: 0 },
        '세션 분량 = 마지막 답의 입력 + 캐시 만든 것 + 캐시 읽은 것, 하위 에이전트·글 속 숫자는 무시, 캐시 종류는 앞에서 이어받음');

    const b = p.sessions[1];
    assert.strictEqual(b.context, null, '사용량 없는 기록');
    assert.strictEqual(b.title, '툰 불러와 logic-pro-mcp', '제목이 없으면 첫 프롬프트');
    assert.strictEqual(b.status, 'idle');
    assert.strictEqual(b.files[0].rel, '.local-tools/amt/fast_sample.py');

    assert.deepStrictEqual(p.hub.next, ['NEXT 000000 AMT 후보 3개 듣기', 'NEXT 000001 MLX 검토']);
    assert.deepStrictEqual(p.hub.topics, ['logic-ax']);

    const c = r.projects[1];
    assert.strictEqual(c.sessions[0].status, 'recent', '3시간 전이면 최근');
    assert.strictEqual(c.hub, null);

    // 캐시: 파일이 그대로면 같은 결과, 바뀌면 다시 읽는다
    const again = await indexer.index();
    assert.deepStrictEqual(again.projects[0].sessions[0].files, r.projects[0].sessions[0].files);
    fs.appendFileSync(path.join(claudeDir, 'projects', '-logic-pro-mcp', 'sess-b.jsonl'),
        edit('2026-10-03T14:59:00Z', 'Edit', path.join(repo, 'new.py')));
    const third = await indexer.index();
    const b3 = third.projects[0].sessions.find(s => s.id === 'sess-b');
    assert.ok(b3.files.some(f => f.rel === 'new.py'), '바뀐 기록은 다시 읽는다');
    assert.strictEqual(b3.status, 'working');

    // 대화창용 기록 읽기
    assert.ok(a.file.endsWith('sess-a.jsonl'), '세션에 기록 파일 경로가 있다');
    const tfile = path.join(claudeDir, 'projects', '-chat', 'sess-t.jsonl');
    fs.mkdirSync(path.dirname(tfile), { recursive: true });
    fs.writeFileSync(tfile,
        user('2026-10-03T10:00:00Z', repo, '첫 질문') +
        line({ type: 'user', timestamp: '2026-10-03T10:00:01Z', isMeta: true, message: { content: '메타' } }) +
        line({ type: 'user', timestamp: '2026-10-03T10:00:02Z', message: { content: '<command-name>/clear</command-name>' } }) +
        line({ type: 'assistant', timestamp: '2026-10-03T10:00:03Z', message: { content: [{ type: 'text', text: '보고 있어' }] } }) +
        line({ type: 'assistant', timestamp: '2026-10-03T10:00:04Z', message: { content: [{ type: 'tool_use', name: 'Bash', input: { command: 'ls -la' } }] } }) +
        line({ type: 'user', timestamp: '2026-10-03T10:00:05Z', message: { content: [{ type: 'tool_result', content: 'x' }] } }) +
        line({ type: 'assistant', timestamp: '2026-10-03T10:00:06Z', message: { content: [{ type: 'text', text: '끝' }] } }) +
        line({ type: 'assistant', timestamp: '2026-10-03T10:00:07Z', isSidechain: true, message: { content: [{ type: 'text', text: '하위 에이전트' }] } }) +
        user('2026-10-03T10:01:00Z', repo, [{ type: 'text', text: '두 번째' }]));
    const t = await SessionIndexer.readTranscript(tfile);
    assert.deepStrictEqual(t.messages.map(m => [m.role, m.text, m.tools.map(x => x.name + ':' + x.target)]), [
        ['user', '첫 질문', []],
        ['assistant', '보고 있어\n\n끝', ['Bash:ls -la']],
        ['user', '두 번째', []]
    ], '메타·명령·도구 결과·하위 에이전트는 빼고, 이어진 assistant 는 합친다');
    const t2 = await SessionIndexer.readTranscript(tfile, { limit: 2 });
    assert.strictEqual(t2.truncated, true);
    assert.strictEqual(t2.messages[0].role, 'assistant');

    // 세션 묶기 / 복사
    const linksFile = path.join(tmp, 'links.json');
    const ix = new SessionIndexer({ claudeDir, linksFile, now: () => NOW });
    await ix.index();
    ix.setParent(repo, 'sess-b', 'sess-a');
    let r2 = await ix.index();
    let pr = r2.projects.find(x => x.root === repo);
    assert.strictEqual(pr.sessions.find(x => x.id === 'sess-b').parentId, 'sess-a', '같은 폴더 세션 아래로 붙는다');
    assert.strictEqual(pr.sessions.find(x => x.id === 'sess-a').parentId, null);
    assert.throws(() => ix.setParent(repo, 'sess-a', 'sess-b'), /하위 세션/, '돌고 도는 묶기는 막는다');
    assert.throws(() => ix.setParent(repo, 'sess-a', 'nope'), /같은 폴더/);
    ix.setParent(repo, 'sess-b', null);
    r2 = await ix.index();
    assert.strictEqual(r2.projects.find(x => x.root === repo).sessions.find(x => x.id === 'sess-b').parentId, null, '떼어낼 수 있다');

    // 주제 가지 · 줄기
    assert.strictEqual(SessionIndexer.topicOf('툰 불러와 — 하위 세션, root: /a, topic: logic-ax, hub_task: x'), 'logic-ax');
    assert.strictEqual(SessionIndexer.topicOf('그냥 질문'), null);
    assert.strictEqual(pr.sessions.find(x => x.id === 'sess-b').topic, null, '첫 메시지에 topic 없음');
    ix.setMeta(repo, 'sess-a', { prevId: 'sess-b', topic: 'logic-ax' });
    r2 = await ix.index();
    pr = r2.projects.find(x => x.root === repo);
    const sa = pr.sessions.find(x => x.id === 'sess-a');
    assert.strictEqual(sa.prevId, 'sess-b', '툰 이어가기 줄기');
    assert.strictEqual(sa.topic, 'logic-ax', '정한 주제');
    assert.deepStrictEqual(pr.hub.titles, { 'logic-ax': 'logic-ax' }, 'title: 이 없으면 폴더 이름');
    assert.throws(() => ix.setMeta(repo, 'sess-b', { prevId: 'sess-a' }), /돌고 도는/);
    assert.throws(() => ix.setMeta(repo, 'sess-a', { topic: '눈 귀' }), /주제 이름/);
    ix.setMeta(repo, 'sess-a', { prevId: null, topic: null });
    r2 = await ix.index();
    const sa2 = r2.projects.find(x => x.root === repo).sessions.find(x => x.id === 'sess-a');
    assert.strictEqual(sa2.prevId, null);
    assert.strictEqual(sa2.topic, null, 'null 로 정하면 첫 메시지 주제도 안 쓴다');
    fs.writeFileSync(path.join(repo, '.toon', 'logic-ax', 'HUB.toon'), '## TOPIC_HUB\ntopic: logic-ax\ntitle: 로직 AX\n');
    assert.deepStrictEqual(SessionIndexer.readHub(repo).titles, { 'logic-ax': '로직 AX' }, '화면 이름은 title:');

    // 세션 종류: 코드 파일을 고쳤으면 code, 문서·툰만이면 chat, 정해 두면 그대로
    assert.strictEqual(SessionIndexer.kindOf([{ path: '/a/b.js' }]), 'code');
    assert.strictEqual(SessionIndexer.kindOf([{ path: '/a/README.md' }, { path: '/a/.toon/x/HUB.toon' }]), 'chat');
    assert.strictEqual(SessionIndexer.kindOf([]), 'chat');
    assert.strictEqual(pr.sessions.find(x => x.id === 'sess-a').kind, 'code');
    ix.setMeta(repo, 'sess-a', { kind: 'chat' });
    r2 = await ix.index();
    assert.strictEqual(r2.projects.find(x => x.root === repo).sessions.find(x => x.id === 'sess-a').kind, 'chat', '정해 둔 종류');
    assert.throws(() => ix.setMeta(repo, 'sess-a', { kind: 'music' }), /종류/);
    ix.setMeta(repo, 'sess-a', { kind: null });

    const other = path.join(tmp, 'other');
    fs.mkdirSync(other);
    const copied = ix.copySession(repo, 'sess-a', other);
    assert.ok(copied.file.includes(path.join('projects', SessionIndexer.encodeCwd(other))), '새 폴더의 기록 폴더에 쓴다');
    const lines = fs.readFileSync(copied.file, 'utf8').split('\n').filter(Boolean);
    const parsed = lines.filter(l => l.startsWith('{')).map(l => JSON.parse(l));
    assert.ok(parsed.filter(d => d.sessionId).every(d => d.sessionId === copied.id), 'sessionId 를 새 id 로');
    assert.ok(parsed.filter(d => d.cwd).every(d => d.cwd.startsWith(other)), 'cwd 를 새 폴더로');
    assert.ok(lines.includes('not json'), 'JSON 아닌 줄은 그대로');
    assert.ok(fs.existsSync(path.join(claudeDir, 'projects', '-logic-pro-mcp', 'sess-a.jsonl')), '원본은 그대로');
    assert.strictEqual(SessionIndexer.encodeCwd('/home/user/a.b_c'), '-home-user-a-b-c');

    // ~/.claude 가 없어도 빈 결과
    const none = await new SessionIndexer({ claudeDir: path.join(tmp, 'nope') }).index();
    assert.deepStrictEqual(none.projects, []);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('SessionIndexer: 모든 테스트 통과');
})().catch(e => {
    console.error(e);
    process.exit(1);
});
