/**
 * 클로드 마인드맵 (claude-mindmap) - Electron 메인 프로세스
 * =============================================================================
 * Claude Code 세션을 한눈에: 왼쪽 탭(세션 · 파인더 · 메모 · GitHub · 브라우저) | 마인드맵 | 대화창
 *
 * 화면은 index.html (src/modules/*), 일은 여기 IPC 와 src/core/* 가 한다.
 * flowcode 에서 떼어 낸 독립 앱이다. 설정·메모는 ~/.claude-mindmap/ (처음에 ~/.flowcode 에서 복사).
 */

const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('fs');

let mainWindow = null;

function createWindow() {
    mainWindow = new BrowserWindow({
        width: 1500,
        height: 950,
        webPreferences: { contextIsolation: false, nodeIntegration: true },
        title: '클로드 마인드맵',
        backgroundColor: '#16191d',
        titleBarStyle: 'hiddenInset',
        trafficLightPosition: { x: 12, y: 12 }
    });
    mainWindow.loadFile('index.html');
    if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
    mainWindow.on('closed', () => {
        mainWindow = null;
        if (claudeRunner) claudeRunner.stopAll();
    });
}

app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});

app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
});

/**
 * 세션 허브 IPC
 *
 * - 'sessions:index'          ~/.claude/projects 세션 기록 → 프로젝트 → 세션 → 파일 (+ git 상태, 다른 기기 세션)
 * - 'sessions:transcript'     고른 세션의 대화 (기록 파일이 그대로면 unchanged)
 * - 'sessions:send' / 'sessions:stop'   대화창 메시지를 claude -p (--resume) 로 실행
 * - 'sessions:pick-folder'    새 세션을 열 폴더 고르기
 */
let sessionIndexer = null;
let claudeRunner = null;

function getSessionIndexer() {
    if (!sessionIndexer) {
        const SessionIndexer = require('./src/core/SessionIndexer.js');
        sessionIndexer = new SessionIndexer();
    }
    return sessionIndexer;
}

// 기기 간 세션 공유: 내 목록은 공유 폴더에 쓰고, 다른 기기 목록은 읽기 전용으로 섞는다
let machineSync = null;
function getMachineSync() {
    if (!machineSync) {
        const MachineSync = require('./src/core/MachineSync.js');
        machineSync = new MachineSync();
    }
    return machineSync;
}

async function buildSessionIndex() {
    const SessionIndexer = require('./src/core/SessionIndexer.js');
    const MachineSync = require('./src/core/MachineSync.js');
    const index = await getSessionIndexer().index();
    try {
        await SessionIndexer.attachGit(index);
    } catch (error) {
        console.error('Session git error:', error);
    }
    const sync = getMachineSync();
    index.machine = sync.name();
    let others = [];
    try {
        sync.publish(index);
        others = sync.readOthers();
    } catch (error) {
        console.error('Machine sync error:', error); // 공유 폴더 문제로 목록까지 못 보면 안 된다
    }
    // 클로드 앱 사이드바 구조(그룹·제목·보관) — 왼쪽 목록 "클로드 앱" 보기용, 읽기만
    return { ...MachineSync.merge(index, others, Date.now()), machine: index.machine, syncDir: sync.dir(), claudeApp: require('./src/core/ClaudeApp.js').read() };
}

ipcMain.on('sessions:index', async (event) => {
    try {
        event.reply('sessions:index-result', await buildSessionIndex());
    } catch (error) {
        console.error('Session index error:', error);
        event.reply('sessions:index-result', { success: false, error: error.message });
    }
});

ipcMain.on('sessions:transcript', async (event, { file, sinceMtime } = {}) => {
    try {
        const SessionIndexer = require('./src/core/SessionIndexer.js');
        const claudeProjects = require('path').join(getSessionIndexer().claudeDir, 'projects');
        // 세션 기록 폴더 밖의 파일은 읽지 않는다
        if (!file || !require('path').resolve(file).startsWith(claudeProjects + require('path').sep)) {
            throw new Error('세션 기록 파일이 아니에요');
        }
        if (sinceMtime && fs.statSync(file).mtimeMs === sinceMtime) {
            event.reply('sessions:transcript-result', { file, unchanged: true });
            return;
        }
        const t = await SessionIndexer.readTranscript(file);
        event.reply('sessions:transcript-result', { file, ...t });
    } catch (error) {
        event.reply('sessions:transcript-result', { file, error: error.message });
    }
});

