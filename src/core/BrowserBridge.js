/**
 * BrowserBridge.js
 * =============================================================================
 * 맥의 진짜 브라우저(크롬·사파리·Brave·Edge)를 애플스크립트로 조종한다.
 * 앱 안에 따로 띄우는 브라우저가 아니라, 평소 쓰는 브라우저를 로그인 상태 그대로 쓴다.
 *
 * - 세션 허브의 브라우저 탭과 MCP 서버(scripts/mindmap-browser-mcp.js)가 같이 쓴다.
 * - 페이지 읽기·클릭·입력은 브라우저 안에서 자바스크립트를 실행한다. 그래서 한 번 켜 줘야 한다:
 *     크롬·Brave·Edge: 보기 > 개발자 정보 > Apple Events의 자바스크립트 허용
 *     사파리: 설정 > 고급 > "메뉴 막대에서 개발자용 메뉴 보기" → 개발자용 > Apple Events의 JavaScript 허용
 * - 처음 실행할 때 맥이 "클로드 마인드맵(Electron)이 Chrome 을 제어하려고 합니다"를 묻는다 → 허용.
 */

const { execFile } = require('child_process');

const BROWSERS = {
    chrome: { app: 'Google Chrome', family: 'chrome' },
    brave: { app: 'Brave Browser', family: 'chrome' },
    edge: { app: 'Microsoft Edge', family: 'chrome' },
    safari: { app: 'Safari', family: 'safari' }
};

const US = '\u001f'; // 칸 나눔
const RS = '\u001e'; // 줄 나눔

class BrowserBridge {
    /**
     * @param {object} [options]
     * @param {string} [options.browser] chrome | brave | edge | safari
     * @param {(script: string) => Promise<string>} [options.run] 애플스크립트 실행기 (테스트용)
     */
    constructor(options = {}) {
        this.setBrowser(options.browser || 'chrome');
        this.osascript = options.osascript || process.env.MINDMAP_OSASCRIPT || 'osascript';
        this.runScript = options.run || (script => this._osascript(script));
    }

    setBrowser(name) {
        if (!BROWSERS[name]) throw new Error(`모르는 브라우저예요: ${name}`);
        this.name = name;
        this.b = BROWSERS[name];
    }

    _osascript(script) {
        if (process.platform !== 'darwin' && this.osascript === 'osascript') {
            return Promise.reject(new Error('브라우저 조종은 맥에서만 돼요'));
        }
        return new Promise((resolve, reject) => {
            const child = execFile(this.osascript, ['-'], { timeout: 30000, maxBuffer: 20 * 1024 * 1024 }, (err, stdout, stderr) => {
                if (err) reject(new Error(BrowserBridge.friendlyError(stderr || err.message, this.b)));
                else resolve(stdout.replace(/\n$/, ''));
            });
            child.stdin.end(script);
        });
    }

    static friendlyError(msg, b) {
        const m = String(msg);
        if (/JavaScript.*Apple ?Events|Apple ?Events.*JavaScript|JavaScript through AppleScript is turned off|자바스크립트/i.test(m)) {
            return b.family === 'safari'
                ? '사파리에서 개발자용 메뉴 > "Apple Events의 JavaScript 허용"을 켜 주세요'
                : `${b.app} 에서 보기 > 개발자 정보 > "Apple Events의 자바스크립트 허용"을 켜 주세요`;
        }
        if (/-1743|Not authorized|not allowed to send Apple events|권한/i.test(m)) {
            return `맥 설정 > 개인정보 보호 및 보안 > 자동화에서 클로드 마인드맵(Electron, 또는 터미널)가 ${b.app} 를 제어하도록 허용해 주세요`;
        }
        if (/-600|isn.t running|application isn.t running/i.test(m)) return `${b.app} 가 켜져 있지 않아요`;
        if (/-1728|Can.t get window/i.test(m)) return `${b.app} 에 열린 창이 없어요`;
        return m.trim().split('\n').pop();
    }

