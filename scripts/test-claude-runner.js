// ClaudeRunner 테스트: 가짜 claude 로 인자 전달, 스트림 파싱, 중지를 확인한다.
// 실행: node scripts/test-claude-runner.js
const assert = require('assert');
const os = require('os');
const path = require('path');
const ClaudeRunner = require('../src/core/ClaudeRunner.js');

const bin = path.join(__dirname, 'fake-claude.js');
const runner = new ClaudeRunner({ bin });
const run = req => new Promise(resolve => {
    const events = [];
    runner.run(req, e => events.push(e), exit => resolve({ events, exit }));
});

(async () => {
    const cwd = os.tmpdir();

    // 이어서 보내기: --resume, 권한 모드, 따옴표·공백 있는 메시지
    const msg = `"따옴표" 와 $HOME 그리고 'it's'`;
    const a = await run({ runId: 'r1', cwd, sessionId: 'abc-123', permissionMode: 'acceptEdits', text: msg });
    const init = a.events.find(e => e.subtype === 'init');
    assert.deepStrictEqual(init.args, ['-p', '--output-format', 'stream-json', '--verbose', '--resume', 'abc-123', '--permission-mode', 'acceptEdits', msg]);
    assert.strictEqual(init.cwd, require('fs').realpathSync(cwd));
    assert.strictEqual(a.events.find(e => e.type === 'assistant').message.content[0].text, `받았어: ${msg}`);
    const result = a.events.find(e => e.type === 'result');
    assert.ok(result, '줄바꿈 없이 끝난 마지막 줄도 이벤트로 받는다');
    assert.strictEqual(a.exit.code, 0);

    // 새 세션: --resume 없음, default 권한은 인자 없음
    const b = await run({ runId: 'r2', cwd, text: '안녕', permissionMode: 'default' });
    assert.deepStrictEqual(b.events.find(e => e.subtype === 'init').args, ['-p', '--output-format', 'stream-json', '--verbose', '안녕']);
    assert.strictEqual(b.events.find(e => e.type === 'result').session_id, 'new-session-0001');

    // 중지
    const c = run({ runId: 'r3', cwd, text: 'hang' });
    await new Promise(r => setTimeout(r, 300));
    assert.ok(runner.stop('r3'));
    const cr = await c;
    assert.strictEqual(cr.exit.stopped, true);
    assert.ok(!runner.stop('r3'), '끝난 실행은 다시 멈출 게 없다');

    // claude 가 없을 때: 알아듣게 알리고 한 번만 끝난다
    const missing = new ClaudeRunner({ bin: 'claude-does-not-exist' });
    const m = await new Promise(resolve => { const ev = []; let n = 0; missing.run({ runId: 'm', cwd, text: 'hi' }, e => ev.push(e), x => { n++; setTimeout(() => resolve({ ev, x, n }), 200); }); });
    assert.ok(m.ev.some(e => /찾지 못했어요/.test(e.text || '')));
    assert.strictEqual(m.n, 1);

    // 잘못된 입력
    assert.throws(() => runner.run({ runId: 'x', cwd, text: '  ' }, () => {}, () => {}), /비어/);
    assert.throws(() => runner.run({ runId: 'x', cwd: '/nope/nope', text: 'hi' }, () => {}, () => {}), /폴더가 없어요/);

    console.log('ClaudeRunner: 모든 테스트 통과');
})().catch(e => { console.error(e); process.exit(1); });