// 툰 허브 전문: 세션 목록에 나온 폴더의 .toon 만 읽는다
ipcMain.on('sessions:hub', (event, { root, topic } = {}) => {
    try {
        const indexer = getSessionIndexer();
        if (!indexer.lastRoots || !indexer.lastRoots.has(root)) throw new Error('세션 목록에 없는 폴더예요');
        const SessionIndexer = require('./src/core/SessionIndexer.js');
        event.reply('sessions:hub-result', SessionIndexer.readHub(root, topic));
    } catch (error) {
        event.reply('sessions:hub-result', { root, topic: topic || null, error: error.code === 'ENOENT' ? '이 폴더에는 툰 허브(.toon/HUB.toon)가 없어요' : error.message });
    }
});

// 세션 끌어다 놓기: 같은 폴더 세션 아래로 붙이기 / 떼기, 다른 폴더로 복사
ipcMain.on('sessions:link', (event, { root, id, parentId } = {}) => {
    try {
        event.reply('sessions:changed', { ok: true, action: parentId ? 'link' : 'unlink', ...getSessionIndexer().setParent(root, id, parentId || null) });
    } catch (error) {
        event.reply('sessions:changed', { ok: false, error: error.message });
    }
});

// 새로 만든 세션 제자리 잡기: 하위 세션 · 줄기(툰 이어가기) · 주제 가지
ipcMain.on('sessions:meta', (event, { root, id, parentId, prevId, topic, kind } = {}) => {
    try {
        event.reply('sessions:changed', { ok: true, action: 'meta', quiet: true, ...getSessionIndexer().setMeta(root, id, { parentId, prevId, topic, kind }) });
    } catch (error) {
        event.reply('sessions:changed', { ok: false, error: error.message });
    }
});

ipcMain.on('sessions:copy', (event, { root, id, toRoot, parentId } = {}) => {
    try {
        const indexer = getSessionIndexer();
        if (!indexer.lastRoots || !indexer.lastRoots.has(toRoot)) throw new Error('세션 목록에 없는 폴더로는 복사하지 않아요');
        const copied = indexer.copySession(root, id, toRoot);
        let linked = null;
        if (parentId) {
            indexer.lastSessions.set(`${toRoot}::${copied.id}`, { id: copied.id }); // 바로 붙일 수 있게 임시 등록
            linked = indexer.setParent(toRoot, copied.id, parentId);
        }
        event.reply('sessions:changed', { ok: true, action: 'copy', ...copied, parentId: linked ? linked.parentId : null });
    } catch (error) {
        event.reply('sessions:changed', { ok: false, error: error.message });
    }
});

ipcMain.on('sessions:move', (event, { root, id, toRoot, parentId } = {}) => {
    try {
        const indexer = getSessionIndexer();
        if (!indexer.lastRoots || !indexer.lastRoots.has(toRoot)) throw new Error('세션 목록에 없는 폴더로는 옮기지 않아요');
        const moved = indexer.moveSession(root, id, toRoot);
        let linked = null;
        if (parentId) {
            indexer.lastSessions.set(`${toRoot}::${id}`, { id }); // 바로 붙일 수 있게 임시 등록
            linked = indexer.setParent(toRoot, id, parentId);
        }
        event.reply('sessions:changed', { ok: true, action: 'move', ...moved, parentId: linked ? linked.parentId : null });
    } catch (error) {
        event.reply('sessions:changed', { ok: false, error: error.message });
    }
});

// 코드 보기: 세션 목록에 있는 폴더 안 글자 파일만, 512KB 까지
ipcMain.on('read-file', (event, { path: file } = {}) => {
    const path = require('path');
    try {
        let real;
        try { real = fs.realpathSync(file); } catch { throw new Error('파일이 없어요 (지워졌거나 옮겨졌어요)'); }
        const roots = [...(getSessionIndexer().lastRoots || [])];
        const inside = roots.some(r => { try { const rr = fs.realpathSync(r); return real === rr || real.startsWith(rr + path.sep); } catch { return false; } });
        if (!inside) throw new Error('세션 폴더 밖 파일은 열지 않아요');
        const st = fs.statSync(real);
        if (!st.isFile()) throw new Error('파일이 아니에요');
        const MAX = 512 * 1024;
        const fd = fs.openSync(real, 'r');
        const buf = Buffer.alloc(Math.min(st.size, MAX));
        try { fs.readSync(fd, buf, 0, buf.length, 0); } finally { fs.closeSync(fd); }
        if (buf.includes(0)) throw new Error('글자 파일이 아니에요');
        event.reply('read-file-result', { path: file, text: buf.toString('utf8'), size: st.size, truncated: st.size > MAX });
    } catch (error) {
        event.reply('read-file-result', { path: file, error: error.message });
    }
});

