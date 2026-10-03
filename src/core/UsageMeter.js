/**
 * UsageMeter.js
 * =============================================================================
 * Claude 구독 사용량(지금 세션 5시간 한도, 주간 한도)을 읽는다 (메인 프로세스 전용)
 *
 * - Claude Code 의 /usage 와 같은 곳을 본다: GET https://api.anthropic.com/api/oauth/usage
 *   (공개 문서가 있는 API 가 아니라서 바뀔 수 있다. 그러면 화면에 "알 수 없음"으로 나온다)
 * - 로그인 정보는 Claude Code 가 저장한 것을 읽기만 한다:
 *     맥: 키체인 "Claude Code-credentials"   ·   그 밖: ~/.claude/.credentials.json
 *   토큰은 이 프로세스 밖(화면 쪽)으로 보내지 않고, api.anthropic.com 에만 보낸다.
 *   토큰이 만료됐으면 새로 받지 않는다 (Claude Code 의 로그인 갱신과 엉키지 않게) → Claude Code 를 한 번 쓰면 다시 보인다.
 * - FLOWCODE_USAGE_FILE 에 JSON 파일을 주면 그걸 읽는다 (테스트·미리보기).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';

class UsageMeter {
    constructor(options = {}) {
        this.fetch = options.fetch || globalThis.fetch;
        this.readKeychain = options.readKeychain || UsageMeter._keychain;
        this.credFile = options.credFile || path.join(os.homedir(), '.claude', '.credentials.json');
        this.file = options.file || process.env.FLOWCODE_USAGE_FILE || null;
        this.platform = options.platform || process.platform;
        this.now = options.now || (() => Date.now());
    }

    static _keychain() {
        return new Promise(resolve => {
            execFile('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'], { timeout: 5000 }, (err, stdout) => resolve(err ? null : stdout.trim()));
        });
    }

    async _token() {
        let raw = null;
        if (this.platform === 'darwin') raw = await this.readKeychain();
        if (!raw) {
            try { raw = fs.readFileSync(this.credFile, 'utf8'); } catch { /* 없음 */ }
        }
        if (!raw) return { error: 'Claude Code 로그인 정보를 찾지 못했어요 (터미널에서 claude 로 한 번 로그인)' };
        let d;
        try { d = JSON.parse(raw); } catch { return { error: 'Claude Code 로그인 정보를 읽지 못했어요' }; }
        const o = d.claudeAiOauth || d;
        if (!o.accessToken) return { error: 'Claude 구독 로그인이 아니에요 (API 키로 쓰는 중이면 한도가 없어요)' };
        if (o.expiresAt && o.expiresAt < this.now()) return { error: '로그인이 만료됐어요. Claude Code 를 한 번 쓰면 다시 보여요' };
        return { token: o.accessToken };
    }

    async read() {
        if (this.file) {
            return UsageMeter.parse(JSON.parse(fs.readFileSync(this.file, 'utf8')), this.now());
        }
        const t = await this._token();
        if (t.error) return { ok: false, error: t.error, at: this.now() };
        let res;
        try {
            res = await this.fetch(ENDPOINT, {
                headers: { Authorization: `Bearer ${t.token}`, 'anthropic-beta': 'oauth-2025-04-20', 'Content-Type': 'application/json' }
            });
        } catch (e) {
            return { ok: false, error: `사용량을 가져오지 못했어요: ${e.message}`, at: this.now() };
        }
        if (res.status === 401) return { ok: false, error: '로그인이 만료됐어요. Claude Code 를 한 번 쓰면 다시 보여요', at: this.now() };
        if (!res.ok) return { ok: false, error: `사용량을 가져오지 못했어요 (HTTP ${res.status})`, at: this.now() };
        return UsageMeter.parse(await res.json(), this.now());
    }

    /**
     * 응답 → 화면용. utilization 은 쓴 비율(0~100). 남은 비율 = 100 - 쓴 비율.
     * @returns {{ ok, at, session?: Bar, week?: Bar, weekOpus?: Bar }}  Bar = { used, left, resetsAt }
     */
    static parse(d, now) {
        const bar = x => {
            if (!x || typeof x.utilization !== 'number') return null;
            const used = Math.max(0, Math.min(100, x.utilization));
            return { used, left: Math.round((100 - used) * 10) / 10, resetsAt: x.resets_at ? Date.parse(x.resets_at) || null : null };
        };
        const out = { ok: true, at: now || Date.now(), session: bar(d && d.five_hour), week: bar(d && d.seven_day), weekOpus: bar(d && d.seven_day_opus) };
        if (!out.session && !out.week) return { ok: false, error: '사용량 형식을 알아보지 못했어요 (Claude 쪽이 바뀌었을 수 있어요)', at: out.at };
        return out;
    }
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = UsageMeter;
}
