//! 세션 지우기: 기록 파일을 바로 없애지 않고 ~/.claude-mindmap/trash/<지운 시각>/ 로 옮긴다 (되살리기 = 도로 옮기기).
//! JS 쪽은 src/core/SessionIndexer.js trashSession.

use super::{io_err, mtime_ms, SessionIndexer, WORKING_MS};
use crate::app_dir;
use anyhow::{bail, Result};
use serde_json::{json, Value};
use std::fs;
use std::path::{Path, PathBuf};

impl SessionIndexer {
    /// 작업 중(10분 안에 기록됨)인 세션은 지우지 않는다. 묶기(하위·줄기·주제·종류)에서도 뺀다.
    pub fn trash_session(&mut self, root: &str, id: &str) -> Result<Value> {
        self.trash_session_in(root, id, &app_dir::settings_file("trash"))
    }

    pub fn trash_session_in(&mut self, root: &str, id: &str, trash_dir: &Path) -> Result<Value> {
        let key = format!("{}::{}", root, id);
        let s = match self.last_sessions.get(&key) {
            Some(s) => s.clone(),
            None => bail!("세션 목록에 없는 세션이에요"),
        };
        let mtime = match fs::metadata(&s.file) {
            Ok(m) => mtime_ms(&m),
            Err(_) => bail!("기록 파일이 없어요"),
        };
        if self.now() - mtime < WORKING_MS {
            bail!("작업 중인 세션이라 지우지 않아요. 끝나고 10분 뒤에 다시 해 주세요");
        }
        let dir = trash_dir.join(format!("{}", self.now() as i64)); // 지운 시각(ms)
        fs::create_dir_all(&dir).map_err(|e| io_err(e, "mkdir", &dir))?;
        let dest: PathBuf = dir.join(format!("{}.jsonl", id));
        move_file(Path::new(&s.file), &dest)?;
        // 하위 에이전트 기록 폴더(<id>/)도 같이
        let sub = &s.file[..s.file.len() - ".jsonl".len()];
        if Path::new(sub).is_dir() {
            let _ = fs::rename(sub, dir.join(id));
        }
        let mut links = self.read_links();
        let prefix = format!("{}::", root);
        for (name, m) in [("parents", &mut links.parents), ("prev", &mut links.prev), ("topics", &mut links.topics), ("kinds", &mut links.kinds)] {
            let link_kind = name == "parents" || name == "prev";
            let dead: Vec<String> = m
                .iter()
                .filter(|(kk, v)| **kk == key || (link_kind && kk.starts_with(&prefix) && v.as_str() == Some(id)))
                .map(|(kk, _)| kk.clone())
                .collect();
            for k in dead {
                m.remove(&k);
            }
        }
        self.write_links(&links)?;
        self.cache.remove(Path::new(&s.file));
        self.last_sessions.remove(&key);
        Ok(json!({ "root": root, "id": id, "trashed": dest.to_string_lossy(), "from": s.file }))
    }
}

/// 같은 디스크면 이름 바꾸기, 아니면 복사 후 지우기
fn move_file(from: &Path, to: &Path) -> Result<()> {
    if fs::rename(from, to).is_ok() {
        return Ok(());
    }
    fs::copy(from, to).map_err(|e| io_err(e, "copy", from))?;
    fs::remove_file(from).map_err(|e| io_err(e, "unlink", from))?;
    Ok(())
}
