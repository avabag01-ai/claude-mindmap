//! 세션 제목 바꾸기: Claude Code 가 /rename 할 때 쓰는 줄({"type":"custom-title",…})을 기록 파일 끝에 붙인다.
//! 따로 저장 파일을 만들지 않는다. 읽을 때는 마지막 custom-title 이 ai-title 보다 먼저다.
//! JS 쪽은 src/core/SessionIndexer.js renameSession.

use super::SessionIndexer;
use anyhow::{bail, Context, Result};
use serde_json::{json, Value};
use std::fs::{self, OpenOptions};
use std::io::Write;
use std::path::Path;

pub const MAX_TITLE: usize = 200;

/// 줄바꿈·앞뒤 빈칸을 정리한 제목 (비었거나 너무 길면 오류)
pub fn clean_title(title: &str) -> Result<String> {
    let t = title.split_whitespace().collect::<Vec<_>>().join(" ");
    if t.is_empty() {
        bail!("제목이 비었어요");
    }
    if t.chars().count() > MAX_TITLE {
        bail!("제목이 너무 길어요 ({MAX_TITLE}자까지)");
    }
    Ok(t)
}

impl SessionIndexer {
    pub fn rename_session(&mut self, root: &str, id: &str, title: &str) -> Result<Value> {
        let title = clean_title(title)?;
        let key = format!("{}::{}", root, id);
        let Some(s) = self.last_sessions.get(&key).cloned() else { bail!("세션 목록에 없는 세션이에요") };
        let ends_nl = fs::read(&s.file).map(|b| b.last().map_or(true, |c| *c == b'\n')).unwrap_or(true);
        let mut f = OpenOptions::new().append(true).open(&s.file).context("기록 파일을 열지 못했어요")?;
        let line = json!({ "type": "custom-title", "customTitle": title, "sessionId": id }).to_string();
        write!(f, "{}{}\n", if ends_nl { "" } else { "\n" }, line).context("기록 파일에 쓰지 못했어요")?;
        self.cache.remove(Path::new(&s.file));
        Ok(json!({ "root": root, "id": id, "title": title }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn cleans_titles() {
        assert_eq!(clean_title("  새\n 제목  ").unwrap(), "새 제목");
        assert!(clean_title(" \n ").is_err());
        assert!(clean_title(&"가".repeat(MAX_TITLE + 1)).is_err());
    }
}