// 허용 묻기: 대화창에서 보낸 claude 가 물을 도구를 쓰려 할 때 (scripts/mindmap-approve-mcp.js)
ipcMain.on('approval:list', event => event.reply('approval:list-result', { items: require('./src/core/Approvals.js').list() }));
ipcMain.on('approval:answer', (event, { id, allow, always } = {}) => {
    try {
        event.reply('approval:answer-result', require('./src/core/Approvals.js').answer(id, !!allow, !!always));
    } catch (error) {
        event.reply('approval:answer-result', { error: error.message });
    }
});

// 세션 제목 바꾸기 = 기록 파일에 custom-title 줄 붙이기
ipcMain.on('sessions:rename', (event, { root, id, title } = {}) => {
    try {
        event.reply('sessions:changed', { ok: true, action: 'rename', ...getSessionIndexer().renameSession(root, id, title) });
    } catch (error) {
        event.reply('sessions:changed', { ok: false, error: error.message });
    }
});

// 세션 지우기 = 앱 휴지통(~/.claude-mindmap/trash)으로 옮기기
ipcMain.on('sessions:trash', (event, { root, id } = {}) => {
    try {
        event.reply('sessions:changed', { ok: true, action: 'trash', ...getSessionIndexer().trashSession(root, id) });
    } catch (error) {
        event.reply('sessions:changed', { ok: false, error: error.message });
    }
});

// ---------------------------------------------------------------------
// 세션 허브: 파인더 (폴더 목록만 읽는다, 파일 내용은 읽지 않음)
// ---------------------------------------------------------------------
ipcMain.on('fs:list', (event, { dir, showHidden } = {}) => {
    const path = require('path');
    const os = require('os');
    const target = path.resolve(dir || os.homedir());
    try {
        const items = fs.readdirSync(target, { withFileTypes: true })
            .filter(d => showHidden || !d.name.startsWith('.'))
            .slice(0, 3000)
            .map(d => {
                const full = path.join(target, d.name);
                let st = null;
                try { st = fs.statSync(full); } catch { /* 깨진 링크 등 */ }
                return { name: d.name, path: full, isDir: st ? st.isDirectory() : d.isDirectory(), size: st ? st.size : 0, mtime: st ? st.mtimeMs : 0 };
            })
            .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, 'ko'));
        const parent = path.dirname(target);
        event.reply('fs:list-result', { dir: target, parent: parent !== target ? parent : null, home: os.homedir(), entries: items });
    } catch (error) {
        event.reply('fs:list-result', { dir: target, home: os.homedir(), error: error.code === 'EACCES' ? '이 폴더를 열 권한이 없어요' : error.message });
    }
});

// ---------------------------------------------------------------------
// 세션 허브: 메모 (비밀 메모는 safeStorage 로 암호화)
// ---------------------------------------------------------------------
let memoStore = null;
function getMemoStore() {
    if (!memoStore) {
        const MemoStore = require('./src/core/MemoStore.js');
        const { safeStorage } = require('electron');
        memoStore = new MemoStore({ safeStorage });
    }
    return memoStore;
}
const memoReply = (event, fn) => {
    try {
        const result = fn();
        event.reply('memos:result', { ok: true, ...result, ...getMemoStore().list() });
    } catch (error) {
        event.reply('memos:result', { ok: false, error: error.message, ...getMemoStore().list() });
    }
};
ipcMain.on('memos:list', (event) => memoReply(event, () => ({})));
ipcMain.on('memos:save', (event, memo = {}) => memoReply(event, () => ({ saved: getMemoStore().save(memo) })));
ipcMain.on('memos:delete', (event, { id } = {}) => memoReply(event, () => ({ deleted: getMemoStore().remove(id) })));
ipcMain.on('memos:reveal', (event, { id, purpose } = {}) => {
    try {
        event.reply('memos:reveal-result', { ok: true, purpose, ...getMemoStore().reveal(id) });
    } catch (error) {
        event.reply('memos:reveal-result', { ok: false, id, purpose, error: error.message });
    }
});

// ---------------------------------------------------------------------
// 세션 허브: GitHub 탭 (git / gh)
// ---------------------------------------------------------------------
let gitPanel = null;
function getGitPanel() {
    if (!gitPanel) {
        const GitPanel = require('./src/core/GitPanel.js');
        gitPanel = new GitPanel();
    }
    return gitPanel;
}
const gitReply = (event, channel, base, promise) => promise
    .then(r => event.reply(channel, { ok: true, ...base, ...r }))
    .catch(error => event.reply(channel, { ok: false, ...base, error: error.message }));
