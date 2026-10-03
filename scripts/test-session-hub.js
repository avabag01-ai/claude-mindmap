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
assert.strictEqual(SessionHub.toonStartPrompt('/a/b', '', 'MLX 이식'), '툰 불러와 — 하위 세션, root: /a/b, hub_task: MLX 이식');
assert.strictEqual(SessionHub.toonStartPrompt('/a/b', 'logic-ax', 'AMT 후보 듣기'), '툰 불러와 — 하위 세션, root: /a/b, topic: logic-ax, hub_task: AMT 후보 듣기');
assert.strictEqual(SessionHub.withAttachments('봐줘', []), '봐줘');
assert.strictEqual(SessionHub.withAttachments('이거 고쳐', ['/a/b.js', '/c d/e.png']), '이거 고쳐\n\n첨부 파일:\n- /a/b.js\n- /c d/e.png');
assert.strictEqual(SessionHub.withAttachments('', ['/a.js']), '첨부한 파일을 봐줘.\n\n첨부 파일:\n- /a.js');
const { HubBrowser } = require('../src/modules/HubPanels.js');
const rp = HubBrowser.readPrompt({ title: '제목', url: 'https://a.b', text: 'x'.repeat(30) }, 10);
assert.ok(rp.includes('툰 형식') && rp.includes('[페이지] 제목\nhttps://a.b') && rp.includes('xxxxxxxxxx\n…(뒤는 잘렸어요)'));
assert.ok(HubBrowser.looksLikeUrl('github.com/a') && !HubBrowser.looksLikeUrl('맥미니 램'));
console.log('SessionHub: 모든 테스트 통과');
