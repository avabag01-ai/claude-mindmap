// SessionHub.nextPrompt 테스트: 툰 저장 답에서 새 세션 시작 메시지 뽑기
// 실행: node scripts/test-session-hub.js
const assert = require('assert');
global.SessionMindMap = { _defaultIpc: () => null };
const SessionHub = require('../src/modules/SessionHub.js');

const fb = '툰 불러와 — root: /x';
const cases = [
    ['저장했어요.\n```toon-next\n툰 불러와 — 하위 세션, root: /a, hub_task: NEXT 1\n```', '툰 불러와 — 하위 세션, root: /a, hub_task: NEXT 1'],
    ['```\n다른 코드\n```\n시작 메시지:\n```\n툰 불러와 — root: /b\n```\n끝', '툰 불러와 — root: /b'],
    ['```js\nconst a = 1\n```\n다음엔 `툰 불러와 — root: /c` 로 시작하세요', '툰 불러와 — root: /c'],
    ['저장 완료\n툰 불러와 — root: /d, topic: x', '툰 불러와 — root: /d, topic: x'],
    ['아무것도 없음', fb],
    ['', fb]
];
for (const [text, want] of cases) assert.strictEqual(SessionHub.nextPrompt(text, fb), want, text);
assert.ok(SessionHub.TOON_SAVE_TEXT.includes('toon-next'));
assert.strictEqual(SessionHub.toonStartPrompt('/a/b', '', 'MLX 이식'), 'MLX 이식 — 툰 불러와 — 하위 세션, root: /a/b, hub_task: MLX 이식');
assert.strictEqual(SessionHub.toonStartPrompt('/a/b', 'logic-ax', 'AMT 후보 듣기'), 'AMT 후보 듣기 — 툰 불러와 — 하위 세션, root: /a/b, topic: logic-ax, hub_task: AMT 후보 듣기');
// 시작 메시지 맨 앞 제목: hub_task 에서, 없으면 넘긴 제목, 이미 있으면 그대로
assert.strictEqual(SessionHub.withTitle('툰 불러와 — 하위 세션, root: /a, hub_task: NEXT 000008b GitHub 맵 손 시험', 'x'), 'GitHub 맵 손 시험 — 툰 불러와 — 하위 세션, root: /a, hub_task: NEXT 000008b GitHub 맵 손 시험');
assert.strictEqual(SessionHub.withTitle('툰 불러와 — root: /a/b', 'b 이어서'), 'b 이어서 — 툰 불러와 — root: /a/b');
assert.strictEqual(SessionHub.mainRoot('/u/m/.claude/worktrees/relaxed-leakey-15bb94'), '/u/m', '다른 세션 워크트리 → 원래 저장소');
assert.strictEqual(SessionHub.mainRoot('/u/m/.claude/worktrees/x/'), '/u/m');
assert.strictEqual(SessionHub.mainRoot('/u/m'), '/u/m');
assert.strictEqual(SessionHub.withGroup('a — 툰 불러와', null), 'a — 툰 불러와');
assert.ok(SessionHub.withGroup('a — 툰 불러와', { id: 'cg-1', name: '클로드마인드맵' }).endsWith('move_sessions(session_ids ["self"], group_id "cg-1") 로 이 세션을 클로드 앱 그룹 "클로드마인드맵" 에 넣어줘.'));
assert.ok(SessionHub.withGroup('a', { id: 'cg-1', name: 'g' }, '/u/m').endsWith('넣어줘. 작업 폴더가 /u/m 가 아니면 mcp__ccd_directory__change_directory(path "/u/m") 로 먼저 옮겨줘.'));
assert.strictEqual(SessionHub.withGroup('a', null, '/u/m'), 'a\n\n작업 폴더가 /u/m 가 아니면 mcp__ccd_directory__change_directory(path "/u/m") 로 먼저 옮겨줘.');
assert.strictEqual(SessionHub.inApp({ ok: true, sessions: { s1: { archived: false } } }, 's1'), true, '앱 세션');
assert.strictEqual(SessionHub.inApp({ ok: true, sessions: { s1: { archived: true } } }, 's1'), false, '보관한 앱 세션은 여기서');
assert.strictEqual(SessionHub.inApp({ ok: true, sessions: {} }, 's1'), false, '앱 밖 세션은 여기서');
assert.strictEqual(SessionHub.inApp({ ok: true, sessions: { s1: { adopted: true } } }, 's1'), false, '마인드맵에서 만들어 앱에 들여온 세션은 여기서');
assert.strictEqual(SessionHub.inApp(null, 's1'), false);
const CA = require('../src/core/ClaudeApp.js');
assert.strictEqual(CA.newSessionUrl('/Users/kim/a b', '툰 — x&y'), 'claude://code/new?folder=%2FUsers%2Fkim%2Fa%20b&q=%ED%88%B0%20%E2%80%94%20x%26y', 'Rust 와 같은 주소');
assert.strictEqual(SessionHub.withTitle('맵 고치기 — 툰 불러와 — root: /a', 'x'), '맵 고치기 — 툰 불러와 — root: /a');
assert.ok(SessionHub.withTitle('툰 불러와 — hub_task: ' + '가'.repeat(50), '').startsWith('가'.repeat(29) + '… — 툰'));
assert.strictEqual(SessionHub.nextPrompt('다음엔 `맵 — 툰 불러와 — root: /c` 로', fb), '맵 — 툰 불러와 — root: /c');
assert.strictEqual(SessionHub.nextPrompt('저장 완료\n맵 — 툰 불러와 — root: /d', fb), '맵 — 툰 불러와 — root: /d');
assert.strictEqual(SessionHub.withAttachments('봐줘', []), '봐줘');
assert.strictEqual(SessionHub.withAttachments('이거 고쳐', ['/a/b.js', '/c d/e.png']), '이거 고쳐\n\n첨부 파일:\n- /a/b.js\n- /c d/e.png');
assert.strictEqual(SessionHub.withAttachments('', ['/a.js']), '첨부한 파일을 봐줘.\n\n첨부 파일:\n- /a.js');
const { HubBrowser } = require('../src/modules/HubPanels.js');
const rp = HubBrowser.readPrompt({ title: '제목', url: 'https://a.b', text: 'x'.repeat(30) }, 10);
assert.ok(rp.includes('툰 형식') && rp.includes('[페이지] 제목\nhttps://a.b') && rp.includes('xxxxxxxxxx\n…(뒤는 잘렸어요)'));
assert.ok(HubBrowser.looksLikeUrl('github.com/a') && !HubBrowser.looksLikeUrl('맥미니 램'));
// 답 길이 표시: 보낸 시각에 가까운 사람 메시지 뒤의 답에 붙는다
const T = 1e12;
const msgs = [
    { role: 'user', at: T + 1000 }, { role: 'assistant', at: T + 5000 }, { role: 'assistant', at: T + 9000 },
    { role: 'user', at: T + 600000 }, { role: 'assistant', at: T + 601000 },
    { role: 'user', at: T + 900000 }, { role: 'assistant', at: T + 901000 }
];
const log = [{ at: T, mode: 'result' }, { at: T + 599000, mode: 'detail' }];
assert.deepStrictEqual(SessionHub.answerModes(msgs, log), [null, 'result', 'result', null, 'detail', null, null], '터미널에서 보낸 것(기록 없음)은 표시 없음');
assert.deepStrictEqual(SessionHub.answerModes(msgs, undefined), msgs.map(() => null));
assert.deepStrictEqual(SessionHub.ANSWER_MODES, ['result', 'summary', 'detail']);
// 캐시 타이머: 마지막 메시지 기준 55분부터 깜박, 1시간 넘으면 지남
const SMM = require('../src/modules/SessionMindMap.js');
const M = 60e3;
assert.deepStrictEqual(SMM.cachePhase(T, T + 30 * M), { phase: 'ok', left: 30 * M });
assert.strictEqual(SMM.cachePhase(T, T + 54 * M).phase, 'ok');
assert.strictEqual(SMM.cachePhase(T, T + 55 * M).phase, 'soon');
assert.strictEqual(SMM.cachePhase(T, T + 59.9 * M).phase, 'soon');
assert.strictEqual(SMM.cachePhase(T, T + 60 * M).phase, 'over');
// 세션 분량과 툰 알람
const ses = (tokens, lastAt, ttl) => ({ lastAt, context: tokens ? { tokens, ttl } : null });
assert.strictEqual(SMM.contextInfo(ses(0, T)), null);
assert.deepStrictEqual(SMM.contextInfo(ses(100e3, T)), { tokens: 100e3, window: 200e3, pct: 0.5, phase: 'ok' });
assert.strictEqual(SMM.contextInfo(ses(130e3, T)).phase, 'warn');
assert.strictEqual(SMM.contextInfo(ses(170e3, T)).phase, 'full');
assert.strictEqual(SMM.contextInfo(ses(250e3, T)).window, 1e6, '20만을 넘으면 100만 창');
// 모델 이름으로 창 크기: Claude 5 계열·[1m] 은 100만
assert.strictEqual(SMM.contextWindow('claude-opus-5-5', 114e3), 1e6);
assert.strictEqual(SMM.contextWindow('claude-sonnet-5-5', 50e3), 1e6);
assert.strictEqual(SMM.contextWindow('claude-sonnet-4-5[1m]', 50e3), 1e6);
assert.strictEqual(SMM.contextWindow('claude-haiku-4-5-20251001', 114e3), 200e3);
assert.strictEqual(SMM.contextWindow('', 114e3), 200e3);
{
    const big = ses(114e3, T);
    big.context.model = 'claude-opus-5-5';
    assert.strictEqual(SMM.contextInfo(big).phase, 'ok', '100만 창에서 11만은 여유');
}
assert.strictEqual(SMM.alarm(ses(170e3, T), T), 'full', '80% 넘으면 바로 깜박');
assert.strictEqual(SMM.alarm(ses(110e3, T), T + 56 * M), 'cache', '큰 세션 + 캐시 곧 끝남');
assert.strictEqual(SMM.alarm(ses(40e3, T), T + 56 * M), null, '작은 세션은 캐시가 끝나도 괜찮다');
assert.strictEqual(SMM.alarm(ses(110e3, T), T + 30 * M), null);
assert.strictEqual(SMM.alarm(ses(110e3, T, '5m'), T + 4.5 * M), 'cache', '5분 캐시면 1분 전부터');
assert.strictEqual(SMM.alarm({ ...ses(170e3, T), remote: true }, T), null, '다른 기기 세션은 알람 없음');
// 줄기: 툰 이어가기로 이어진 세션은 맨 끝만 그리고 앞은 접는다
const ch = SMM.chains([{ id: 'a' }, { id: 'b', prevId: 'a' }, { id: 'c', prevId: 'b' }, { id: 'x' }, { id: 'y', prevId: 'gone' }]);
assert.deepStrictEqual([...ch.heads.keys()].sort(), ['c', 'x', 'y'], '맨 끝 세션만 (지워진 앞 세션은 무시)');
assert.deepStrictEqual(ch.heads.get('c').map(s => s.id), ['a', 'b'], '앞 세션은 오래된 것부터');
assert.strictEqual(ch.headOf.get('a'), 'c');
assert.strictEqual(SessionHub.topicOf('툰 불러와 — root: /a, topic: mindmap, hub_task: x'), 'mindmap');
// 왼쪽 목록 묶기: 가지 → 줄기 맨 끝(이전 N) → 하위 세션, 빈 가지는 따로
global.SessionMindMap.chains = SMM.chains;
const ss = (id, lastAt, extra = {}) => ({ id, lastAt, ...extra });
const lp = { root: '/r', hub: { topics: ['eye', 'ear'], titles: { eye: '눈', ear: '귀' } } };
const lsess = [
    ss('e1', 1, { topic: 'eye' }), ss('e2', 2, { topic: 'eye', prevId: 'e1' }), ss('e3', 3, { topic: 'eye', prevId: 'e2' }),
    ss('k', 4, { topic: 'eye', parentId: 'e1' }), ss('loose', 5), ss('other', 6, { topic: 'hand' })
];
let lt = SessionHub.listTree(lp, lsess);
assert.deepStrictEqual(lt.branches.map(b => [b.topic, b.title, b.rows.map(r => [r.s.id, r.depth, r.prevCount, r.isPrev])]), [
    ['hand', 'hand', [['other', 1, 0, false]]],
    ['eye', '눈', [['e3', 1, 2, false], ['k', 2, 0, false]]]
], '줄기 앞 세션은 접고, 접힌 세션의 하위 세션은 맨 끝 아래로, 최근 가지 먼저');
assert.deepStrictEqual(lt.empty, [{ topic: 'ear', title: '귀' }]);
assert.deepStrictEqual(lt.loose.map(r => r.s.id), ['loose']);
lt = SessionHub.listTree(lp, lsess, new Set(['/r::e3']), true);
assert.deepStrictEqual(lt.branches.find(b => b.topic === 'eye').rows.map(r => [r.s.id, r.isPrev]), [['e3', false], ['e2', true], ['e1', true], ['k', false]], '펼치면 최근 앞 세션부터');
assert.deepStrictEqual(lt.empty, [], '검색 중에는 빈 가지 숨김');
// 끝난 실행이 기록에 들어오면 실시간 칸을 뺀다 (같은 답 두 번 안 보이게)
{
    const run = { done: true, sentAt: T, events: [{ type: 'assistant' }] };
    const recorded = [{ role: 'user', at: T - 60000 }, { role: 'assistant', at: T - 50000 }, { role: 'user', at: T + 800 }, { role: 'assistant', at: T + 5000 }];
    assert.strictEqual(SessionHub.runRecorded(run, recorded), true);
    assert.strictEqual(SessionHub.runRecorded(run, recorded.slice(0, 3)), false, '답이 아직 기록에 없음');
    assert.strictEqual(SessionHub.runRecorded(run, recorded.slice(0, 2)), false, '보낸 메시지가 아직 기록에 없음');
    assert.strictEqual(SessionHub.runRecorded({ ...run, done: false }, recorded), false, '실행 중');
    assert.strictEqual(SessionHub.runRecorded({ ...run, events: [{ type: 'stderr', text: 'API Error' }] }, recorded), false, '오류는 남김');
}
// 겹침 풀기: 겹친 두 노드는 떨어지고, 고정 노드(가운데·끌어다 놓은 노드)는 안 움직인다
{
    const box = [-50, 50, -15, 15];
    const fixed = { x: 0, y: 0, fixed: true }, a = { x: 10, y: 5 }, b = { x: 20, y: 8 };
    const left = SMM.spread([{ n: fixed, box }, { n: a, box }, { n: b, box }]);
    assert.strictEqual(left, 0, '겹침이 다 풀림');
    assert.deepStrictEqual([fixed.x, fixed.y], [0, 0], '고정 노드는 그대로');
    const apart = (p, q) => Math.abs(p.x - q.x) >= 100 || Math.abs(p.y - q.y) >= 30;
    assert.ok(apart(fixed, a) && apart(fixed, b) && apart(a, b));
    const far = { x: 500, y: 0 };
    SMM.spread([{ n: { x: 0, y: 0 }, box }, { n: far, box }]);
    assert.deepStrictEqual([far.x, far.y], [500, 0], '안 겹치면 안 움직임');
}