ipcMain.on('git:info', (event, { cwd } = {}) => gitReply(event, 'git:info-result', { cwd }, getGitPanel().info(cwd)));
ipcMain.on('git:diff', (event, { root, file } = {}) => gitReply(event, 'git:diff-result', { root, file }, getGitPanel().diff(root, file)));
ipcMain.on('git:action', (event, req = {}) => gitReply(event, 'git:action-result', { root: req.root, action: req.action }, getGitPanel().action(req.root, req)));
ipcMain.on('gh:list', (event, { root, what } = {}) => gitReply(event, 'gh:list-result', { root, what }, getGitPanel().ghList(root, what)));
// GitHub 마인드맵: 내 저장소 목록 · 저장소 하나의 PR·최근 브랜치 (src/core/GitHubMap.js)
let gitHubMap = null;
const getGitHubMap = () => gitHubMap || (gitHubMap = new (require('./src/core/GitHubMap.js'))({ gitPanel: getGitPanel() }));
ipcMain.on('gh:repos', (event, { roots } = {}) => gitReply(event, 'gh:repos-result', {}, getGitHubMap().repos(roots || [])));
ipcMain.on('gh:repo-detail', (event, { slug } = {}) => gitReply(event, 'gh:repo-detail-result', { slug }, getGitHubMap().detail(slug)));
ipcMain.on('claude-app:handoff', (event, { id, text, appId } = {}) => event.reply('claude-app:handoff-result', { ok: require('./src/core/ClaudeApp.js').handOff(id, text, appId) }));
ipcMain.on('claude-app:focus', (event, { appId } = {}) => event.reply('claude-app:focus-result', { ok: require('./src/core/ClaudeApp.js').focus(appId), appId }));
// AX 보내기는 Tauri 판만 — 여기서는 복사로 넘기게 한다
ipcMain.on('claude-app:send', (event, { id, appId } = {}) => event.reply('claude-app:send-result', { ok: false, id, appId, reason: 'unsupported' }));
ipcMain.on('claude-app:new', (event, { folder, prompt } = {}) => event.reply('claude-app:new-result', { ok: require('./src/core/ClaudeApp.js').newInApp(folder, prompt) }));
// 웹 주소는 기본 브라우저로 (http/https 만)
ipcMain.on('open-external', (event, { url } = {}) => {
    if (/^https?:\/\//.test(String(url || ''))) require('electron').shell.openExternal(url);
});

// ---------------------------------------------------------------------
// 세션 허브: 사용량 (지금 세션 5시간 한도 · 주간 한도)
// ---------------------------------------------------------------------
let usageMeter = null;
ipcMain.on('usage:read', async (event) => {
    if (!usageMeter) {
        const UsageMeter = require('./src/core/UsageMeter.js');
        usageMeter = new UsageMeter();
    }
    try {
        event.reply('usage:result', await usageMeter.read());
    } catch (error) {
        event.reply('usage:result', { ok: false, error: error.message, at: Date.now() });
    }
});

// ---------------------------------------------------------------------
// 세션 허브: 브라우저 탭 (맥의 진짜 크롬·사파리를 애플스크립트로 조종)
// ---------------------------------------------------------------------
const browserSettingsFile = () => require('./src/core/appDir.js').settingsFile('browser.json');
function readBrowserSettings() {
    try { return { browser: 'chrome', engine: 'google', ...JSON.parse(fs.readFileSync(browserSettingsFile(), 'utf8')) }; }
    catch { return { browser: 'chrome', engine: 'google' }; }
}
function runQuiet(bin, args, extraEnv) {
    const { childEnv } = require('./src/core/loginPath.js');
    return new Promise(resolve => {
        require('child_process').execFile(bin, args, { env: childEnv(extraEnv), timeout: 30000 }, (err, stdout, stderr) =>
            resolve({ code: err ? (typeof err.code === 'number' ? err.code : 127) : 0, out: (stdout + stderr).trim() }));
    });
}
ipcMain.on('browser:get', async (event) => {
    const settings = readBrowserSettings();
    const r = await runQuiet('claude', ['mcp', 'get', 'mindmap-browser']);
    event.reply('browser:settings', { ...settings, mcp: r.code === 0, platform: process.platform });
});
ipcMain.on('browser:set', (event, next = {}) => {
    const BrowserBridge = require('./src/core/BrowserBridge.js');
    const cur = readBrowserSettings();
    const settings = {
        browser: BrowserBridge.BROWSERS[next.browser] ? next.browser : cur.browser,
        engine: next.engine === 'naver' ? 'naver' : next.engine === 'google' ? 'google' : cur.engine
    };
    fs.mkdirSync(require('path').dirname(browserSettingsFile()), { recursive: true });
    fs.writeFileSync(browserSettingsFile(), JSON.stringify(settings, null, 2));
    event.reply('browser:settings', { ...settings, saved: true });
});
ipcMain.on('browser:do', async (event, { op, args = {} } = {}) => {
    const BrowserBridge = require('./src/core/BrowserBridge.js');
    const settings = readBrowserSettings();
    try {
        const b = new BrowserBridge({ browser: settings.browser });
        let data;
        if (op === 'tabs') data = await b.tabs();
        else if (op === 'open') data = await b.open(args.url, { newTab: args.newTab !== false });
        else if (op === 'search') data = await b.search(args.query, args.engine || settings.engine);
        else if (op === 'activate') data = await b.activate(args.window, args.tab);
        else if (op === 'read') data = await b.read({ maxChars: 20000 });
        else if (op === 'navigate') data = await b.navigate(args.action);
        else throw new Error('모르는 작업이에요');
        event.reply('browser:result', { ok: true, op, data });
    } catch (error) {
        event.reply('browser:result', { ok: false, op, error: error.message });
    }
});
// Claude Code 에 MCP 서버로 등록: 등록하면 모든 세션이 browser_* 도구로 이 브라우저를 조종한다
ipcMain.on('browser:register', async (event) => {
    const path = require('path');
    const script = path.join(__dirname, 'scripts', 'mindmap-browser-mcp.js');
    const node = await runQuiet('which', ['node']);
    const args = node.code === 0 && node.out
        ? ['mcp', 'add', '--scope', 'user', 'mindmap-browser', '--', node.out.split('\n')[0], script]
        : ['mcp', 'add', '--scope', 'user', '-e', 'ELECTRON_RUN_AS_NODE=1', 'mindmap-browser', '--', process.execPath, script];
    await runQuiet('claude', ['mcp', 'remove', '--scope', 'user', 'mindmap-browser']);
    await runQuiet('claude', ['mcp', 'remove', '--scope', 'user', 'flowcode-browser']); // 예전 이름 (flowcode 와 같이 쓰던 때)
    const r = await runQuiet('claude', args);
    event.reply('browser:register-result', r.code === 0 ? { ok: true, out: r.out } : { ok: false, error: r.code === 127 ? 'claude 를 찾지 못했어요' : r.out });
});

ipcMain.on('sessions:send', (event, req = {}) => {
    const sender = event.sender;
    const send = (channel, data) => { if (!sender.isDestroyed()) sender.send(channel, data); };
    try {
        if (!claudeRunner) {
            const ClaudeRunner = require('./src/core/ClaudeRunner.js');
            claudeRunner = new ClaudeRunner();
        }
        // 물을 도구는 막지 않고 화면에 묻는다 (클로드 앱처럼). 스크립트 경로는 화면 값을 믿지 않고 여기서 정한다
        req = { ...req, approveScript: require('path').join(__dirname, 'scripts', 'mindmap-approve-mcp.js') };
        // 클로드 앱에도 보이게: 새 세션은 첫 session_id 가 오는 순간, 답이 끝날 때마다 한 번 더 (claude://resume)
        const ClaudeApp = require('./src/core/ClaudeApp.js');
        let shownId = req.sessionId || null;
        claudeRunner.run(req,
            ev => {
                if (!shownId && ev && ev.session_id) { shownId = ev.session_id; ClaudeApp.showInApp(shownId); }
                send('sessions:run-event', { runId: req.runId, event: ev });
            },
            exit => { if (shownId) ClaudeApp.showInApp(shownId); send('sessions:run-exit', { runId: req.runId, ...exit }); });
    } catch (error) {
        send('sessions:run-exit', { runId: req.runId, code: null, stopped: false, error: error.message });
    }
});

ipcMain.on('sessions:stop', (event, { runId } = {}) => {
    if (claudeRunner) claudeRunner.stop(runId);
});

ipcMain.on('sessions:pick-folder', async (event) => {
    const { dialog } = require('electron');
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = await dialog.showOpenDialog(win, { properties: ['openDirectory', 'createDirectory'], title: '폴더 고르기 (새 폴더도 만들 수 있어요)', buttonLabel: '선택' });
    if (result.canceled) { event.reply('sessions:pick-folder-result', { path: null }); return; }
    // 고른 폴더는 세션이 아직 없어도 목록·지도에 보이게 기억한다
    let root = result.filePaths[0];
    try { root = getSessionIndexer().addFolder(result.filePaths[0]); } catch (error) { console.error('add folder:', error); }
    event.reply('sessions:pick-folder-result', { path: root });
});
