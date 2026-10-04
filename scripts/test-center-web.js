// HubCenterWeb.js: 불러올 때 오류 없이 setCenterTab 을 감싸고, Tauri 이벤트(번역 진행·Claude 가 연 주소)를 듣는지.
// (10-04: 변수를 선언 전에 써서 듣기가 통째로 빠졌던 것 — 화면에서 "번역 중…" 에 멈춤)
const assert = require('assert');
const fs = require('fs');
const vm = require('vm');

const listened = [];
function FakeHub() {}
FakeHub.prototype.start = function () {};
FakeHub.prototype.setCenterTab = function (tab) { this.centerTab = tab; };
const sandbox = {
    console,
    SessionHub: FakeHub,
    SessionMindMap: { _esc: s => String(s) },
    HubBrowser: { looksLikeUrl: () => false },
    HubGitHub: { openUrl() {} },
    localStorage: { getItem: () => null, setItem() {} },
    document: { readyState: 'complete', addEventListener() {}, querySelector: () => null, querySelectorAll: () => [] },
    requestAnimationFrame() {},
    setTimeout
};
sandbox.window = { __TAURI__: { core: { invoke: () => Promise.resolve('') }, event: { listen: (name) => { listened.push(name); return Promise.resolve(); } } } };
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(require.resolve('../src/modules/HubCenterWeb.js'), 'utf8'), sandbox);

assert.ok(FakeHub.prototype._cwWired, 'setCenterTab 을 감쌌어야 해요');
assert.deepStrictEqual(listened.sort(), ['center-web:open', 'center-web:translate']);
assert.notStrictEqual(sandbox.HubGitHub.openUrl.toString().indexOf('_cwPendingUrl'), -1, 'github.com 주소는 가운데 탭으로');
console.log('HubCenterWeb: 모든 테스트 통과');