    static q(s) {
        return '"' + String(s).replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
    }

    _tell(body) {
        return `tell application ${BrowserBridge.q(this.b.app)}\n${body}\nend tell`;
    }

    // ---------------------------------------------------------------------
    // 탭
    // ---------------------------------------------------------------------
    async tabs() {
        const isSafari = this.b.family === 'safari';
        const script = this._tell(`
set US to (character id 31)
set RS to (character id 30)
set out to ""
set wi to 0
repeat with w in windows
  set wi to wi + 1
  try
    set act to ${isSafari ? 'index of current tab of w' : 'active tab index of w'}
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      set out to out & wi & US & ti & US & (ti = act) & US & (${isSafari ? 'name' : 'title'} of t) & US & (URL of t) & RS
    end repeat
  end try
end repeat
return out`);
        return BrowserBridge.parseTabs(await this.runScript(script));
    }

    static parseTabs(out) {
        return String(out || '').split(RS).filter(l => l.trim()).map(l => {
            const [w, t, active, title, url] = l.split(US);
            return { window: +w, tab: +t, active: active === 'true', title: title || '', url: (url || '').trim() };
        });
    }

    async open(url, { newTab = true } = {}) {
        url = BrowserBridge.normalizeUrl(url);
        const q = BrowserBridge.q(url);
        const body = this.b.family === 'safari'
            ? `activate
if (count of windows) = 0 then
  make new document with properties {URL:${q}}
else if ${newTab} then
  tell front window to set current tab to (make new tab with properties {URL:${q}})
else
  set URL of current tab of front window to ${q}
end if`
            : `activate
if (count of windows) = 0 then
  make new window
  set URL of active tab of front window to ${q}
else if ${newTab} then
  tell front window to make new tab with properties {URL:${q}}
else
  set URL of active tab of front window to ${q}
end if`;
        await this.runScript(this._tell(body));
        return { url };
    }

    async activate(windowIndex, tabIndex) {
        const body = this.b.family === 'safari'
            ? `activate\nset current tab of window ${+windowIndex} to tab ${+tabIndex} of window ${+windowIndex}\nset index of window ${+windowIndex} to 1`
            : `activate\nset active tab index of window ${+windowIndex} to ${+tabIndex}\nset index of window ${+windowIndex} to 1`;
        await this.runScript(this._tell(body));
        return { window: +windowIndex, tab: +tabIndex };
    }

    search(query, engine = 'google') {
        const u = engine === 'naver'
            ? 'https://search.naver.com/search.naver?query=' + encodeURIComponent(query)
            : 'https://www.google.com/search?q=' + encodeURIComponent(query);
        return this.open(u, { newTab: true });
    }

    // ---------------------------------------------------------------------
    // 페이지 안에서 자바스크립트 (앞 창의 보이는 탭)
    // ---------------------------------------------------------------------
    async eval(js) {
        const q = BrowserBridge.q(js);
        const body = this.b.family === 'safari'
            ? `do JavaScript ${q} in current tab of front window`
            : `execute active tab of front window javascript ${q}`;
        return this.runScript(this._tell(body));
    }

    async _evalJson(js) {
        const out = await this.eval(`JSON.stringify((function(){ ${js} })())`);
        try {
            return JSON.parse(out);
        } catch {
            throw new Error('페이지에서 결과를 받지 못했어요');
        }
    }

    /** 페이지 글과 누를 수 있는 것들(번호 붙여서) */
    read({ maxChars = 12000, maxItems = 120 } = {}) {
        return this._evalJson(`
var items = [], n = 0;
var els = document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [onclick], summary');
for (var i = 0; i < els.length && items.length < ${+maxItems}; i++) {
  var e = els[i], r = e.getBoundingClientRect();
  if (!r.width || !r.height) continue;
  var st = getComputedStyle(e); if (st.visibility === 'hidden' || st.display === 'none') continue;
  n++; e.setAttribute('data-mindmap-id', String(n));
  var label = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.name || '').trim().replace(/\\s+/g, ' ').slice(0, 80);
  items.push({ id: n, tag: e.tagName.toLowerCase(), type: e.type || undefined, text: label, href: e.href || undefined });
}
var text = (document.body ? document.body.innerText : '').replace(/\\n{3,}/g, '\\n\\n');
return { title: document.title, url: location.href, text: text.slice(0, ${+maxChars}), truncated: text.length > ${+maxChars}, items: items };`);
    }

