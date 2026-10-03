// UsageMeter 테스트: 로그인 정보 찾기, 응답 해석, 오류 문구
// 실행: node scripts/test-usage-meter.js
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const UsageMeter = require('../src/core/UsageMeter.js');

const NOW = Date.parse('2026-10-03T16:00:00Z');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-'));
const cred = path.join(tmp, 'cred.json');
const body = { five_hour: { utilization: 37.5, resets_at: '2026-10-03T19:00:00Z' }, seven_day: { utilization: 82, resets_at: '2026-10-06T09:00:00Z' }, seven_day_opus: null };

(async () => {
    // 응답 해석
    const p = UsageMeter.parse(body, NOW);
    assert.deepStrictEqual(p.session, { used: 37.5, left: 62.5, resetsAt: Date.parse('2026-10-03T19:00:00Z') });
    assert.strictEqual(p.week.left, 18);
    assert.strictEqual(p.weekOpus, null);
    assert.strictEqual(UsageMeter.parse({ five_hour: { utilization: 130 } }, NOW).session.left, 0, '100% 넘어도 0 에서 멈춘다');
    assert.strictEqual(UsageMeter.parse({ nope: 1 }, NOW).ok, false, '모르는 형식');

    // 키체인(맥) → 토큰 → 요청 헤더
    let seen = null;
    const fetch = async (url, opts) => { seen = { url, opts }; return { ok: true, status: 200, json: async () => body }; };
    const mac = new UsageMeter({ platform: 'darwin', fetch, now: () => NOW, readKeychain: async () => JSON.stringify({ claudeAiOauth: { accessToken: 'tok-1', expiresAt: NOW + 1e6 } }), credFile: cred });
    const r = await mac.read();
    assert.strictEqual(r.ok, true);
    assert.strictEqual(r.week.left, 18);
    assert.strictEqual(seen.url, 'https://api.anthropic.com/api/oauth/usage');
    assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tok-1');

    // 맥이 아니면 파일에서
    fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: 'tok-2', expiresAt: NOW + 1e6 } }));
    await new UsageMeter({ platform: 'linux', fetch, now: () => NOW, credFile: cred }).read();
    assert.strictEqual(seen.opts.headers.Authorization, 'Bearer tok-2');

    // 오류: 정보 없음 / 만료 / API 키 / 401 / 네트워크
    assert.match((await new UsageMeter({ platform: 'linux', fetch, now: () => NOW, credFile: path.join(tmp, 'none') }).read()).error, /찾지 못했어요/);
    fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: 'x', expiresAt: NOW - 1 } }));
    assert.match((await new UsageMeter({ platform: 'linux', fetch, now: () => NOW, credFile: cred }).read()).error, /만료/);
    fs.writeFileSync(cred, JSON.stringify({ apiKey: 'sk' }));
    assert.match((await new UsageMeter({ platform: 'linux', fetch, now: () => NOW, credFile: cred }).read()).error, /구독 로그인이 아니에요/);
    fs.writeFileSync(cred, JSON.stringify({ claudeAiOauth: { accessToken: 'x' } }));
    assert.match((await new UsageMeter({ platform: 'linux', now: () => NOW, credFile: cred, fetch: async () => ({ ok: false, status: 401 }) }).read()).error, /만료/);
    assert.match((await new UsageMeter({ platform: 'linux', now: () => NOW, credFile: cred, fetch: async () => { throw new Error('offline'); } }).read()).error, /offline/);

    // 파일로 주기 (테스트·미리보기)
    const f = path.join(tmp, 'u.json'); fs.writeFileSync(f, JSON.stringify(body));
    assert.strictEqual((await new UsageMeter({ file: f, now: () => NOW }).read()).session.left, 62.5);

    fs.rmSync(tmp, { recursive: true, force: true });
    console.log('UsageMeter: 모든 테스트 통과');
})().catch(e => { console.error(e); process.exit(1); });
