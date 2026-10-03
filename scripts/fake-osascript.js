#!/usr/bin/env node
// 테스트용 가짜 osascript: 받은 애플스크립트를 보고 그럴듯한 답을 준다. 받은 스크립트는 FAKE_OSA_LOG 에 남긴다.
let script = '';
process.stdin.on('data', d => { script += d; });
process.stdin.on('end', () => {
    if (process.env.FAKE_OSA_LOG) require('fs').appendFileSync(process.env.FAKE_OSA_LOG, script + '\n=====\n');
    if (process.env.FAKE_OSA_FAIL) { process.stderr.write(process.env.FAKE_OSA_FAIL); process.exit(1); }
    const US = '\u001f', RS = '\u001e';
    if (/repeat with w in windows/.test(script)) {
        process.stdout.write(['1', '1', 'false', '깃허브', 'https://github.com/'].join(US) + RS + ['1', '2', 'true', '검색: "따옴표"', 'https://www.google.com/search?q=x'].join(US) + RS + '\n');
    } else if (/JSON\.stringify/.test(script) && /data-mindmap-id/.test(script) && /innerText/.test(script) && /items\.push/.test(script)) {
        process.stdout.write(JSON.stringify({ title: '예시', url: 'https://ex.com', text: '본문', truncated: false, items: [{ id: 1, tag: 'a', text: '로그인', href: 'https://ex.com/login' }] }) + '\n');
    } else if (/JSON\.stringify/.test(script)) {
        process.stdout.write(JSON.stringify({ ok: true, clicked: '로그인' }) + '\n');
    } else if (/execute active tab|do JavaScript/.test(script)) {
        process.stdout.write('42\n');
    } else {
        process.stdout.write('\n');
    }
});
