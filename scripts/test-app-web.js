// AppWebBridge: 앱 안 웹 화면 조종 (앱에 보내는 요청 모양과 답 해석). 앱 없이 가짜 request 로.
const assert = require('assert');
const AppWebBridge = require('../src/core/AppWebBridge.js');

(async () => {
    const sent = [];
    const fake = answers => req => { sent.push(req); return Promise.resolve(answers[req.op]); };
    const b = new AppWebBridge({ browser: 'app-github', request: fake({
        status: { ok: true, open: true, url: 'https://github.com/avabag01-ai' },
        open: { ok: true, url: 'https://github.com/avabag01-ai/claude-mindmap' },
        eval: { ok: true, result: JSON.stringify(JSON.stringify({ title: 'T', url: 'u', text: '글', truncated: false, items: [{ id: 1, tag: 'a', text: '링크' }] })) },
        back: { ok: true }
    }) });

    assert.strictEqual(b.label, 'github');
    const tabs = await b.tabs();
    assert.strictEqual(tabs.length, 1);
    assert.strictEqual(tabs[0].url, 'https://github.com/avabag01-ai');

    const o = await b.open('github.com/avabag01-ai/claude-mindmap');
    assert.strictEqual(sent.at(-1).url, 'https://github.com/avabag01-ai/claude-mindmap');
    assert.strictEqual(o.url, 'https://github.com/avabag01-ai/claude-mindmap');

    // read 는 BrowserBridge 의 페이지 스크립트를 앱 eval 로 돌린다
    const r = await b.read();
    assert.strictEqual(sent.at(-1).op, 'eval');
    assert.ok(sent.at(-1).js.includes('data-mindmap-id'));
    assert.strictEqual(r.text, '글');
    assert.strictEqual(r.items[0].text, '링크');

    await b.navigate('back');
    assert.strictEqual(sent.at(-1).op, 'back');
    assert.strictEqual(sent.at(-1).label, 'github');

    // 앱이 실패하면 그 글을 그대로
    const bad = new AppWebBridge({ browser: 'app-web', request: () => Promise.resolve({ ok: false, error: '앱에서 가운데 브라우저 탭이 아직 안 열렸어요' }) });
    await assert.rejects(() => bad.eval('1'), /아직 안 열렸어요/);
    assert.throws(() => new AppWebBridge({ browser: 'chrome' }), /모르는 앱 화면/);

    // 값 해석: 문자열이 아닌 값도 글자로
    const num = new AppWebBridge({ browser: 'app-web', request: () => Promise.resolve({ ok: true, result: '42' }) });
    assert.strictEqual(await num.eval('6*7'), '42');
    const nul = new AppWebBridge({ browser: 'app-web', request: () => Promise.resolve({ ok: true, result: 'null' }) });
    assert.strictEqual(await nul.eval('undefined'), '');

    console.log('AppWebBridge: 모든 테스트 통과');
})().catch(e => { console.error(e); process.exit(1); });
