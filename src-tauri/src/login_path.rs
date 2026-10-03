//! src/core/loginPath.js 를 옮긴 것.
//! 맥 앱을 Finder 에서 켜면 PATH 가 /usr/bin:/bin 정도라서 claude, gh 를 못 찾는다.
//! 로그인+대화형 셸(-il)에서 PATH 를 한 번 읽어 기억해 두고, 명령은 그 PATH 로 실행한다.

use once_cell::sync::OnceCell;
use std::process::{Command, Stdio};

static CACHED: OnceCell<String> = OnceCell::new();

pub fn login_path() -> &'static str {
    CACHED.get_or_init(|| {
        let shell = [std::env::var("SHELL").unwrap_or_default(), "/bin/zsh".into(), "/bin/bash".into(), "/bin/sh".into()]
            .into_iter()
            .find(|p| !p.is_empty() && std::path::Path::new(p).exists())
            .unwrap_or_else(|| "/bin/sh".into());
        let mut found = String::new();
        if let Ok(out) = Command::new(&shell)
            .args(["-ilc", "printf \"\\n__MINDMAP_PATH__%s__END__\" \"$PATH\""])
            .stdin(Stdio::null())
            .stderr(Stdio::null())
            .output()
        {
            let s = String::from_utf8_lossy(&out.stdout);
            if let (Some(a), Some(b)) = (s.find("__MINDMAP_PATH__"), s.find("__END__")) {
                if a + 16 <= b {
                    found = s[a + 16..b].trim().to_string();
                }
            }
        }
        let home = std::env::var("HOME").unwrap_or_default();
        let env_path = std::env::var("PATH").unwrap_or_default();
        let extra = [
            "/opt/homebrew/bin".to_string(),
            "/usr/local/bin".into(),
            format!("{home}/.local/bin"),
            format!("{home}/.claude/local"),
            "/usr/bin".into(),
            "/bin".into(),
        ];
        let mut seen = std::collections::HashSet::new();
        found
            .split(':')
            .map(str::to_string)
            .chain(env_path.split(':').map(str::to_string))
            .chain(extra)
            .filter(|p| !p.is_empty() && seen.insert(p.clone()))
            .collect::<Vec<_>>()
            .join(":")
    })
}

/// 로그인 셸 PATH 를 넣은 명령. 이름만 주면 그 PATH 에서 찾는다.
pub fn command(bin: &str) -> Command {
    let mut c = Command::new(resolve(bin));
    c.env("PATH", login_path());
    c
}

/// PATH 에서 실행 파일 찾기 (못 찾으면 이름 그대로)
pub fn resolve(bin: &str) -> String {
    if bin.contains('/') {
        return bin.to_string();
    }
    for dir in login_path().split(':') {
        let p = std::path::Path::new(dir).join(bin);
        if p.is_file() {
            return p.to_string_lossy().into_owned();
        }
    }
    bin.to_string()
}
