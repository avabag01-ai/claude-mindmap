// WindowSnap: 창 고르기, 자르기 계산(창 그림 픽셀 ↔ 창 안쪽 물리 픽셀), 줄이기. 진짜 osascript·screencapture·sips 대신 가짜 run.
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const WindowSnap = require('../src/core/WindowSnap.js');

(async () => {
    const list = [
        { id: 1, pid: 10, owner: 'Google Chrome', w: 30, h: 30 },
        { id: 2, pid: 10, owner: 'Google Chrome', w: 1200, h: 800 },
        { id: 3, pid: 20, owner: 'claude-mindmap', w: 1500, h: 950 },
        { id: 4, pid: 20, owner: 'claude-mindmap', w: 400, h: 300 }
    ];
    assert.strictEqual(WindowSnap.pick(list, { owner: 'Google Chrome' }).id, 2);
    assert.strictEqual(WindowSnap.pick(list, { pid: 20 }).id, 3);
    assert.strictEqual(WindowSnap.pick(list, { pid: 99 }), null);

    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'snap-test-'));
    const calls = [];
    let size = { w: 3000, h: 1900 };
    const fake = async (cmd, args) => {
        calls.push([cmd, ...args]);
        if (cmd === 'osascript') return JSON.stringify(list);
        if (cmd === 'screencapture') { fs.writeFileSync(args.at(-1), 'png'); return ''; }
        if (cmd === 'sips' && args[0] === '-g') return `pixelWidth: ${size.w}\n  pixelHeight: ${size.h}`;
        if (cmd === 'sips' && args[0] === '-c') { assert.strictEqual(args[7], '--out'); assert.notStrictEqual(args[6], args[8], '자르기는 다른 파일로 받아야 해요'); fs.writeFileSync(args[8], 'png'); size = { w: +args[2], h: +args[1] }; return ''; }
        if (cmd === 'sips' && args[0] === '-Z') { const k = +args[1] / Math.max(size.w, size.h); size = { w: Math.round(size.w * k), h: Math.round(size.h * k) }; return ''; }
        return '';
    };
    const s = new WindowSnap({ run: fake, tmp });
    // 창 안쪽 3000px(물리) 중 웹 화면이 x 400, y 300, 2200×1500 → 그림도 같은 픽셀(k = 1)
    const r = await s.snapBase64({ pid: 20, crop: { x: 400, y: 300, w: 2200, h: 1500, winW: 3000 }, max: 1600 });
    const crop = calls.find(c => c[0] === 'sips' && c[1] === '-c');
    assert.deepStrictEqual(crop.slice(1, 6), ['-c', '1500', '2200', '--cropOffset', '300']);
    assert.strictEqual(crop[6], '400');
    assert.ok(calls.some(c => c[0] === 'screencapture' && c.includes('3')), '가장 큰 창(3)을 찍어야 해요');
    assert.strictEqual(r.width, 1600);
    assert.strictEqual(Buffer.from(r.data, 'base64').toString(), 'png');
    assert.strictEqual(fs.readdirSync(tmp).length, 0, '찍은 파일은 지워야 해요');

    // 시작점 0 → 1 (sips 가 0 이면 안 자름)
    calls.length = 0; size = { w: 3000, h: 1900 };
    await s.snapBase64({ pid: 20, crop: { x: 0, y: 300, w: 2000, h: 1500, winW: 3000 } });
    const c0 = calls.find(c => c[0] === 'sips' && c[1] === '-c');
    assert.deepStrictEqual(c0.slice(2, 4).concat(c0.slice(5, 7)), ['1500', '1999', '300', '1']);

    await assert.rejects(() => s.snap({ owner: 'Safari' }), /창이 화면에 없어요/);
    console.log('WindowSnap: 모든 테스트 통과');
})().catch(e => { console.error(e); process.exit(1); });
