/**
 * WindowSnap - 맥 앱 창 하나를 그림(PNG)으로 찍는다 (Claude 의 눈: browser_snap)
 * =============================================================================
 * - 창 찾기: CoreGraphics 창 목록(JXA)에서 프로세스 번호 또는 앱 이름으로, 화면에 있는 보통 창(layer 0) 중 가장 큰 것
 * - 찍기: screencapture -l <창 번호> (다른 창에 가려져도 그 창만 찍힘). 화면 기록 권한이 필요하다
 * - 자르기·줄이기: sips (crop = 창 안 물리 픽셀 사각형)
 * 맥 전용. 테스트에서는 run 을 바꿔 끼운다.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

function run(cmd, args) {
    return new Promise((resolve, reject) => {
        execFile(cmd, args, { maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
            if (err) return reject(new Error((stderr || err.message).toString().trim()));
            resolve(stdout.toString());
        });
    });
}

/** JXA: 창 목록 → [{ id, pid, owner, w, h }] (화면에 있는 layer 0 만) */
const LIST_JXA = `
ObjC.import('CoreGraphics');
var arr = ObjC.castRefToObject($.CGWindowListCopyWindowInfo($.kCGWindowListOptionOnScreenOnly, 0)).js;
JSON.stringify(arr.map(function (w) { return w.js; }).filter(function (w) { return w.kCGWindowLayer.js === 0; }).map(function (w) {
  var b = w.kCGWindowBounds.js;
  return { id: w.kCGWindowNumber.js, pid: w.kCGWindowOwnerPID.js, owner: w.kCGWindowOwnerName ? w.kCGWindowOwnerName.js : '', w: b.Width.js, h: b.Height.js };
}));`;

class WindowSnap {
    constructor(options = {}) {
        this.run = options.run || run;
        this.tmp = options.tmp || os.tmpdir();
    }

    async windows() {
        return JSON.parse(await this.run('osascript', ['-l', 'JavaScript', '-e', LIST_JXA]));
    }

    /** pid 또는 owner(앱 이름)로 창 하나 (가장 큰 것) */
    static pick(list, { pid, owner }) {
        const mine = list.filter(w => (pid ? w.pid === pid : true) && (owner ? w.owner === owner : true) && w.w > 50 && w.h > 50);
        if (!mine.length) return null;
        return mine.sort((a, b) => b.w * b.h - a.w * a.h)[0];
    }

    /**
     * 찍기 → { path, width, height }
     * @param {object} q { pid?, owner?, crop?: {x,y,w,h, winW} (물리 픽셀, winW = 창 안쪽 너비), max?: 긴 변 최대 픽셀 }
     */
    async snap(q) {
        const win = WindowSnap.pick(await this.windows(), q);
        if (!win) throw new Error(`${q.owner || '앱'} 창이 화면에 없어요 (다른 데스크톱에 있거나 최소화돼 있으면 못 찍어요)`);
        const file = path.join(this.tmp, `mindmap-snap-${process.pid}-${Date.now()}.png`);
        try {
            await this.run('screencapture', ['-x', '-o', '-l', String(win.id), file]);
        } catch (e) {
            throw new Error(`창을 못 찍었어요 (화면 기록 권한이 필요해요): ${e.message}`);
        }
        if (!fs.existsSync(file) || !fs.statSync(file).size) throw new Error('창을 못 찍었어요 (화면 기록 권한을 확인해 주세요)');
        let { width, height } = await this.size(file);
        if (q.crop) {
            // 창 그림 픽셀 / 창 안쪽 물리 픽셀 (보통 1)
            const k = q.crop.winW ? width / q.crop.winW : 1;
            // sips 는 자르기 시작점이 0 이면 자르기를 조용히 건너뛴다 → 0 은 1 로 (1픽셀 잃음)
            const c = [q.crop.y, q.crop.x, q.crop.h, q.crop.w].map(v => Math.max(0, Math.round(v * k)));
            for (const i of [0, 1]) if (c[i] === 0) { c[i] = 1; c[i + 2] -= 1; }
            const h = Math.min(c[2], height - c[0]), w = Math.min(c[3], width - c[1]);
            if (h > 10 && w > 10) {
                // 같은 파일로 --out 하면 sips 가 자르기를 조용히 건너뛴다 → 다른 파일로 받아 바꿔치기
                const cut = file.replace(/\.png$/, '-cut.png');
                await this.run('sips', ['-c', String(h), String(w), '--cropOffset', String(c[0]), String(c[1]), file, '--out', cut]);
                if (fs.existsSync(cut)) fs.renameSync(cut, file);
                ({ width, height } = await this.size(file));
            }
        }
        const max = q.max || 1600;
        if (Math.max(width, height) > max) {
            await this.run('sips', ['-Z', String(max), file, '--out', file]);
            ({ width, height } = await this.size(file));
        }
        return { path: file, width, height };
    }

    async size(file) {
        const out = await this.run('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', file]);
        return { width: +(/pixelWidth: (\d+)/.exec(out) || [])[1] || 0, height: +(/pixelHeight: (\d+)/.exec(out) || [])[1] || 0 };
    }

    /** 찍고 base64 로 (파일은 지운다) */
    async snapBase64(q) {
        const r = await this.snap(q);
        try {
            return { data: fs.readFileSync(r.path).toString('base64'), width: r.width, height: r.height };
        } finally {
            fs.rmSync(r.path, { force: true });
        }
    }
}

module.exports = WindowSnap;