    /** target: read 의 번호, CSS 선택자, 또는 보이는 글자 */
    click(target) {
        return this._evalJson(`${BrowserBridge.FIND}
var e = find(${JSON.stringify(String(target))});
if (!e) return { ok: false, error: '누를 것을 찾지 못했어요: ' + ${JSON.stringify(String(target))} };
e.scrollIntoView({ block: 'center' }); e.focus && e.focus(); e.click();
return { ok: true, clicked: (e.innerText || e.value || e.tagName).trim().slice(0, 80) };`);
    }

    type(target, text, { submit = false } = {}) {
        return this._evalJson(`${BrowserBridge.FIND}
var e = find(${JSON.stringify(String(target))});
if (!e) return { ok: false, error: '입력할 곳을 찾지 못했어요: ' + ${JSON.stringify(String(target))} };
e.focus();
var proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
var setter = Object.getOwnPropertyDescriptor(proto, 'value');
if (e.isContentEditable) { e.innerText = ${JSON.stringify(String(text))}; }
else if (setter && setter.set) { setter.set.call(e, ${JSON.stringify(String(text))}); } else { e.value = ${JSON.stringify(String(text))}; }
e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
if (${submit ? 'true' : 'false'}) {
  if (e.form && e.form.requestSubmit) e.form.requestSubmit();
  else e.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }));
}
return { ok: true };`);
    }

    navigate(action) {
        const js = { back: 'history.back()', forward: 'history.forward()', reload: 'location.reload()' }[action];
        if (!js) throw new Error('back · forward · reload 중에 골라 주세요');
        return this.eval(`${js}; 'ok'`).then(() => ({ ok: true, action }));
    }

    static normalizeUrl(url) {
        const u = String(url || '').trim();
        if (!u) throw new Error('주소가 비었어요');
        if (/^(https?|file|about|chrome):/i.test(u)) return u;
        if (/^[\w-]+(\.[\w-]+)+(:\d+)?(\/.*)?$/.test(u) || /^localhost(:\d+)?(\/.*)?$/.test(u)) return 'https://' + u.replace(/^localhost/, 'localhost');
        throw new Error(`주소가 아니에요: ${u}`);
    }

    /** 주소처럼 보이면 true (주소창: 주소면 열고 아니면 검색) */
    static looksLikeUrl(s) {
        try { BrowserBridge.normalizeUrl(s); return true; } catch { return false; }
    }
}

// 번호(data-mindmap-id) · CSS 선택자 · 보이는 글자 순서로 찾는다
BrowserBridge.FIND = `
function find(t) {
  if (/^\\d+$/.test(t)) { var byId = document.querySelector('[data-mindmap-id="' + t + '"]'); if (byId) return byId; }
  try { var bySel = document.querySelector(t); if (bySel) return bySel; } catch (x) {}
  var all = document.querySelectorAll('a, button, input, textarea, select, [role=button], [role=link], label, summary');
  var low = t.toLowerCase();
  for (var i = 0; i < all.length; i++) {
    var s = (all[i].innerText || all[i].value || all[i].getAttribute('aria-label') || all[i].getAttribute('placeholder') || '').trim().toLowerCase();
    if (s && (s === low || s.indexOf(low) >= 0)) return all[i];
  }
  return null;
}`;

BrowserBridge.BROWSERS = BROWSERS;

if (typeof module !== 'undefined' && module.exports) {
    module.exports = BrowserBridge;
}
