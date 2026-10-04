// 가운데 탭: 마인드맵 · GitHub · 브라우저 (예전엔 GitHub·브라우저가 왼쪽 탭이었다 — 좁아서 가운데로 옮김)
// - 마인드맵: 원래 세션 맵
// - GitHub: 가운데 맵이 GitHub 보기로 바뀌고(MindMapGitHub.js 가 setCenterTab 을 감싼다), 맵 오른쪽 옆에 고른 세션의 저장소 상태(#panel-github)
// - 브라우저: 맵 자리에 #panel-browser (맥의 진짜 크롬·사파리 조종)
// 왼쪽 탭(세션·파인더·메모)과는 따로 움직인다.
(function () {
    if (typeof SessionHub === 'undefined' || typeof document === 'undefined') return;
    const P = SessionHub.prototype;

    P.setCenterTab = function (tab) {
        this.centerTab = tab;
        document.querySelectorAll('.center-tabs [role=tab]').forEach(b => b.setAttribute('aria-selected', String(b.dataset.ctab === tab)));
        document.body.dataset.ctab = tab;
        const gh = document.getElementById('panel-github');
        const br = document.getElementById('panel-browser');
        const row = document.getElementById('center-row');
        if (gh) gh.hidden = tab !== 'github';
        if (br) br.hidden = tab !== 'browser';
        if (row) row.hidden = tab === 'browser';
        if (tab === 'github' && this.github) this.github.show();
        if (tab === 'browser' && this.browser) this.browser.show();
    };

    const start = P.start;
    P.start = function () {
        const r = start.apply(this, arguments);
        if (!this.centerTab) this.centerTab = 'map';
        document.querySelectorAll('.center-tabs [role=tab]').forEach(b => b.addEventListener('click', () => this.setCenterTab(b.dataset.ctab)));
        return r;
    };
})();