// 클로드 앱 보기: 고정 → 그룹(앱 순서) → 세션(만든 순) → 앱 밖, 보관은 숨김, 제목은 앱 제목
{
    global.SessionHub = SessionHub;
    require('../src/modules/HubAppList.js');
    const p = { root: '/r', name: 'r' };
    const s = (id, firstAt, lastAt) => ({ p, s: { id, title: id, firstAt, lastAt } });
    const app = { groups: [{ id: 'g1', name: 'valveforge' }, { id: 'g2', name: '작곡' }], sessions: {
        a: { group: 'g2', title: '앱 제목 A', createdAt: 1 }, b: { group: 'g2', createdAt: 2 }, c: { group: null, createdAt: 5 },
        d: { group: null, createdAt: 9 }, e: { group: 'g1', archived: true }, f: { group: 'g1', pinned: true } } };
    const secs = SessionHub.appSections(app, [s('a', 1, 10), s('b', 2, 20), s('c', 5, 5), s('d', 9, 9), s('e', 1, 1), s('f', 1, 1), s('x', 3, 3)]);
    assert.deepStrictEqual(secs.map(x => x.title), ['고정됨', '작곡', '세션', '앱 밖 세션', '보관한 세션 1개는 숨김'], '빈 그룹(valveforge)은 안 보임');
    assert.deepStrictEqual(secs[1].rows.map(r => r.s.id), ['b', 'a'], '그룹 안은 최근 순');
    assert.strictEqual(secs[1].rows[1].s.title, '앱 제목 A');
    assert.deepStrictEqual(secs[2].rows.map(r => r.s.id), ['d', 'c'], '세션은 만든 순');
    assert.deepStrictEqual(secs[3].rows.map(r => r.s.id), ['x']);
}

