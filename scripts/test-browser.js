// 브라우저 조종 테스트: 애플스크립트 만들기·해석 (가짜 osascript), MCP 서버 주고받기
// 실행: node scripts/test-browser.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const BrowserBridge = require('../src/core/BrowserBridge.js');

const fake = path.join(__dirname, 'fake-osascript.js');
const log = path.join(os.tmpdir(), `osa-${process.pid}.log`);
process.env.FAKE_OSA_LOG = log;
const lastScript = () => fs.readFileSync(log, 'utf8').split('\n=====\n').filter(Boolean).pop();

(async () => {
    // 주소
    assert.strictEqual(BrowserBridge.normalizeUrl('github.com/avabag01-ai'), 'https://github.com/avabag01-ai');
    assert.strictEqual(BrowserBridge.normalizeUrl('localhost:3000/x'), 'https://localhost:3000/x');
    assert.strictEqual(BrowserBridge.normalizeUrl('http://a.b'), 'http://a.b');
    assert.strictEqual(BrowserBridge.looksLikeUrl('맥미니 램 업그레이드'), false);
    assert.throws(() => BrowserBridge.normalizeUrl(''), /비었어요/);
    assert.throws(() => new BrowserBridge({ browser: 'netscape' }), /모르는 브라우저/);

    // 크롬: 탭 목록, 열기 (따옴표 이스케이프), 탭 옮기기
    const chrome = new BrowserBridge({ browser: 'chrome', osascript: fake });
    const tabs = await chrome.tabs();
    assert.deepStrictEqual(tabs[1], { window: 1, tab: 2, active: true, title: '검색: "따옴표"', url: 'https://www.google.com/search?q=x' });
    assert.ok(lastScript().includes('tell application "Google Chrome"') && lastScript().includes('active tab index of w'));
    await chrome.open('https://ex.com/?q="a"');
    assert.ok(lastScript().includes('make new tab with properties {URL:"https://ex.com/?q=\\"a\\""}'), '애플스크립트 문자열 안의 따옴표는 이스케이프');
    await chrome.activate(2, 3);
    assert.ok(lastScript().includes('set active tab index of window 2 to 3'));
    await chrome.search('맥미니 램', 'naver');
    assert.ok(lastScript().includes('search.naver.com/search.naver?query=%EB%A7%A5'));

    // 사파리는 다른 문법
    const safari = new BrowserBridge({ browser: 'safari', osascript: fake });
    await safari.tabs();
    assert.ok(lastScript().includes('tell application "Safari"') && lastScript().includes('index of current tab of w') && lastScript().includes('(name of t)'));
    await safari.eval('1+1');
    assert.ok(lastScript().includes('do JavaScript "1+1" in current tab of front window'));

    // 페이지 읽기·누르기·입력
    const r = await chrome.read();
    assert.strictEqual(r.items[0].text, '로그인');
    assert.ok(lastScript().includes('execute active tab of front window javascript'));
    assert.deepStrictEqual(await chrome.click('로그인'), { ok: true, clicked: '로그인' });
    await chrome.type('#q', '안녕 "세상"', { submit: true });
    assert.ok(lastScript().includes('requestSubmit'));

    // 오류를 알아듣게
    assert.match(BrowserBridge.friendlyError('execution error: Executing JavaScript through AppleScript is turned off.', BrowserBridge.BROWSERS.chrome), /개발자 정보/);
    assert.match(BrowserBridge.friendlyError('Not authorized to send Apple events to Safari. (-1743)', BrowserBridge.BROWSERS.safari), /자동화/);
    process.env.FAKE_OSA_FAIL = 'Google Chrome got an error: Application isn’t running. (-600)';
    await assert.rejects(new BrowserBridge({ osascript: fake }).tabs(), /켜져 있지 않아요/);
    delete process.env.FAKE_OSA_FAIL;

    // MCP 서버: initialize → tools/list → tools/call
    const mcp = spawn(process.execPath, [path.join(__dirname, 'mindmap-browser-mcp.js')], { env: { ...process.env, MINDMAP_OSASCRIPT: fake, MINDMAP_BROWSER: 'chrome' } });
    const replies = [];
    let buf = '';
    mcp.stdout.on('data', d => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { replies.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
    const call = (id, method, params) => mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    call(1, 'initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    call(2, 'tools/list', {});
    call(3, 'tools/call', { name: 'browser_tabs', arguments: {} });
    call(4, 'tools/call', { name: 'browser_read', arguments: {} });
    call(5, 'tools/call', { name: 'browser_open', arguments: { url: '' } });
    call(6, 'nope', {});
    await new Promise(r => setTimeout(r, 1500));
    mcp.kill();
    const byId = id => replies.find(x => x.id === id);
    assert.strictEqual(byId(1).result.serverInfo.name, 'mindmap-browser');
    assert.ok(byId(2).result.tools.some(t => t.name === 'browser_click'));
    assert.ok(byId(3).result.content[0].text.includes('▶ [1:2]'));
    assert.ok(byId(4).result.content[0].text.includes('[1] a 로그인'));
    assert.strictEqual(byId(5).result.isError, true, '빈 주소는 도구 오류로');
    assert.strictEqual(byId(6).error.code, -32601);
    assert.strictEqual(replies.filter(x => x.id === undefined).length, 0, '알림에는 답하지 않는다');

    fs.rmSync(log, { force: true });
    console.log('Browser: 모든 테스트 통과');
})().catch(e => { console.error(e); process.exit(1); });
