#!/usr/bin/env node
// 테스트용 가짜 claude: 받은 인자를 그대로 stream-json 으로 돌려준다.
const args = process.argv.slice(2);
const text = args[args.length - 1];
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null;
const sid = resume || 'new-session-0001';
const out = o => process.stdout.write(JSON.stringify(o) + '\n');
out({ type: 'system', subtype: 'init', session_id: sid, cwd: process.cwd(), args });
setTimeout(() => {
    out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: `받았어: ${text}` }] } });
    out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', name: 'Edit', input: { file_path: process.cwd() + '/a.js' } }] } });
    process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', session_id: sid, result: 'done', total_cost_usd: 0.01, is_error: false }));
    if (text === 'hang') setTimeout(() => {}, 60000);
}, 50);
