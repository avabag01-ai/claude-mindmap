/**
 * AppWebBridge - 클로드 마인드맵 앱 안 웹 화면(가운데 GitHub·브라우저 탭)을 조종한다
 * =============================================================================
 * BrowserBridge 와 같은 모양(tabs·open·search·activate·read·click·type·navigate·eval)이라
 * scripts/mindmap-browser-mcp.js 가 browser: "app-github" · "app-web" 이면 이걸 쓴다.
 * 앱(src-tauri/src/web_control.rs)이 127.0.0.1 에서 듣고, 포트·열쇠는 ~/.claude-mindmap/web-control.json.
 * read·click·type 의 페이지 안 스크립트는 BrowserBridge 것을 그대로 쓰고 실행만 앱으로 보낸다.
 */

const fs = require('fs');
const net = require('net');
const BrowserBridge = require('./BrowserBridge.js');
const appDir = require('./appDir.js');

const TARGETS = { 'app-github': 'github', 'app-web': 'web' };

class AppWebBridge extends BrowserBridge {
    /**
     * @param {object} [options]
     * @param {string} [options.browser] app-github | app-web
     * @param {(req: object) => Promise<object>} [options.request] 앱에 보내기 (테스트용)
     */
    constructor(options = {}) {
        super({ browser: 'chrome' });
        const name = options.browser || 'app-web';
        if (!TARGETS[name]) throw new Error(`모르는 앱 화면이에요: ${name}`);
        this.name = name;
        this.label = TARGETS[name];
        this.request = options.request || (req => AppWebBridge.send(req));
    }

    static info() {
        let raw;
        try { raw = fs.readFileSync(appDir.settingsFile('web-control.json'), 'utf8'); } catch {
            throw new Error('클로드 마인드맵 앱이 안 켜져 있어요 (web-control.json 없음)');
        }
        const info = JSON.parse(raw);
        if (!info.port || !info.token) throw new Error('web-control.json 이 이상해요');
        return info;
    }

    /** 한 줄 JSON 보내고 한 줄 받기 */
    static send(req) {
        const { port, token } = AppWebBridge.info();
        return new Promise((resolve, reject) => {
            const sock = net.createConnection({ host: '127.0.0.1', port });
            let buf = '';
            const fail = e => { sock.destroy(); reject(new Error(e.code === 'ECONNREFUSED' ? '클로드 마인드맵 앱이 안 켜져 있어요' : e.message)); };
            sock.setTimeout(30000, () => fail(new Error('앱에서 답이 없어요')));
            sock.on('error', fail);
            sock.on('data', d => {
                buf += d;
                const i = buf.indexOf('\n');
                if (i < 0) return;
                sock.end();
                try { resolve(JSON.parse(buf.slice(0, i))); } catch { reject(new Error('앱 답이 JSON 이 아니에요')); }
            });
            sock.write(JSON.stringify({ ...req, token }) + '\n');
        });
    }

    async _call(op, extra = {}) {
        const r = await this.request({ label: this.label, op, ...extra });
        if (!r || !r.ok) throw new Error((r && r.error) || '앱에서 실패했어요');
        return r;
    }

    async tabs() {
        const r = await this._call('status');
        if (!r.open) return [];
        return [{ window: 1, tab: 1, active: true, title: this.label === 'github' ? '앱 GitHub 탭' : '앱 브라우저 탭', url: r.url || '' }];
    }

    async open(url) {
        const r = await this._call('open', { url: BrowserBridge.normalizeUrl(url) });
        return { ok: true, url: r.url };
    }

    async activate() {
        throw new Error('앱 화면은 탭이 하나예요 (open 으로 주소를 바꾸세요)');
    }

    /** 마지막 식의 값을 문자열로 (BrowserBridge.eval 과 같게) */
    async eval(js) {
        const r = await this._call('eval', { js });
        let v;
        try { v = JSON.parse(r.result); } catch { v = r.result; }
        return v == null ? '' : typeof v === 'string' ? v : JSON.stringify(v);
    }

    async navigate(action) {
        if (!['back', 'forward', 'reload'].includes(action)) throw new Error('back · forward · reload 중에 골라 주세요');
        await this._call(action);
        return { ok: true, action };
    }
}

AppWebBridge.TARGETS = TARGETS;
module.exports = AppWebBridge;