// ClaudeApp.read: 클로드 앱 설정·기록 읽기
{
    const fs = require('fs');
    const os = require('os');
    const path = require('path');
    const ClaudeApp = require('../src/core/ClaudeApp.js');
    const d = fs.mkdtempSync(path.join(os.tmpdir(), 'mm-claude-app-'));
    const rec = path.join(d, 'claude-code-sessions', 'acct', 'org');
    fs.mkdirSync(rec, { recursive: true });
    fs.writeFileSync(path.join(d, 'claude_desktop_config.json'), JSON.stringify({ preferences: { epitaxyPrefs: {
        'dframe-code-sections': { 'acct/org': { sections: [{ id: 'g2', kind: 'manual', name: '작곡', order: 3 }, { id: 'g1', kind: 'manual', name: 'valveforge', order: 2 }, { id: 'sessions', kind: 'sessions', order: 5 }] } },
        'dframe-group-scopes': { 'acct/org': { groups: [], assignments: { 'code:local_a': 'g1' } } } } } }));
    fs.writeFileSync(path.join(rec, 'local_a.json'), JSON.stringify({ sessionId: 'local_a', cliSessionId: 'cli-a', title: '가', createdAt: 1 }));
    fs.writeFileSync(path.join(rec, 'local_b.json'), '깨진 파일');
    const r = ClaudeApp.read(d);
    assert.deepStrictEqual(r.groups, [{ id: 'g1', name: 'valveforge' }, { id: 'g2', name: '작곡' }]);
    assert.deepStrictEqual(r.sessions['cli-a'], { appId: 'local_a', title: '가', group: 'g1', archived: false, createdAt: 1, pinned: false, adopted: false });
    assert.strictEqual(ClaudeApp.read(path.join(d, '없음')).ok, false);
}
console.log('SessionHub: 모든 테스트 통과');
