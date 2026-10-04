//! 세션 폴더 고르기: 기록의 첫 cwd 가 아니라, 기록 파일이 놓인 폴더 이름과 맞는 cwd.
//! 클로드 앱에서 세션 폴더를 바꾸면(임시 폴더 → 프로젝트) 앱이 기록 파일을 새 폴더 자리로 옮기는데,
//! 앞쪽 줄들은 옛 cwd 를 갖고 있다. 첫 cwd 만 보면 세션이 옛 폴더(임시 폴더)에 계속 붙어 있게 된다.

use crate::session_indexer::encode_cwd;
use std::path::Path;

/// 기록 파일이 들어 있는 폴더 이름 (~/.claude/projects/<이것>/<id>.jsonl)
pub fn dir_key(file: &Path) -> String {
    file.parent().and_then(|p| p.file_name()).map(|n| n.to_string_lossy().into_owned()).unwrap_or_default()
}

/// 지금 고른 cwd 를 새 cwd 로 바꿀지: 아직 없거나, 지금 것은 파일 자리와 안 맞고 새 것은 맞을 때
pub fn better(cur: &str, new: &str, key: &str) -> bool {
    cur.is_empty() || (!fits(cur, key) && fits(new, key))
}

/// 더 볼 필요가 있는지 (이미 파일 자리와 맞으면 그만 찾는다)
pub fn settled(cur: &str, key: &str) -> bool {
    !cur.is_empty() && (key.is_empty() || fits(cur, key))
}

fn fits(cwd: &str, key: &str) -> bool {
    encode_cwd(cwd) == key
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn moved_session_takes_new_folder() {
        let key = "-Users-kim-claude-mindmap";
        assert!(better("", "/tmp/scratch", key), "처음엔 무엇이든");
        assert!(!settled("/tmp/scratch", key), "임시 폴더는 파일 자리와 안 맞으니 계속 찾는다");
        assert!(better("/tmp/scratch", "/Users/kim/claude-mindmap", key), "파일 자리와 맞는 새 폴더로");
        assert!(settled("/Users/kim/claude-mindmap", key));
        assert!(!better("/Users/kim/claude-mindmap", "/Users/kim/claude-mindmap/src", key), "맞는 걸 찾은 뒤에는 그대로");
        assert!(!better("/a/b", "/c/d", key), "둘 다 안 맞으면 첫 것 그대로");
        assert_eq!(dir_key(Path::new("/h/.claude/projects/-a-b/x.jsonl")), "-a-b");
    }
}
