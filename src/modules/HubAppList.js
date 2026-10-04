// 왼쪽 목록 "클로드 앱" 보기: 클로드 앱 코드 탭 사이드바와 같은 순서로 보여 준다.
//   고정됨 → 직접 만든 그룹(앱 순서, 최근 순) → 세션(그룹 없는 것, 만든 순) → 앱 밖 세션(터미널·마인드맵에서 만든 것)
// 머리줄을 누르면 접기·펼치기 (앱처럼, 고른 것은 기억 — hub.folded)
// 보관한 세션은 숨긴다 (앱의 "진행 중" 거르기와 같게). 제목은 앱 제목을 쓴다 (마인드맵에서 바꾼 제목이 있으면 그것).
// 데이터: 세션 목록의 claudeApp (src-tauri/src/claude_app.rs · src/core/ClaudeApp.js)
(function () {
    if (typeof SessionHub === 'undefined') return;

    /** rows = [{ p, s }] (검색 거른 것) → [{ title, rows, hint }] */
    SessionHub.appSections = function (app, rows) {
        const info = r => (!r.s.remote && app.sessions[r.s.id]) || null;
        const titled = r => { const a = info(r); return a && a.title && !r.s.customTitle ? { p: r.p, s: { ...r.s, title: a.title } } : r; };
        const live = rows.filter(r => !(info(r) && info(r).archived));
        const recent = list => list.sort((a, b) => b.s.lastAt - a.s.lastAt);
        const created = list => list.sort((a, b) => ((info(b) && info(b).createdAt) || b.s.firstAt) - ((info(a) && info(a).createdAt) || a.s.firstAt));
        const out = [];
        const pinned = live.filter(r => info(r) && info(r).pinned);
        if (pinned.length) out.push({ key: 'pinned', title: '고정됨', rows: recent(pinned) });
        const rest = live.filter(r => !pinned.includes(r));
        for (const g of app.groups) {
            const list = rest.filter(r => info(r) && info(r).group === g.id);
            if (list.length) out.push({ key: `g:${g.id}`, title: g.name, rows: recent(list), group: true });
        }
        const loose = rest.filter(r => info(r) && !app.groups.some(g => g.id === info(r).group));
        if (loose.length) out.push({ key: 'loose', title: '세션', rows: created(loose) });
        const outside = rest.filter(r => !info(r));
        if (outside.length) out.push({ key: 'outside', title: '앱 밖 세션', rows: outside.sort((a, b) => b.s.firstAt - a.s.firstAt), hint: '터미널이나 마인드맵에서 만든 세션이라 클로드 앱에는 안 보여요' });
        const archived = rows.length - live.length;
        return out.map(sec => ({ ...sec, rows: sec.rows.map(titled) })).concat(archived ? [{ title: `보관한 세션 ${archived}개는 숨김`, rows: [], note: true }] : []);
    };

    SessionHub.appListHtml = function (hub, rows, item) {
        const app = hub.data && hub.data.claudeApp;
        if (!app || !app.ok) return '<p class="hub-empty">클로드 앱 기록을 찾지 못했어요 (클로드 앱 코드 탭을 한 번 써야 생겨요)</p>';
        const esc = SessionMindMap._esc;
        return SessionHub.appSections(app, rows).map(sec => sec.note
            ? `<div class="hub-bucket hub-app-note">${esc(sec.title)}</div>`
            : (k => `<div class="hub-bucket hub-fold${sec.group ? ' hub-app-group' : ''}" role="button" tabindex="0" data-fold="${esc(k)}" aria-expanded="${!hub.folded.has(k)}"${sec.hint ? ` title="${esc(sec.hint)}"` : ''}><span class="hub-fold-arrow">${hub.folded.has(k) ? '▸' : '▾'}</span>${esc(sec.title)} <span class="hub-count">${sec.rows.length}</span></div>${hub.folded.has(k) ? '' : sec.rows.map(r => item(r)).join('')}`)(`app:${sec.key}`)).join('');
    };
})();
