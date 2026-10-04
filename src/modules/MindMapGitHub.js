// GitHub 마인드맵: 왼쪽 "GitHub" 탭을 누르면 가운데 맵이 GitHub 보기로 바뀐다 (다른 탭으로 가면 원래 세션 맵).
//   가운데 계정 → 묶음(클로드 앱 그룹, 못 맞추면 언어) → 저장소 → (▸ 펼치면) 열린 PR · 최근 브랜치
// - 묶음: 저장소의 로컬 폴더(세션 폴더의 origin) → 그 폴더 세션들이 든 클로드 앱 그룹 중 가장 많은 것
// - 저장소 색 = 마지막 푸시가 얼마나 최근인지. 노드를 누르면 정보 창: "세션 맵 보기"(로컬 폴더) · "GitHub 에서 열기"(맥의 진짜 브라우저)
// - 그리기·끌기·자리 기억·−/＋ 단계 접기는 SessionMindMap 것을 그대로 쓰고, 여기서는 트리만 바꿔 넣는다.
// 데이터: 'gh:repos' · 'gh:repo-detail' (src-tauri/src/github_map.rs · src/core/GitHubMap.js). 읽기만 한다.
// MindMapTools.js 보다 먼저 불러야 단계 접기가 이 트리에도 걸린다.
(function () {
    if (typeof SessionMindMap === 'undefined' || typeof document === 'undefined') return;
    const P = SessionMindMap.prototype;
    const esc = s => SessionMindMap._esc(s == null ? '' : s);
    const W = (s, size) => SessionMindMap._textWidth(s, size);
    const clip = (s, n) => SessionMindMap._clip(s, n);
    const DAY = 864e5;
    const STALE_MS = 10 * 60e3; // GitHub 탭을 다시 열 때 이보다 오래됐으면 다시 읽는다

    // 최근 푸시 정도 → 색 (밝을수록 최근)
    const AGES = [
        [DAY, '#3fb950', '하루 안'],
        [7 * DAY, '#58a6ff', '7일 안'],
        [30 * DAY, '#d29922', '30일 안'],
        [90 * DAY, '#a371f7', '90일 안'],
        [Infinity, '#6e7681', '더 오래']
    ];
    function ageColor(iso, now) {
        const t = Date.parse(iso || '');
        if (!t) return AGES[AGES.length - 1][1];
        return AGES.find(a => now - t <= a[0])[1];
    }

    function state(map) {
        if (!map.gh) {
            // 묶음은 처음엔 모두 접어 둔다 (저장소가 많아 빽빽해서). 펼친 묶음만 기억
            let unfolded = [];
            try { unfolded = JSON.parse(localStorage.getItem('gh.unfolded') || '[]'); } catch { /* 미리보기 */ }
            map.gh = { on: false, data: null, loading: false, error: null, at: 0, detail: new Map(), open: new Set(), unfolded: new Set(unfolded) };
        }
        return map.gh;
    }
    const on = map => !!(map.gh && map.gh.on);

    // ---------------------------------------------------------------------
    // 데이터 읽기
    // ---------------------------------------------------------------------
    function listen(map) {
        const g = state(map);
        if (g.listening || !map.ipc) return;
        g.listening = true;
        map.ipc.on('gh:repos-result', (e, r) => {
            g.loading = false;
            if (r && r.ok) { g.data = r; g.error = null; g.at = Date.now(); } else g.error = (r && r.error) || '알 수 없는 오류';
            if (on(map)) { map._fitPending = true; map.render(); }
        });
        map.ipc.on('gh:repo-detail-result', (e, r) => {
            if (!r || !r.slug) return;
            g.detail.set(r.slug, r.ok ? r : { error: r.error || '알 수 없는 오류' });
            if (on(map)) { map.render(); if (map.selected && map.byKey.get(map.selected.key)) map._showInfo(map.byKey.get(map.selected.key)); }
        });
    }

    function load(map) {
        const g = state(map);
        if (!map.ipc) { g.error = '미리보기에서는 GitHub 을 읽을 수 없어요 (맥 앱에서 돼요)'; return; }
        listen(map);
        if (g.loading) return;
        g.loading = true;
        g.error = null;
        g.detail.clear();
        const roots = map.data ? map.data.projects.filter(p => !p.remoteOnly).map(p => p.root) : [];
        map.ipc.send('gh:repos', { roots });
    }

    function toggleRepo(map, slug) {
        const g = state(map);
        if (g.open.has(slug)) g.open.delete(slug);
        else {
            g.open.add(slug);
            const d = g.detail.get(slug);
            if ((!d || d.error) && map.ipc) { listen(map); g.detail.set(slug, { loading: true }); map.ipc.send('gh:repo-detail', { slug }); }
        }
        map.render();
    }

    function toggleGroup(map, name) {
        const g = state(map);
        if (g.unfolded.has(name)) g.unfolded.delete(name); else g.unfolded.add(name);
        try { localStorage.setItem('gh.unfolded', JSON.stringify([...g.unfolded])); } catch { /* 미리보기 */ }
        map.render();
    }

    // ---------------------------------------------------------------------
    // 묶음: 로컬 폴더 → 그 폴더 세션들의 클로드 앱 그룹 (가장 많은 것), 없으면 언어
    // ---------------------------------------------------------------------
    function groupRepos(map, repos) {
        const d = map.gh.data;
        const app = map.data && map.data.claudeApp && map.data.claudeApp.ok ? map.data.claudeApp : null;
        const rootsOf = new Map(); // "주인/이름"(소문자) → [폴더]
        for (const [root, slug] of Object.entries(d.local || {})) {
            const k = slug.toLowerCase();
            if (!rootsOf.has(k)) rootsOf.set(k, []);
            rootsOf.get(k).push(root);
        }
        const groupName = new Map(app ? app.groups.map(x => [x.id, x.name]) : []);
        const appGroupOf = roots => {
            if (!app) return null;
            const count = new Map();
            for (const p of map.data.projects) {
                if (!roots.includes(p.root)) continue;
                for (const s of p.sessions) {
                    const a = !s.remote && app.sessions[s.id];
                    if (a && groupName.has(a.group)) count.set(a.group, (count.get(a.group) || 0) + 1);
                }
            }
            let best = null;
            for (const [id, c] of count) if (!best || c > count.get(best)) best = id;
            return best;
        };
        const groups = new Map();
        for (const r of repos) {
            const roots = rootsOf.get(String(r.fullName).toLowerCase()) || [];
            const gid = appGroupOf(roots);
            const name = gid ? groupName.get(gid) : r.language || '언어 없음';
            if (!groups.has(name)) groups.set(name, { name, app: !!gid, order: gid ? app.groups.findIndex(x => x.id === gid) : Infinity, repos: [] });
            groups.get(name).repos.push({ r, roots });
        }
        // 앱 그룹(앱 순서) 먼저, 그다음 언어 묶음(저장소 많은 순)
        return [...groups.values()].sort((a, b) => (a.order - b.order) || (b.repos.length - a.repos.length) || a.name.localeCompare(b.name));
    }

    // ---------------------------------------------------------------------
    // 트리
    // ---------------------------------------------------------------------
    function note(key, label) {
        return { key, kind: 'ghnote', label, color: '#8a95a1', children: [] };
    }

    function repoChildren(map, n) {
        const d = map.gh.detail.get(n.data.fullName);
        if (!d || d.loading) return [note(`ghn:${n.key}`, 'PR·브랜치 읽는 중…')];
        if (d.error) return [note(`ghn:${n.key}`, `못 읽었어요: ${clip(d.error, 40)}`)];
        const now = map.now();
        const out = d.prs.map(pr => ({ key: `ghp:${n.data.fullName}#${pr.number}`, kind: 'ghpr', label: `#${pr.number} ${pr.title}`, data: pr, repo: n, color: ageColor(pr.updatedAt, now), children: [] }));
        for (const b of d.branches) out.push({ key: `ghb:${n.data.fullName}:${b.name}`, kind: 'ghbranch', label: b.name, data: b, repo: n, color: ageColor(b.date, now), children: [] });
        return out.length ? out : [note(`ghn:${n.key}`, '열린 PR·브랜치가 없어요')];
    }

    function githubTree(map) {
        const g = state(map);
        const root = { key: 'root', kind: 'root', gh: true, label: (g.data && g.data.account) || 'GitHub', children: [] };
        if (!g.data) {
            root.children.push(note('gh:note', g.error ? `GitHub 을 못 읽었어요: ${clip(g.error, 60)}` : 'GitHub 저장소 읽는 중…'));
            return root;
        }
        const q = map.query;
        const now = map.now();
        const match = r => !q || [r.name, r.description, r.language].some(x => x && String(x).toLowerCase().includes(q));
        const repos = g.data.repos.filter(match).sort((a, b) => String(b.pushedAt).localeCompare(String(a.pushedAt)));
        for (const grp of groupRepos(map, repos)) {
            const gn = { key: `ghg:${grp.name}`, kind: 'ghgroup', group: grp.name, app: grp.app, label: grp.name, total: grp.repos.length, color: grp.app ? '#4ec9b0' : '#58a6ff', children: [] };
            if (!g.unfolded.has(grp.name) && !q) gn.hidden = grp.repos.length;
            else {
                for (const { r, roots } of grp.repos) {
                    const n = { key: `ghr:${r.fullName}`, kind: 'ghrepo', label: r.name, data: r, roots, color: ageColor(r.pushedAt, now), children: [] };
                    if (g.open.has(r.fullName)) n.children = repoChildren(map, n);
                    gn.children.push(n);
                }
            }
            root.children.push(gn);
        }
        if (!root.children.length) root.children.push(note('gh:note', q ? '맞는 저장소가 없어요' : '저장소가 없어요'));
        if (g.error) root.children.push(note('gh:err', `다시 읽기 실패: ${clip(g.error, 50)}`));
        return root;
    }

    const visibleTree = P._visibleTree;
    P._visibleTree = function () {
        return on(this) ? githubTree(this) : visibleTree.call(this);
    };

    // 끌어다 놓은 자리: GitHub 보기는 따로 기억
    const viewKey = P._viewKey;
    P._viewKey = function () {
        return on(this) ? 'github' : viewKey.call(this);
    };

    // 새로고침: GitHub 보기면 저장소를 다시 읽는다
    const refresh = P.refresh;
    P.refresh = function () {
        if (!on(this)) return refresh.call(this);
        load(this);
        this.render();
    };

    const render = P.render;
    P.render = function () {
        render.call(this);
        if (!on(this) || !this.built) return;
        const g = this.gh;
        const repos = this.nodes.filter(n => n.kind === 'ghgroup').reduce((a, n) => a + n.total, 0);
        const groups = this.nodes.filter(n => n.kind === 'ghgroup').length;
        this._setStatus(g.loading ? 'GitHub 읽는 중…' : g.data ? `저장소 ${repos} · 묶음 ${groups} · ${SessionMindMap._ago(g.at, this.now())} 기준` : '');
    };

    // ---------------------------------------------------------------------
    // 그리기
    // ---------------------------------------------------------------------
    function chip(x, y, n, open) {
        const text = open ? '▾' : n.hidden ? `▸ ${n.hidden}` : '▸';
        const w = text.length > 1 ? W(text, 10.5) + 12 : 20;
        const what = open ? '접기' : 'PR·브랜치 펼치기';
        return `<g class="smm-fold${open ? '' : ' smm-folded'}" data-fold="${esc(n.key)}" transform="translate(${x},${y})" role="button" aria-label="${what}">
            <rect x="${-w / 2}" y="-8" width="${w}" height="16" rx="8" stroke="${n.color}"/><text text-anchor="middle" dy="3.5">${text}</text><title>${what}</title></g>`;
    }

    const ago = (iso, now) => (Date.parse(iso || '') ? SessionMindMap._ago(Date.parse(iso), now) : '');
    const groupWidth = n => Math.max(84, W(clip(n.label, 18), 13) + W(String(n.total), 11) + 36);
    const repoText = (n, now) => ({ label: clip(n.label, 26), age: ago(n.data.pushedAt, now) });
    const leafLabel = n => clip(n.kind === 'ghbranch' ? `⎇ ${n.label}` : n.label, n.kind === 'ghnote' ? 60 : 34);

    const nodeSvg = P._nodeSvg;
    P._nodeSvg = function (n) {
        if (!on(this)) return nodeSvg.call(this, n);
        const at = `transform="translate(${(n.x || 0).toFixed(1)},${(n.y || 0).toFixed(1)})"`;
        const right = n.right !== undefined ? n.right : Math.cos(n.angle) >= -1e-6;
        const anchor = right ? 'start' : 'end';
        const tx = right ? 1 : -1;
        if (n.kind === 'root') {
            return `<g class="smm-node smm-root-node smm-gh-root" data-key="root" ${at}>
                <circle r="44" class="smm-core-ring"/><circle r="36" class="smm-core"/>
                <text class="smm-core-label" text-anchor="middle" dy="-1">GitHub</text>
                <text class="smm-gh-account" text-anchor="middle" dy="14">${esc(clip(n.label, 14))}</text>
                <title>${esc(n.label)} · 눌러서 다시 읽기</title></g>`;
        }
        if (n.kind === 'ghgroup') {
            const w = groupWidth(n), h = 30;
            return `<g class="smm-node smm-ghgroup${n.app ? ' smm-ghgroup-app' : ''}" data-key="${esc(n.key)}" ${at} tabindex="0">
                <rect x="${-w / 2}" y="${-h / 2}" width="${w}" height="${h}" rx="9" class="smm-ghgroup-box" style="--c:${n.color}"/>
                <text text-anchor="middle" dy="5"><tspan class="smm-ghgroup-label">${esc(clip(n.label, 18))}</tspan><tspan class="smm-ghgroup-count" dx="6">${n.total}</tspan></text>
                ${this._foldChip(0, h / 2 + 9, n, '저장소')}
                <title>${n.app ? '클로드 앱 그룹' : '언어'} "${esc(n.label)}" · 저장소 ${n.total}개 · 눌러서 ${n.hidden ? '펼치기' : '접기'}</title></g>`;
        }
        if (n.kind === 'ghrepo') {
            const r = n.data;
            const { label, age } = repoText(n, this.now());
            const lw = W(label, 11.5), aw = age ? W(age, 10) + 6 : 0;
            const end = tx * (10 + lw + aw + 14);
            return `<g class="smm-node smm-ghrepo${r.archived ? ' smm-gh-archived' : ''}" data-key="${esc(n.key)}" ${at} tabindex="0">
                <circle r="5.5" fill="${n.color}" class="smm-gh-dot${n.roots.length ? ' smm-gh-local' : ''}"/>
                <text x="${tx * 10}" dy="4" text-anchor="${anchor}" class="smm-label smm-gh-repo-label">${right ? `${esc(label)}<tspan class="smm-gh-age" dx="6">${esc(age)}</tspan>` : `<tspan class="smm-gh-age">${esc(age)}</tspan><tspan dx="6">${esc(label)}</tspan>`}</text>
                ${chip(end, 0, n, n.children.length > 0)}
                <title>${esc(r.fullName)}${r.private ? ' · 비공개' : ''}${r.fork ? ' · 포크' : ''}${r.archived ? ' · 보관됨' : ''}${r.language ? ` · ${esc(r.language)}` : ''} · 마지막 푸시 ${esc(age || '모름')}${n.roots.length ? ' · 이 맥에 폴더 있음' : ''}</title></g>`;
        }
        const label = leafLabel(n);
        const icon = n.kind === 'ghpr' ? `<rect x="-6" y="-5" width="12" height="10" rx="3" fill="${n.color}"/>` : n.kind === 'ghnote' ? '' : `<circle r="3.5" fill="${n.color}"/>`;
        const sub = n.kind === 'ghbranch' ? ago(n.data.date, this.now()) + (n.data.isDefault ? ' · 기본' : '') : n.kind === 'ghpr' && n.data.isDraft ? 'draft' : '';
        return `<g class="smm-node smm-${n.kind}" data-key="${esc(n.key)}" ${at} tabindex="0">${icon}
            <text x="${tx * 10}" dy="3.5" text-anchor="${anchor}" class="smm-label smm-file-label">${right ? `${esc(label)}${sub ? `<tspan class="smm-gh-age" dx="6">${esc(sub)}</tspan>` : ''}` : `${sub ? `<tspan class="smm-gh-age">${esc(sub)}</tspan><tspan dx="6">` : '<tspan>'}${esc(label)}</tspan>`}</text>
            <title>${esc(n.label)}${sub ? ` · ${esc(sub)}` : ''}</title></g>`;
    };

    const box = P._box;
    P._box = function (n) {
        if (!on(this)) return box.call(this, n);
        const side = (w, before, after, y0, y1) => n.right ? [-before, w + after, y0, y1] : [-(w + after), before, y0, y1];
        if (n.kind === 'root') return [-48, 48, -48, 48];
        if (n.kind === 'ghgroup') { const w = groupWidth(n); return [-w / 2 - 4, w / 2 + 4, -19, n.hidden || n.children.length ? 32 : 18]; }
        if (n.kind === 'ghrepo') {
            const { label, age } = repoText(n, this.now());
            return side(W(label, 11.5) + (age ? W(age, 10) + 6 : 0) + 34, 7, 12, -10, 10);
        }
        const sub = n.kind === 'ghbranch' ? 70 : 0;
        return side(W(leafLabel(n), 11) + sub, 7, 12, -9, 9);
    };

    // ---------------------------------------------------------------------
    // 누르기
    // ---------------------------------------------------------------------
    const toggleFold = P._toggleFold;
    P._toggleFold = function (key) {
        if (!on(this)) return toggleFold.call(this, key);
        const n = this.byKey.get(key);
        if (n && n.kind === 'ghgroup') return toggleGroup(this, n.group);
        if (n && n.kind === 'ghrepo') return toggleRepo(this, n.data.fullName);
        return toggleFold.call(this, key);
    };

    const onNodeClick = P._onNodeClick;
    P._onNodeClick = function (e) {
        if (!on(this) || e.target.closest('.smm-fold')) return onNodeClick.call(this, e);
        if (this._suppressClick) return;
        const el = e.target.closest('.smm-node');
        const n = el && this.byKey.get(el.dataset.key);
        if (!n) return;
        e.stopPropagation();
        if (n.kind === 'root') { load(this); this.render(); return; }
        if (n.kind === 'ghgroup') { toggleGroup(this, n.group); return; }
        if (n.kind === 'ghnote') { if (n.key.startsWith('gh:')) { load(this); this.render(); } return; }
        this.selected = { key: n.key };
        this._drawSelection();
        this._showInfo(n);
    };

    // 고른 노드 아래(저장소의 PR·브랜치)는 흐리게 하지 않는다
    const drawSelection = P._drawSelection;
    P._drawSelection = function () {
        drawSelection.call(this);
        const sel = on(this) && this.selected && this.byKey.get(this.selected.key);
        if (!sel) return;
        const keep = new Set([sel.key, ...sel.children.map(c => c.key)]);
        if (sel.repo) keep.add(sel.repo.key);
        for (const el of this.gNodes.querySelectorAll('.smm-dim')) if (keep.has(el.dataset.key)) { el.classList.remove('smm-dim'); el.classList.add('smm-on'); }
    };

    function webOfBranch(repo, name) {
        return `${repo.url}/tree/${String(name).split('/').map(encodeURIComponent).join('/')}`;
    }

    function localButton(n) {
        const roots = n.kind === 'ghrepo' ? n.roots : n.repo ? n.repo.roots : [];
        return roots.length ? `<button class="smm-btn" data-act="gh-local" data-root="${esc(roots[0])}" title="${esc(roots[0])}">세션 맵 보기</button>` : '';
    }

    const showInfo = P._showInfo;
    P._showInfo = function (n) {
        if (!n || !on(this) || !/^gh/.test(n.kind)) return showInfo.call(this, n);
        const now = this.now();
        let html = '';
        if (n.kind === 'ghrepo') {
            const r = n.data;
            const d = this.gh.detail.get(r.fullName);
            const pills = [r.private ? '비공개' : '공개', r.fork ? '포크' : '', r.archived ? '보관됨' : '', r.language || ''].filter(Boolean).map(x => `<span class="smm-pill">${esc(x)}</span>`).join('');
            html = `<h4><i class="smm-swatch" style="background:${n.color}"></i>${esc(r.name)}</h4>
                <div class="smm-meta">${pills}</div>
                <dl>${r.description ? `<dt>설명</dt><dd>${esc(r.description)}</dd>` : ''}
                <dt>마지막 푸시</dt><dd>${r.pushedAt ? `${SessionMindMap._fmt(Date.parse(r.pushedAt))} (${ago(r.pushedAt, now)})` : '없음'}</dd>
                <dt>이 맥의 폴더</dt><dd class="smm-mono">${n.roots.length ? n.roots.map(esc).join('<br>') : '<span class="smm-muted">세션 폴더 중에는 없어요</span>'}</dd>
                ${d && d.branchCount ? `<dt>브랜치</dt><dd>${d.branchCount}개 · 열린 PR ${d.prs.length}개</dd>` : ''}</dl>
                <div class="smm-actions"><button class="smm-btn" data-act="gh-toggle" data-slug="${esc(r.fullName)}">${this.gh.open.has(r.fullName) ? 'PR·브랜치 접기' : 'PR·브랜치 펼치기'}</button>
                ${localButton(n)}<button class="smm-btn smm-primary" data-act="gh-web" data-url="${esc(r.url)}">GitHub 에서 열기</button></div>`;
        } else if (n.kind === 'ghpr') {
            const pr = n.data;
            html = `<h4>#${pr.number} ${esc(pr.title)}</h4>
                <div class="smm-meta"><span class="smm-pill">${pr.isDraft ? 'draft PR' : '열린 PR'}</span><span>${esc(n.repo.data.name)}</span>${pr.headRefName ? `<span class="smm-mono">${esc(pr.headRefName)}</span>` : ''}</div>
                <dl>${pr.author ? `<dt>만든 사람</dt><dd>${esc(pr.author)}</dd>` : ''}<dt>마지막 변경</dt><dd>${esc(ago(pr.updatedAt, now) || '모름')}</dd></dl>
                <div class="smm-actions">${localButton(n)}<button class="smm-btn smm-primary" data-act="gh-web" data-url="${esc(pr.url)}">GitHub 에서 열기</button></div>`;
        } else if (n.kind === 'ghbranch') {
            const b = n.data;
            html = `<h4 class="smm-mono">⎇ ${esc(b.name)}</h4>
                <div class="smm-meta">${b.isDefault ? '<span class="smm-pill">기본 브랜치</span>' : ''}<span>${esc(n.repo.data.name)}</span></div>
                <dl><dt>마지막 커밋</dt><dd>${b.date ? `${SessionMindMap._fmt(Date.parse(b.date))} (${ago(b.date, now)})` : '모름'}</dd></dl>
                <div class="smm-actions">${localButton(n)}<button class="smm-btn smm-primary" data-act="gh-web" data-url="${esc(webOfBranch(n.repo.data, b.name))}">GitHub 에서 열기</button></div>`;
        } else { this.info.hidden = true; return; }
        this.info.innerHTML = `<button class="smm-close" data-act="close" aria-label="닫기">×</button>${html}`;
        this.info.style.setProperty('--smm-info-top', this._toolbarBottom() + 'px');
        this.info.hidden = false;
    };

    function openUrl(map, url) {
        const hub = map.gh.hub;
        if (hub && typeof HubGitHub !== 'undefined') HubGitHub.openUrl(hub, url); // 브라우저 탭 설정의 진짜 크롬·사파리
        else if (map.ipc) map.ipc.send('open-external', { url });
        else window.open(url, '_blank', 'noopener');
    }

    const onInfoClick = P._onInfoClick;
    P._onInfoClick = function (e) {
        const b = on(this) && e.target.closest('[data-act^="gh-"]');
        if (!b) return onInfoClick.call(this, e);
        const act = b.dataset.act;
        if (act === 'gh-web') return openUrl(this, b.dataset.url);
        if (act === 'gh-toggle') {
            toggleRepo(this, b.dataset.slug);
            const n = this.byKey.get(`ghr:${b.dataset.slug}`);
            if (n) { this._showInfo(n); this._reveal(n); }
            return;
        }
        if (act === 'gh-local') {
            const hub = this.gh.hub;
            if (hub && hub.selectFolder) { hub.setLeftTab('sessions'); hub.selectFolder(b.dataset.root); }
        }
    };

    // ---------------------------------------------------------------------
    // 켜고 끄기
    // ---------------------------------------------------------------------
    function injectStyle() {
        if (document.getElementById('smm-gh-style')) return;
        const style = document.createElement('style');
        style.id = 'smm-gh-style';
        style.textContent = `
        .smm-gh-account { fill:var(--smm-muted, #8a95a1); font-size:10.5px; }
        .smm-ghgroup { cursor:pointer; }
        .smm-ghgroup-box { fill:var(--smm-panel, #1f2329); stroke:var(--c); stroke-width:1.5; }
        .smm-ghgroup:hover .smm-ghgroup-box { stroke-width:2.5; }
        .smm-ghgroup-label { fill:var(--smm-ink, #d7dde4); font-size:13px; font-weight:700; }
        .smm-ghgroup-count, .smm-gh-age { fill:var(--smm-muted, #8a95a1); font-size:10px; }
        .smm-gh-repo-label { font-size:11.5px; }
        .smm-gh-dot { stroke:var(--smm-bg, #15181c); stroke-width:1.5; }
        .smm-gh-dot.smm-gh-local { stroke:var(--smm-ink, #d7dde4); }
        .smm-gh-archived { opacity:.5; }
        .smm-ghnote .smm-label { fill:var(--smm-muted, #8a95a1); font-style:italic; }
        .smm-legend .smm-gh-leg { display:none; }
        .smm-gh-on .smm-legend > span { display:none; }
        .smm-gh-on .smm-legend > span.smm-gh-leg { display:flex; }
        .smm-gh-on .smm-period, .smm-gh-on .smm-codebtn, .smm-gh-on .smm-check { display:none !important; }
        .smm-gh-leg i { width:9px; height:9px; border-radius:50%; display:inline-block; }
        body.gh-map-on .hub-seg { visibility:hidden; }`;
        document.head.appendChild(style);
    }

    function legend(map) {
        const el = map.container && map.container.querySelector('.smm-legend');
        if (!el || el.querySelector('.smm-gh-leg')) return;
        el.insertAdjacentHTML('beforeend', AGES.map(a => `<span class="smm-gh-leg"><i style="background:${a[1]}"></i>${a[2]} 푸시</span>`).join('') +
            '<span class="smm-gh-leg"><i style="background:transparent;border:1.5px solid var(--smm-ink)"></i>이 맥에 폴더 있음</span>');
    }

    /** GitHub 보기 켜기·끄기. hub 는 SessionHub (세션 맵으로 가기·브라우저 열기에 쓴다) */
    SessionMindMap.setGitHub = function (map, value, hub) {
        const g = state(map);
        value = !!value;
        if (hub) g.hub = hub;
        if (g.on === value) return;
        map._build();
        if (!map.built) return;
        injectStyle();
        legend(map);
        // −/＋ 단계는 보기마다 따로
        const keep = { limit: map.levelLimit, open: map.levelOpen };
        map.levelLimit = g.savedLevel ? g.savedLevel.limit : undefined;
        map.levelOpen = g.savedLevel ? g.savedLevel.open : new Set();
        g.savedLevel = keep;
        g.on = value;
        map.selected = null;
        if (map.info) map.info.hidden = true;
        map.container.querySelector('.smm-root').classList.toggle('smm-gh-on', value);
        document.body.classList.toggle('gh-map-on', value);
        const search = map.container.querySelector('.smm-search');
        if (search) search.placeholder = value ? '저장소 찾기' : '세션·파일 찾기';
        if (value && (!g.data || Date.now() - g.at > STALE_MS)) load(map);
        map._fitPending = true;
        map.render();
    };

    // 왼쪽 탭: GitHub 이면 가운데를 GitHub 보기로, 다른 탭이면 원래 세션 맵으로 (SessionHub.setLeftTab 을 감싼다)
    function wireHub() {
        if (typeof SessionHub === 'undefined' || SessionHub.prototype._ghWired) return;
        SessionHub.prototype._ghWired = true;
        const setLeftTab = SessionHub.prototype.setLeftTab;
        SessionHub.prototype.setLeftTab = function (tab) {
            setLeftTab.call(this, tab);
            const was = on(this.map);
            SessionMindMap.setGitHub(this.map, tab === 'github', this);
            const cap = document.getElementById('hub-map-caption');
            if (tab === 'github') { if (cap) cap.textContent = 'GitHub · 내 저장소'; }
            else if (was && this._applyCenter) this._applyCenter(true);
        };
        // 세션 목록이 새로 읽혀 가운데 제목이 바뀌어도 GitHub 보기면 그대로
        const applyCenter = SessionHub.prototype._applyCenter;
        if (applyCenter) SessionHub.prototype._applyCenter = function (fit) {
            applyCenter.call(this, fit);
            const cap = document.getElementById('hub-map-caption');
            if (on(this.map) && cap) cap.textContent = 'GitHub · 내 저장소';
        };
    }
    if (typeof SessionHub !== 'undefined') wireHub();
    else if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', wireHub);
})();
