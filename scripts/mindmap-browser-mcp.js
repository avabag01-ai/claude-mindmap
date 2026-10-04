#!/usr/bin/env node
/**
 * mindmap-browser-mcp.js
 * =============================================================================
 * Claude Code 가 맥의 진짜 브라우저(크롬·사파리·Brave·Edge)를 조종하게 해 주는 MCP 서버 (stdio)
 *
 * 등록 (세션 허브 브라우저 탭의 "Claude 에 연결" 버튼이 대신 해 준다):
 *   claude mcp add --scope user mindmap-browser -- node /경로/claude-mindmap/scripts/mindmap-browser-mcp.js
 *
 * 쓸 브라우저: ~/.claude-mindmap/browser.json 의 { "browser": "chrome" } (브라우저 탭에서 고른 것)
 *             app-github · app-web = 클로드 마인드맵 앱 안 웹 화면(가운데 GitHub·브라우저 탭, src/core/AppWebBridge.js)
 *             또는 MINDMAP_BROWSER 환경 변수, 또는 도구마다 browser 인자.
 *
 * 의존성 없음: MCP 는 줄 단위 JSON-RPC 2.0 이라 직접 처리한다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const readline = require('readline');
const BrowserBridge = require('../src/core/BrowserBridge.js');
const AppWebBridge = require('../src/core/AppWebBridge.js');

const VERSION = '1.0.0';
const SETTINGS = require('../src/core/appDir.js').settingsFile('browser.json');

function pickBrowser(arg) {
    if (arg) return arg;
    if (process.env.MINDMAP_BROWSER) return process.env.MINDMAP_BROWSER;
    try { return JSON.parse(fs.readFileSync(SETTINGS, 'utf8')).browser || 'chrome'; } catch { return 'chrome'; }
}

const browserArg = { browser: { type: 'string', enum: [...Object.keys(BrowserBridge.BROWSERS), ...Object.keys(AppWebBridge.TARGETS)], description: '쓸 브라우저 (생략하면 세션 허브에서 고른 것). app-github = 클로드 마인드맵 앱 가운데 GitHub 탭, app-web = 앱 가운데 브라우저 탭 (사용자가 앱에서 보고 있는 화면, 앱 안 로그인 그대로)' } };

const TOOLS = [
    { name: 'browser_tabs', description: '열린 창과 탭 목록 (창 번호, 탭 번호, 보이는 탭인지, 제목, 주소)', inputSchema: { type: 'object', properties: { ...browserArg } },
      run: (b) => b.tabs().then(tabs => tabs.length ? tabs.map(t => `${t.active ? '▶' : ' '} [${t.window}:${t.tab}] ${t.title}\n    ${t.url}`).join('\n') : '열린 탭이 없어요') },
    { name: 'browser_open', description: '주소를 연다 (기본은 새 탭)', inputSchema: { type: 'object', properties: { url: { type: 'string' }, new_tab: { type: 'boolean', default: true }, ...browserArg }, required: ['url'] },
      run: (b, a) => b.open(a.url, { newTab: a.new_tab !== false }).then(r => `열었어요: ${r.url}`) },
    { name: 'browser_search', description: '검색 (google 또는 naver) 결과를 새 탭으로 연다', inputSchema: { type: 'object', properties: { query: { type: 'string' }, engine: { type: 'string', enum: ['google', 'naver'], default: 'google' }, ...browserArg }, required: ['query'] },
      run: (b, a) => b.search(a.query, a.engine).then(r => `검색했어요: ${r.url}`) },
    { name: 'browser_switch', description: '창·탭으로 옮긴다 (browser_tabs 의 [창:탭] 번호)', inputSchema: { type: 'object', properties: { window: { type: 'integer' }, tab: { type: 'integer' }, ...browserArg }, required: ['window', 'tab'] },
      run: (b, a) => b.activate(a.window, a.tab).then(() => `옮겼어요: [${a.window}:${a.tab}]`) },
    { name: 'browser_read', description: '앞 창 보이는 탭의 제목·주소·글, 그리고 누를 수 있는 것들(번호). 번호는 browser_click·browser_type 에 쓴다', inputSchema: { type: 'object', properties: { max_chars: { type: 'integer', default: 12000 }, ...browserArg } },
      run: (b, a) => b.read({ maxChars: a.max_chars || 12000 }).then(r => `# ${r.title}\n${r.url}\n\n${r.text}${r.truncated ? '\n…(잘림)' : ''}\n\n## 누를 수 있는 것\n${r.items.map(i => `[${i.id}] ${i.tag}${i.type ? `(${i.type})` : ''} ${i.text}${i.href ? ` → ${i.href}` : ''}`).join('\n')}`) },
    { name: 'browser_click', description: '누른다. target = browser_read 의 번호, CSS 선택자, 또는 보이는 글자', inputSchema: { type: 'object', properties: { target: { type: 'string' }, ...browserArg }, required: ['target'] },
      run: (b, a) => b.click(a.target).then(r => { if (!r.ok) throw new Error(r.error); return `눌렀어요: ${r.clicked}`; }) },
    { name: 'browser_type', description: '입력칸에 글을 넣는다 (submit 이면 제출)', inputSchema: { type: 'object', properties: { target: { type: 'string' }, text: { type: 'string' }, submit: { type: 'boolean', default: false }, ...browserArg }, required: ['target', 'text'] },
      run: (b, a) => b.type(a.target, a.text, { submit: !!a.submit }).then(r => { if (!r.ok) throw new Error(r.error); return '입력했어요'; }) },
    { name: 'browser_navigate', description: '뒤로 · 앞으로 · 새로고침', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['back', 'forward', 'reload'] }, ...browserArg }, required: ['action'] },
      run: (b, a) => b.navigate(a.action).then(() => `했어요: ${a.action}`) },
    { name: 'browser_eval', description: '앞 창 보이는 탭에서 자바스크립트를 실행하고 결과를 돌려준다 (마지막 식의 값)', inputSchema: { type: 'object', properties: { js: { type: 'string' }, ...browserArg }, required: ['js'] },
      run: (b, a) => b.eval(a.js).then(r => r === '' ? '(값 없음)' : String(r)) }
];

function send(msg) {
    process.stdout.write(JSON.stringify(msg) + '\n');
}

async function handle(msg) {
    const { id, method, params } = msg;
    if (method === 'initialize') {
        return send({ jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'mindmap-browser', version: VERSION } } });
    }
    if (method === 'ping') return send({ jsonrpc: '2.0', id, result: {} });
    if (method === 'tools/list') {
        return send({ jsonrpc: '2.0', id, result: { tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })) } });
    }
    if (method === 'tools/call') {
        const tool = TOOLS.find(t => t.name === (params && params.name));
        if (!tool) return send({ jsonrpc: '2.0', id, error: { code: -32602, message: `모르는 도구: ${params && params.name}` } });
        const args = (params && params.arguments) || {};
        try {
            const name = pickBrowser(args.browser);
            const bridge = AppWebBridge.TARGETS[name] ? new AppWebBridge({ browser: name }) : new BrowserBridge({ browser: name });
            const text = await tool.run(bridge, args);
            return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text }] } });
        } catch (e) {
            return send({ jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: e.message }], isError: true } });
        }
    }
    if (id !== undefined) send({ jsonrpc: '2.0', id, error: { code: -32601, message: `모르는 요청: ${method}` } });
    // 알림(notifications/*)은 답하지 않는다
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', line => {
    if (!line.trim()) return;
    let msg;
    try { msg = JSON.parse(line); } catch { return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'JSON 이 아니에요' } }); }
    handle(msg).catch(e => send({ jsonrpc: '2.0', id: msg.id, error: { code: -32603, message: e.message } }));
});
