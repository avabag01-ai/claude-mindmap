// 가운데 GitHub·브라우저 탭에 진짜 웹 화면을 바로 띄운다 (Tauri 자식 웹뷰 = 맥 WebKit, src-tauri/src/center_web.rs).
// - GitHub 탭: github.com (처음 한 번 이 안에서 로그인하면 기억). "저장소 맵" 단추로 예전 GitHub 맵·저장소 칸으로 바꿀 수 있다.
// - 두 탭 모두 "대화창에" 단추: 지금 주소를 대화창 입력칸(커서 자리)에 넣는다.
// - 브라우저 탭: 주소창 + 웹 화면. "크롬 조종" 단추로 예전 진짜 크롬·사파리 조종 칸으로.
// - 웹 화면은 앱 화면 위에 떠 있는 따로 된 창이라, 자리(.cw-slot)가 움직이면 좌표를 다시 보낸다(보일 때만 매 프레임 확인).
// - Electron 판·미리보기(Tauri 없음)에서는 예전 칸 그대로.
// HubCenterTabs.js · MindMapGitHub.js 다음에 불러야 setCenterTab 을 바깥에서 감싼다.
(function () {
    if (typeof SessionHub === 'undefined' || typeof document === 'undefined') return;
    const T = () => window.__TAURI__ && window.__TAURI__.core;
    let realOpen = null; // 감싸기 전 HubGitHub.openUrl ("크롬으로"는 진짜 브라우저로)
    const esc = s => SessionMindMap._esc(s == null ? '' : s);
    // 가운데 탭 → 웹뷰 라벨, 예전 칸 단추 이름
    const VIEWS = {
        github: { label: 'github', alt: '저장소 맵', altTitle: '예전 GitHub 맵과 저장소 칸 보기', ph: '주소나 GitHub 검색어', search: q => `https://github.com/search?q=${encodeURIComponent(q)}` },
        browser: { label: 'web', alt: '크롬 조종', altTitle: '맥의 진짜 크롬·사파리 탭 보기·조종', ph: '주소나 검색어', search: q => `https://www.google.com/search?q=${encodeURIComponent(q)}` }
    };

    function mode(tab) {
        if (!T()) return 'app';
        try { return localStorage.getItem(`cw.mode.${tab}`) || 'web'; } catch { return 'web'; }
    }
    function setMode(tab, m) { try { localStorage.setItem(`cw.mode.${tab}`, m); } catch { /* 미리보기 */ } }

    function build(hub) {
        if (hub._cw) return hub._cw;
        const main = document.querySelector('main.col');
        const cw = hub._cw = {};
        for (const [tab, v] of Object.entries(VIEWS)) {
            const box = document.createElement('div');
            box.className = 'hub-panel center-full cw';
            box.id = `cw-${v.label}`;
            box.hidden = true;
            box.innerHTML = `<div class="cw-bar">
                <button class="btn" data-cw="back" title="뒤로">←</button><button class="btn" data-cw="forward" title="앞으로">→</button>
                <button class="btn" data-cw="reload" title="새로고침">⟳</button><button class="btn" data-cw="home" title="${tab === 'github' ? '내 GitHub' : '처음 화면'}">⌂</button>
                ${tab === 'github' ? '<button class="btn" data-cw="repo" title="고른 세션의 저장소">이 세션 저장소</button>' : ''}
                <input type="text" class="cw-addr" placeholder="${esc(v.ph)}" aria-label="${esc(v.ph)}" spellcheck="false">
                <button class="btn" data-cw="chat" title="지금 주소를 대화창에 넣기">대화창에</button>
                <button class="btn" data-cw="chrome" title="지금 주소를 맥의 진짜 브라우저로 열기">크롬으로</button>
                <button class="btn" data-cw="alt" title="${esc(v.altTitle)}">${esc(v.alt)}</button></div>
                <div class="cw-slot"><p class="hub-empty">불러오는 중…</p></div>`;
            main.insertBefore(box, document.getElementById('hub-toon-panel'));
            cw[tab] = { box, slot: box.querySelector('.cw-slot'), addr: box.querySelector('.cw-addr'), label: v.label, rect: '', url: '' };
            box.querySelector('.cw-bar').addEventListener('click', e => {
                const b = e.target.closest('[data-cw]');
                if (b) act(hub, tab, b.dataset.cw);
            });
            cw[tab].addr.addEventListener('keydown', e => {
                if (e.key !== 'Enter') return;
                e.preventDefault();
                const t = e.target.value.trim();
                if (!t) return;
                const url = /^https?:\/\//i.test(t) ? t : HubBrowser.looksLikeUrl(t) ? `https://${t}` : v.search(t);
                show(hub, tab, url);
                e.target.blur();
            });
        }
        // 다른 칸 단추: "웹으로" (예전 칸 머리줄에 붙인다)
        for (const [tab, id] of [['github', 'panel-github'], ['browser', 'panel-browser']]) {
            const head = document.querySelector(`#${id} .col-head .row`);
            if (!head || !T()) continue;
            const b = document.createElement('button');
            b.className = 'btn';
            b.textContent = '웹으로';
            b.title = tab === 'github' ? 'github.com 을 여기서 바로 보기' : '웹 화면을 여기서 바로 보기';
            b.addEventListener('click', () => { setMode(tab, 'web'); hub.setCenterTab(tab); });
            head.appendChild(b);
        }
        return cw;
    }

    function invoke(cmd, args) {
        return T().invoke(cmd, args).catch(e => { const m = String(e && e.message || e); console.error(cmd, m); return Promise.reject(m); });
    }

    function setAddr(v, url) {
        if (url) v.url = url;
        if (document.activeElement !== v.addr) v.addr.value = v.url;
    }

    function show(hub, tab, url) {
        const v = hub._cw[tab];
        const r = v.slot.getBoundingClientRect();
        v.rect = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
        invoke('web_show', { label: v.label, x: r.left, y: r.top, w: r.width, h: r.height, url: url || null })
            .then(u => { v.slot.innerHTML = ''; setAddr(v, u); })
            .catch(m => { v.slot.innerHTML = `<p class="hub-empty">웹 화면을 못 띄웠어요: ${esc(m)}</p>`; });
    }

    function act(hub, tab, what) {
        const v = hub._cw[tab];
        if (what === 'alt') { setMode(tab, 'app'); hub.setCenterTab(tab); return; }
        if (what === 'chat') {
            if (!v.url) return;
            const input = hub.el('hub-input');
            const before = input && input.value && !/\s$/.test(input.value.slice(0, input.selectionStart ?? input.value.length)) ? ' ' : '';
            hub.insertText(`${before}${v.url} `);
            return;
        }
        if (what === 'chrome') { if (v.url) (realOpen || HubGitHub.openUrl).call(HubGitHub, hub, v.url); return; }
        if (what === 'repo') {
            const i = hub.github && hub.github.info;
            if (i && i.web) show(hub, tab, i.web);
            else hub.map._toast('고른 세션이 GitHub 저장소가 아니에요');
            return;
        }
        invoke('web_go', { label: v.label, action: what }).then(u => setAddr(v, u)).catch(m => hub.map._toast(m));
    }

    // 보이는 동안: 자리가 바뀌면 다시 맞추고, 주소창은 1.5초마다 지금 주소로
    function loop(hub) {
        if (hub._cwLoop) return;
        let last = 0;
        const step = t => {
            const tab = hub._cwOn;
            if (!tab) { hub._cwLoop = null; return; }
            const v = hub._cw[tab];
            const r = v.slot.getBoundingClientRect();
            const key = [r.left, r.top, r.width, r.height].map(Math.round).join(',');
            if (key !== v.rect) show(hub, tab);
            if (t - last > 1500) { last = t; invoke('web_url', { label: v.label }).then(u => setAddr(v, u)).catch(() => {}); }
            hub._cwLoop = requestAnimationFrame(step);
        };
        hub._cwLoop = requestAnimationFrame(step);
    }

    function wire() {
        const P = SessionHub.prototype;
        if (P._cwWired || !P.setCenterTab) return;
        P._cwWired = true;
        const setCenterTab = P.setCenterTab;
        P.setCenterTab = function (tab) {
            setCenterTab.call(this, tab);
            if (!T()) return;
            const cw = build(this);
            const prev = this._cwOn;
            this._cwOn = VIEWS[tab] && mode(tab) === 'web' ? tab : null;
            for (const [t, v] of Object.entries(cw)) {
                v.box.hidden = t !== this._cwOn;
                if (t !== this._cwOn && (prev === t || v.rect)) { v.rect = ''; invoke('web_hide', { label: v.label }).catch(() => {}); }
            }
            if (!this._cwOn) return;
            // 예전 칸들은 숨긴다 (GitHub 맵은 MindMapGitHub 가 켜 두지만 안 보임)
            for (const id of ['center-row', 'panel-browser']) { const el = document.getElementById(id); if (el) el.hidden = true; }
            const url = this._cwPendingUrl || null;
            this._cwPendingUrl = null;
            show(this, this._cwOn, url);
            loop(this);
        };
        // Claude 가 앱 화면에 주소를 열면 (web_control.rs → center-web:open) 그 탭으로 바꾸고 연다 — 사용자도 같이 본다
        const ev = window.__TAURI__ && window.__TAURI__.event;
        if (ev) ev.listen('center-web:open', e => {
            const hub = window.sessionHub, p = e.payload || {};
            if (!hub || !VIEWS[p.tab]) return;
            setMode(p.tab, 'web');
            // 탭을 바꾸면서 바로 그 주소로 (따로 show 를 또 부르면 웹뷰를 두 번 만들려다 주소가 빠진다)
            hub._cwPendingUrl = p.url;
            hub.setCenterTab(p.tab);
        });
        // "GitHub 에서 열기" 같은 github.com 주소는 가운데 GitHub 탭에서 연다
        if (typeof HubGitHub !== 'undefined') {
            realOpen = HubGitHub.openUrl;
            HubGitHub.openUrl = function (hub, url) {
                if (!T() || !/^https:\/\/github\.com\//.test(url)) return realOpen.call(this, hub, url);
                setMode('github', 'web');
                hub._cwPendingUrl = url;
                hub.setCenterTab('github');
            };
        }
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wire);
    else wire();
})();
