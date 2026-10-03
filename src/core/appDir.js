/**
 * appDir - 클로드 마인드맵 설정 폴더 (~/.claude-mindmap)
 * =============================================================================
 * 예전에는 flowcode 와 ~/.flowcode 를 같이 썼다. 처음 쓸 때 거기 있던 파일을 복사해 온다
 * (옮기지 않는다 — flowcode 는 그대로 동작). 이미 있는 파일은 덮어쓰지 않는다.
 * MINDMAP_HOME 으로 폴더를 바꿀 수 있다 (테스트용).
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const OLD_FILES = ['memos.json', 'session-links.json', 'folders.json', 'browser.json', 'machine.json', 'sync.json'];
let migrated = false;

function settingsDir(home = os.homedir()) {
    if (process.env.MINDMAP_HOME) return process.env.MINDMAP_HOME;
    const dir = path.join(home, '.claude-mindmap');
    if (!migrated) {
        migrated = true;
        migrate(path.join(home, '.flowcode'), dir);
    }
    return dir;
}

/** oldDir 의 설정 파일을 newDir 로 복사 (없는 것만). 복사한 이름들을 돌려준다 */
function migrate(oldDir, newDir) {
    const copied = [];
    for (const name of OLD_FILES) {
        const from = path.join(oldDir, name);
        const to = path.join(newDir, name);
        try {
            if (!fs.existsSync(from) || fs.existsSync(to)) continue;
            fs.mkdirSync(newDir, { recursive: true, mode: 0o700 });
            fs.copyFileSync(from, to);
            fs.chmodSync(to, fs.statSync(from).mode & 0o777);
            copied.push(name);
        } catch (error) {
            console.error('settings migrate:', name, error.message);
        }
    }
    return copied;
}

const settingsFile = name => path.join(settingsDir(), name);

module.exports = { settingsDir, settingsFile, migrate, OLD_FILES };
