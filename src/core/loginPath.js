/**
 * loginPath.js
 * =============================================================================
 * 맥 앱을 Finder 에서 켜면 PATH 가 /usr/bin:/bin 정도라서 claude, gh(/opt/homebrew/bin 등)를 못 찾는다.
 * 로그인+대화형 셸(-il)에서 PATH 를 한 번 읽어 와 기억해 두고, 명령은 그 PATH 로 직접 실행한다.
 * (-l 만 쓰면 .zshrc 를 안 읽어서 nvm 의 새 claude 대신 /opt/homebrew/bin 의 옛 claude 를 잡는다)
 * (로그인 셸로 명령을 바로 돌리면 셸 설정이 찍는 글자가 출력에 섞인다)
 */

const { execFileSync } = require('child_process');
const fs = require('fs');

let cached = null;

function loginPath(shell) {
    if (cached) return cached;
    const sh = shell || [process.env.SHELL, '/bin/zsh', '/bin/bash', '/bin/sh'].find(p => p && fs.existsSync(p));
    let found = '';
    try {
        const out = execFileSync(sh, ['-ilc', 'printf "\\n__FLOWCODE_PATH__%s__END__" "$PATH"'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] });
        const m = /__FLOWCODE_PATH__(.*?)__END__/s.exec(out);
        if (m) found = m[1].trim();
    } catch {
        // 셸을 못 띄우면 아래 기본값
    }
    const extra = ['/opt/homebrew/bin', '/usr/local/bin', `${process.env.HOME}/.local/bin`, `${process.env.HOME}/.claude/local`, '/usr/bin', '/bin'];
    const parts = [...found.split(':'), ...(process.env.PATH || '').split(':'), ...extra].filter(Boolean);
    cached = [...new Set(parts)].join(':');
    return cached;
}

/** 자식 프로세스 환경: 로그인 셸 PATH 를 넣는다 */
function childEnv(extra = {}) {
    return { ...process.env, PATH: loginPath(), ...extra };
}

module.exports = { loginPath, childEnv };
