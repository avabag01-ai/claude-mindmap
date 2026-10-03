//! src/core/appDir.js 를 옮긴 것. 설정 폴더 ~/.claude-mindmap (MINDMAP_HOME 으로 바꿈).
//! 처음 쓸 때 ~/.flowcode 의 설정 파일을 없는 것만 복사한다 (원본은 남김).

use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Once;

pub const OLD_FILES: [&str; 6] = ["memos.json", "session-links.json", "folders.json", "browser.json", "machine.json", "sync.json"];
static MIGRATE: Once = Once::new();

pub fn home() -> PathBuf {
    dirs::home_dir().unwrap_or_else(|| PathBuf::from("/"))
}

pub fn settings_dir() -> PathBuf {
    if let Ok(d) = std::env::var("MINDMAP_HOME") {
        if !d.is_empty() {
            return PathBuf::from(d);
        }
    }
    let dir = home().join(".claude-mindmap");
    MIGRATE.call_once(|| {
        migrate(&home().join(".flowcode"), &dir);
    });
    dir
}

pub fn settings_file(name: &str) -> PathBuf {
    settings_dir().join(name)
}

/// old_dir 의 설정 파일을 new_dir 로 복사 (없는 것만). 복사한 이름들을 돌려준다
pub fn migrate(old_dir: &Path, new_dir: &Path) -> Vec<String> {
    use std::os::unix::fs::PermissionsExt;
    let mut copied = Vec::new();
    for name in OLD_FILES {
        let from = old_dir.join(name);
        let to = new_dir.join(name);
        if !from.exists() || to.exists() {
            continue;
        }
        let r = (|| -> std::io::Result<()> {
            fs::create_dir_all(new_dir)?;
            fs::set_permissions(new_dir, fs::Permissions::from_mode(0o700)).ok();
            fs::copy(&from, &to)?;
            let mode = fs::metadata(&from)?.permissions().mode() & 0o777;
            fs::set_permissions(&to, fs::Permissions::from_mode(mode))?;
            Ok(())
        })();
        match r {
            Ok(()) => copied.push(name.to_string()),
            Err(e) => eprintln!("settings migrate: {name} {e}"),
        }
    }
    copied
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    #[test]
    fn migrate_copies_missing_only() {
        let tmp = tempfile::tempdir().unwrap();
        let old = tmp.path().join("old");
        let new = tmp.path().join("new");
        fs::create_dir_all(&old).unwrap();
        fs::create_dir_all(&new).unwrap();
        fs::write(old.join("memos.json"), "{\"old\":1}").unwrap();
        fs::set_permissions(old.join("memos.json"), fs::Permissions::from_mode(0o600)).unwrap();
        fs::write(old.join("folders.json"), "{\"old\":1}").unwrap();
        fs::write(old.join("other.txt"), "x").unwrap();
        fs::write(new.join("folders.json"), "{\"new\":1}").unwrap();
        assert_eq!(migrate(&old, &new), vec!["memos.json".to_string()]);
        assert_eq!(fs::read_to_string(new.join("folders.json")).unwrap(), "{\"new\":1}");
        assert_eq!(fs::metadata(new.join("memos.json")).unwrap().permissions().mode() & 0o777, 0o600);
        assert!(old.join("memos.json").exists());
        assert!(migrate(&old, &new).is_empty());
    }
}
