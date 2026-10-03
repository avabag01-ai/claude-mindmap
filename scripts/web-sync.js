// Tauri 용 화면 파일 모으기: index.html + src/modules 를 src-tauri/web-dist 로 복사한다.
// 복사본 index.html 에만 tauriIpc.js 를 끼워 넣는다 (Electron 쪽 index.html 은 그대로).
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const out = path.join(root, 'src-tauri', 'web-dist');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, 'src', 'modules'), { recursive: true });
for (const f of fs.readdirSync(path.join(root, 'src', 'modules'))) {
    if (f.endsWith('.js')) fs.copyFileSync(path.join(root, 'src', 'modules', f), path.join(out, 'src', 'modules', f));
}
fs.copyFileSync(path.join(root, 'src-tauri', 'tauriIpc.js'), path.join(out, 'src', 'modules', 'tauriIpc.js'));
const html = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const tag = '<script src="src/modules/SessionMindMap.js"></script>';
if (!html.includes(tag)) throw new Error('index.html 에 SessionMindMap.js 태그가 없어요');
fs.writeFileSync(path.join(out, 'index.html'), html.replace(tag, '<script src="src/modules/tauriIpc.js"></script>\n    ' + tag));
console.log('web-dist 준비:', out);
