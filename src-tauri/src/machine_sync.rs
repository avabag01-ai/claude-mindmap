//! src/core/MachineSync.js 를 옮긴 것.
//! 세션이 맥북·맥미니 여러 대에 흩어져 있을 때 서로의 세션 목록을 보게 한다.
//! - 기기 이름: machine.json 의 name → 맥 모델 이름(system_profiler) → 호스트 이름
//! - 공유 폴더: MINDMAP_SYNC_DIR → sync.json 의 dir → iCloud Drive/ClaudeMindmap (있으면)
//!   각 기기가 machines/<기기>.json 에 자기 세션 목록을 쓴다 (대화 내용 없이).
//! - 다른 기기 세션은 읽기 전용으로 섞는다 (remote: true, machine: "MacBook").
//! 목록(index)은 SessionIndexer 가 만든 JSON(camelCase) 을 그대로 serde_json::Value 로 다룬다.

use serde_json::{json, Map, Value};
use std::collections::HashSet;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// 30일 넘게 소식 없는 기기는 빼기
pub const FRESH_MS: f64 = 30.0 * 864e5;

type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

/// JS 의 constructor options 에 해당. 비워 두면 기본값.
#[derive(Default)]
pub struct MachineSyncOptions {
    pub home: Option<PathBuf>,
    pub settings_dir: Option<PathBuf>,
    /// "darwin" 이면 system_profiler 로 모델을 읽는다 (기본: 이 맥이면 darwin)
    pub platform: Option<String>,
    pub now: Option<NowFn>,
    pub name: Option<String>,
    /// None = 알아서 찾기, Some(None) = 공유 폴더 없음, Some(Some(p)) = 그 폴더
    pub dir: Option<Option<String>>,
}

pub struct MachineSync {
    home: PathBuf,
    settings_dir: PathBuf,
    platform: String,
    now: NowFn,
    name: Mutex<Option<String>>,
    dir: Mutex<Option<Option<String>>>,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as i64)
        .unwrap_or(0)
}

/// JS 숫자처럼: 정수면 정수로, 아니면 소수로
fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9e15 {
        json!(f as i64)
    } else {
        serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// JS 의 truthy (null/undefined/false/0/""/NaN 은 거짓)
fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0 && !f.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn last_at(s: &Value) -> f64 {
    s.get("lastAt").and_then(Value::as_f64).unwrap_or(f64::NAN)
}

fn read_json(p: &Path) -> Option<Value> {
    serde_json::from_str(&fs::read_to_string(p).ok()?).ok()
}

/// 시간 제한을 두고 명령 출력 읽기
fn output_with_timeout(mut cmd: Command, ms: u64) -> Option<String> {
    let mut child = cmd.stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().ok()?;
    let mut stdout = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        std::io::Read::read_to_string(&mut stdout, &mut s).ok();
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => return if st.success() { reader.join().ok() } else { None },
            Ok(None) if start.elapsed() < Duration::from_millis(ms) => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                child.kill().ok();
                child.wait().ok();
                return None;
            }
        }
    }
}

fn hostname() -> String {
    let h = output_with_timeout(Command::new("/bin/hostname"), 2000)
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())
        .or_else(|| std::env::var("HOSTNAME").ok().filter(|s| !s.is_empty()))
        .unwrap_or_else(|| "localhost".into());
    h.strip_suffix(".local").map(str::to_string).unwrap_or(h)
}

impl MachineSync {
    pub fn new(o: MachineSyncOptions) -> Self {
        let home = o.home.unwrap_or_else(crate::app_dir::home);
        let settings_dir = o.settings_dir.unwrap_or_else(crate::app_dir::settings_dir);
        MachineSync {
            home,
            settings_dir,
            platform: o.platform.unwrap_or_else(|| if cfg!(target_os = "macos") { "darwin".into() } else { std::env::consts::OS.into() }),
            now: o.now.unwrap_or_else(|| Arc::new(now_ms)),
            name: Mutex::new(o.name.filter(|n| !n.is_empty())),
            dir: Mutex::new(o.dir),
        }
    }

    pub fn now(&self) -> i64 {
        (self.now)()
    }

    /// 이 기기 이름 (한 번 정하면 기억)
    pub fn name(&self) -> String {
        if let Some(n) = self.name.lock().unwrap().clone() {
            return n;
        }
        let from_file = read_json(&self.settings_dir.join("machine.json")).and_then(|d| match d.get("name") {
            Some(Value::String(s)) if !s.is_empty() => Some(s.clone()),
            Some(Value::Number(n)) if n.as_f64() != Some(0.0) => Some(n.to_string()),
            _ => None,
        });
        let n = from_file.unwrap_or_else(|| {
            let mut model = String::new();
            if self.platform == "darwin" {
                let mut c = Command::new("system_profiler");
                c.arg("SPHardwareDataType");
                if let Some(out) = output_with_timeout(c, 8000) {
                    if let Some(m) = regex::Regex::new(r"Model Name:\s*(.+)").unwrap().captures(&out) {
                        model = m[1].trim().to_string();
                    }
                }
            }
            let short = Self::short_model(&model);
            if short.is_empty() { hostname() } else { short.to_string() }
        });
        *self.name.lock().unwrap() = Some(n.clone());
        n
    }

    /// "MacBook Pro" → "MacBook", "Mac mini" → "Mac mini" …
    pub fn short_model(model: &str) -> &'static str {
        let m = model.to_lowercase();
        let squeezed: String = m.split_whitespace().collect();
        if m.contains("macbook") {
            "MacBook"
        } else if squeezed.contains("macmini") {
            "Mac mini"
        } else if squeezed.contains("macstudio") {
            "Mac Studio"
        } else if m.contains("imac") {
            "iMac"
        } else if squeezed.contains("macpro") {
            "Mac Pro"
        } else {
            ""
        }
    }

    /// 공유 폴더 (없으면 None). 한 번 정하면 기억
    pub fn dir(&self) -> Option<String> {
        if let Some(d) = self.dir.lock().unwrap().clone() {
            return d;
        }
        let found = (|| {
            if let Ok(d) = std::env::var("MINDMAP_SYNC_DIR") {
                if !d.is_empty() {
                    return Some(d);
                }
            }
            if let Some(Value::String(d)) = read_json(&self.settings_dir.join("sync.json")).and_then(|v| v.get("dir").cloned()) {
                if !d.is_empty() {
                    return Some(d);
                }
            }
            let icloud = self.home.join("Library").join("Mobile Documents").join("com~apple~CloudDocs");
            icloud.exists().then(|| icloud.join("ClaudeMindmap").to_string_lossy().into_owned())
        })();
        *self.dir.lock().unwrap() = Some(found.clone());
        found
    }

    /// 파일 이름으로 못 쓰는 글자는 _ (JS 의 \w 는 ASCII 만, 이모지 같은 2칸 글자는 __)
    pub fn file_name(machine: &str) -> String {
        let mut s = String::new();
        for c in machine.chars() {
            if c.is_ascii_alphanumeric() || matches!(c, '_' | ' ' | '.' | '-') || ('가'..='힣').contains(&c) {
                s.push(c);
            } else if c.len_utf16() == 2 {
                s.push_str("__");
            } else {
                s.push('_');
            }
        }
        s + ".json"
    }

    /// 이 기기의 세션 목록을 공유 폴더에 쓴다 (대화 내용 없이)
    pub fn publish(&self, index: &Value) -> Value {
        let Some(dir) = self.dir() else {
            return json!({ "ok": false, "reason": "no-dir" });
        };
        let machine = self.name();
        let generated = if truthy(index.get("generatedAt")) { index["generatedAt"].clone() } else { json!(self.now()) };
        let mut projects = Vec::new();
        for p in index.get("projects").and_then(Value::as_array).into_iter().flatten() {
            let sessions: Vec<Value> = p
                .get("sessions")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter(|s| !truthy(s.get("remote")))
                .map(Self::strip_session)
                .collect();
            if sessions.is_empty() {
                continue;
            }
            let mut o = Map::new();
            copy_keys(&mut o, p, &["root", "name", "lastAt"]);
            o.insert("sessions".into(), Value::Array(sessions));
            projects.push(Value::Object(o));
        }
        let snapshot = json!({ "version": 1, "machine": machine, "generatedAt": generated, "projects": projects });
        let out = Path::new(&dir).join("machines");
        let file = out.join(Self::file_name(&machine));
        let tmp = PathBuf::from(format!("{}.tmp", file.display()));
        let r = fs::create_dir_all(&out)
            .and_then(|_| fs::write(&tmp, serde_json::to_string(&snapshot).unwrap()))
            .and_then(|_| fs::rename(&tmp, &file));
        match r {
            Ok(()) => json!({ "ok": true, "file": file.to_string_lossy() }),
            Err(e) => json!({ "ok": false, "reason": e.to_string() }),
        }
    }

    /// 공유 파일에 넣는 세션 필드만 (file·status 같은 건 뺌)
    fn strip_session(s: &Value) -> Value {
        let mut o = Map::new();
        copy_keys(&mut o, s, &["id", "title", "cwd", "gitBranch", "firstAt", "lastAt", "costUSD"]);
        for k in ["parentId", "git", "context", "kind", "topic"] {
            o.insert(k.into(), if truthy(s.get(k)) { s[k].clone() } else { Value::Null });
        }
        let files: Vec<Value> = s
            .get("files")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .map(|f| {
                let mut fo = Map::new();
                copy_keys(&mut fo, f, &["path", "rel", "edits"]);
                Value::Object(fo)
            })
            .collect();
        o.insert("files".into(), Value::Array(files));
        Value::Object(o)
    }

    /// 다른 기기들의 목록
    pub fn read_others(&self) -> Vec<Value> {
        let Some(dir) = self.dir() else { return vec![] };
        let mdir = Path::new(&dir).join("machines");
        let Ok(rd) = fs::read_dir(&mdir) else { return vec![] };
        let mut names: Vec<String> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().into_owned()).filter(|n| n.ends_with(".json")).collect();
        names.sort(); // JS readdir 도 보통 이름순 (APFS)
        let me = self.name();
        let now = self.now() as f64;
        let mut out = Vec::new();
        for n in names {
            // 쓰는 중이거나 깨진 파일은 건너뜀
            let Some(d) = read_json(&mdir.join(&n)) else { continue };
            if d.is_null() || d.get("machine").and_then(Value::as_str) == Some(me.as_str()) || !d.get("projects").map(Value::is_array).unwrap_or(false) {
                continue;
            }
            if now - d.get("generatedAt").and_then(Value::as_f64).unwrap_or(0.0) > FRESH_MS {
                continue;
            }
            out.push(d);
        }
        out
    }

    /// 이 기기 목록에 다른 기기 세션을 섞는다.
    /// 같은 폴더 경로면 한 프로젝트로, 같은 세션 id 가 이 기기에도 있으면 이 기기 것을 쓴다.
    pub fn merge(local: &Value, others: &[Value], now: i64) -> Value {
        let mut projects: Vec<Value> = local.get("projects").and_then(Value::as_array).cloned().unwrap_or_default();
        let key = |v: &Value| v.get("root").map(|r| r.to_string()).unwrap_or_default();
        let mut by_root: std::collections::HashMap<String, usize> = HashMap_from(&projects, key);
        let mut have: HashSet<String> = projects.iter().flat_map(|p| sessions_of(p)).filter_map(|s| s.get("id").map(|i| i.to_string())).collect();
        for o in others {
            let machine = o.get("machine").cloned().unwrap_or(Value::Null);
            for rp in o.get("projects").and_then(Value::as_array).into_iter().flatten() {
                let k = key(rp);
                let idx = *by_root.entry(k).or_insert_with(|| {
                    let mut np = Map::new();
                    copy_keys(&mut np, rp, &["root", "name", "lastAt"]);
                    np.insert("hub".into(), Value::Null);
                    np.insert("sessions".into(), json!([]));
                    np.insert("remoteOnly".into(), json!(true));
                    projects.push(Value::Object(np));
                    projects.len() - 1
                });
                let p = projects[idx].as_object_mut().unwrap();
                let mut sessions: Vec<Value> = p.get("sessions").and_then(Value::as_array).cloned().unwrap_or_default();
                for s in rp.get("sessions").and_then(Value::as_array).into_iter().flatten() {
                    let id = s.get("id").map(|i| i.to_string()).unwrap_or_default();
                    if !have.insert(id) {
                        continue;
                    }
                    let mut so = s.as_object().cloned().unwrap_or_default();
                    so.insert("remote".into(), json!(true));
                    so.insert("machine".into(), machine.clone());
                    so.insert("file".into(), Value::Null);
                    so.insert("status".into(), json!(Self::status(s.get("lastAt").and_then(Value::as_f64), Some(now))));
                    sessions.push(Value::Object(so));
                }
                // 최근 순 (같으면 원래 순서 유지)
                sessions.sort_by(|a, b| last_at(b).partial_cmp(&last_at(a)).unwrap_or(std::cmp::Ordering::Equal));
                let mut mx = p.get("lastAt").and_then(Value::as_f64).filter(|f| !f.is_nan()).unwrap_or(0.0);
                for s in &sessions {
                    mx = mx.max(last_at(s));
                }
                p.insert("lastAt".into(), num(mx));
                p.insert("sessions".into(), Value::Array(sessions));
            }
        }
        projects.sort_by(|a, b| last_at(b).partial_cmp(&last_at(a)).unwrap_or(std::cmp::Ordering::Equal));
        let mut machines: Vec<Value> = Vec::new();
        for o in others {
            let m = o.get("machine").cloned().unwrap_or(Value::Null);
            if !machines.contains(&m) {
                machines.push(m);
            }
        }
        let mut out = local.as_object().cloned().unwrap_or_default();
        out.insert("projects".into(), Value::Array(projects));
        out.insert("machines".into(), Value::Array(machines));
        Value::Object(out)
    }

    /// 마지막 활동 시각으로 상태 다시 계산: working(10분) / recent(하루) / idle
    pub fn status(last_at: Option<f64>, now: Option<i64>) -> &'static str {
        let now = match now {
            Some(n) if n != 0 => n,
            _ => now_ms(),
        } as f64;
        let age = now - last_at.unwrap_or(f64::NAN);
        if age < 10.0 * 60e3 {
            "working"
        } else if age < 864e5 {
            "recent"
        } else {
            "idle"
        }
    }
}

#[allow(non_snake_case)]
fn HashMap_from(projects: &[Value], key: impl Fn(&Value) -> String) -> std::collections::HashMap<String, usize> {
    // 같은 root 가 둘이면 JS Map 처럼 뒤엣것이 이긴다
    projects.iter().enumerate().map(|(i, p)| (key(p), i)).collect()
}

fn sessions_of(p: &Value) -> impl Iterator<Item = &Value> {
    p.get("sessions").and_then(Value::as_array).into_iter().flatten()
}

/// 있는 키만 복사 (JS 의 undefined 는 JSON 에서 빠지는 것과 같게)
fn copy_keys(to: &mut Map<String, Value>, from: &Value, keys: &[&str]) {
    for k in keys {
        if let Some(v) = from.get(*k) {
            to.insert((*k).into(), v.clone());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: i64 = 1_790_000_000_000; // 2026-09 쯤. JS 테스트의 NOW 와 같은 값일 필요는 없음

    fn sess(id: &str, root: &str, files: &[&str], extra: Value) -> Value {
        let mut s = json!({
            "id": id, "title": id, "cwd": root, "gitBranch": "main", "firstAt": NOW - 3_600_000, "lastAt": NOW - 60_000,
            "status": "working", "costUSD": 1, "parentId": null, "file": format!("/x/{id}.jsonl"),
            "files": files.iter().map(|f| json!({ "path": format!("{root}/{f}"), "rel": f, "edits": 1 })).collect::<Vec<_>>()
        });
        for (k, v) in extra.as_object().unwrap() {
            s[k] = v.clone();
        }
        s
    }

    fn sync(name: &str, dir: &Path) -> MachineSync {
        MachineSync::new(MachineSyncOptions { name: Some(name.into()), dir: Some(Some(dir.to_string_lossy().into())), now: Some(Arc::new(|| NOW)), ..Default::default() })
    }

    #[test]
    fn short_model_names() {
        assert_eq!(MachineSync::short_model("MacBook Pro"), "MacBook");
        assert_eq!(MachineSync::short_model("Mac mini"), "Mac mini");
        assert_eq!(MachineSync::short_model("Mac Studio"), "Mac Studio");
        assert_eq!(MachineSync::short_model(""), "");
        assert_eq!(MachineSync::short_model("iMac"), "iMac");
        assert_eq!(MachineSync::short_model("Mac Pro"), "Mac Pro");
    }

    #[test]
    fn file_name_cleans() {
        assert_eq!(MachineSync::file_name("Mac mini"), "Mac mini.json");
        assert_eq!(MachineSync::file_name("김/맥*북"), "김_맥_북.json");
        assert_eq!(MachineSync::file_name("a😀b"), "a__b.json");
    }

    #[test]
    fn name_from_file_then_host() {
        let tmp = tempfile::tempdir().unwrap();
        let sd = tmp.path().join("settings");
        fs::create_dir_all(&sd).unwrap();
        fs::write(sd.join("machine.json"), r#"{"name":"Mac mini"}"#).unwrap();
        let m = MachineSync::new(MachineSyncOptions { settings_dir: Some(sd), platform: Some("linux".into()), ..Default::default() });
        assert_eq!(m.name(), "Mac mini", "machine.json 이 먼저");
        let m2 = MachineSync::new(MachineSyncOptions { settings_dir: Some(tmp.path().join("none")), platform: Some("linux".into()), ..Default::default() });
        assert!(!m2.name().is_empty(), "없으면 호스트 이름");
    }

    #[test]
    fn dir_from_sync_json_and_icloud() {
        let tmp = tempfile::tempdir().unwrap();
        let sd = tmp.path().join("s");
        fs::create_dir_all(&sd).unwrap();
        fs::write(sd.join("sync.json"), r#"{"dir":"/tmp/zzz"}"#).unwrap();
        let m = MachineSync::new(MachineSyncOptions { settings_dir: Some(sd), home: Some(tmp.path().into()), ..Default::default() });
        if std::env::var("MINDMAP_SYNC_DIR").is_err() {
            assert_eq!(m.dir().as_deref(), Some("/tmp/zzz"));
        }
        let home = tmp.path().join("h");
        fs::create_dir_all(home.join("Library/Mobile Documents/com~apple~CloudDocs")).unwrap();
        let m2 = MachineSync::new(MachineSyncOptions { settings_dir: Some(tmp.path().join("none")), home: Some(home.clone()), ..Default::default() });
        if std::env::var("MINDMAP_SYNC_DIR").is_err() {
            assert!(m2.dir().unwrap().ends_with("com~apple~CloudDocs/ClaudeMindmap"));
        }
    }

    #[test]
    fn no_dir() {
        let m = MachineSync::new(MachineSyncOptions { name: Some("Mac mini".into()), dir: Some(None), ..Default::default() });
        assert_eq!(m.publish(&json!({ "projects": [] })), json!({ "ok": false, "reason": "no-dir" }));
        assert!(m.read_others().is_empty());
    }

    #[test]
    fn two_machines_share_folder() {
        let tmp = tempfile::tempdir().unwrap();
        let dir = tmp.path().join("icloud").join("ClaudeMindmap");
        let repo = "/w/app";
        let index = json!({ "generatedAt": NOW, "projects": [
            { "root": repo, "name": "app", "lastAt": NOW, "hub": null, "sessions": [
                sess("s-pushed", repo, &["a.js"], json!({ "git": "pushed" })),
                sess("s-ahead", repo, &["a.js", "b.js"], json!({ "git": "ahead" })),
                sess("s-dirty", repo, &["b.js", "new/d.js"], json!({ "git": "dirty" })),
                sess("s-none", repo, &[], json!({})),
            ] },
            { "root": "/w/lonely", "name": "lonely", "lastAt": NOW - 1, "hub": null, "sessions": [sess("s-lonely", "/w/lonely", &["x.js"], json!({ "git": "ahead" }))] },
        ]});
        let mini = sync("Mac mini", &dir);
        let book = sync("MacBook", &dir);
        assert_eq!(mini.publish(&index)["ok"], json!(true));
        let written: Value = serde_json::from_str(&fs::read_to_string(dir.join("machines/Mac mini.json")).unwrap()).unwrap();
        assert_eq!(written["machine"], "Mac mini");
        let w = written["projects"][0]["sessions"].as_array().unwrap().iter().find(|s| s["id"] == "s-dirty").unwrap().clone();
        assert_eq!(w["git"], "dirty", "git 상태도 같이 쓴다");
        assert!(w.get("file").is_none(), "기록 파일 경로(대화 내용)는 쓰지 않는다");
        assert!(w.get("status").is_none());

        let book_index = json!({ "generatedAt": NOW, "projects": [
            { "root": repo, "name": "app", "lastAt": NOW - 5000, "hub": null, "sessions": [
                sess("s-ahead", repo, &["b.js"], json!({ "lastAt": NOW - 5000 })),
                sess("s-book", repo, &["c.js"], json!({ "lastAt": NOW - 2 * 864_00_000, "git": "dirty" })),
            ] },
            { "root": "/Users/kim/only-book", "name": "only-book", "lastAt": NOW - 100, "hub": null, "sessions": [sess("s-far", "/Users/kim/only-book", &[], json!({ "lastAt": NOW - 100 }))] },
        ]});
        assert_eq!(book.publish(&book_index)["ok"], json!(true));
        // 오래된 기기·깨진 파일은 건너뛴다
        fs::write(dir.join("machines/iMac.json"), json!({ "machine": "iMac", "generatedAt": NOW - 40 * 864_00_000, "projects": [] }).to_string()).unwrap();
        fs::write(dir.join("machines/broken.json"), "{ 쓰는 중").unwrap();

        let others = mini.read_others();
        let names: Vec<_> = others.iter().map(|o| o["machine"].clone()).collect();
        assert_eq!(names, vec![json!("MacBook")], "나 자신·오래된 기기·깨진 파일은 빼고");

        let merged = MachineSync::merge(&index, &others, NOW);
        assert_eq!(merged["machines"], json!(["MacBook"]));
        let projects = merged["projects"].as_array().unwrap();
        let app = projects.iter().find(|p| p["root"] == repo).unwrap();
        let sessions = app["sessions"].as_array().unwrap();
        assert_eq!(sessions.iter().filter(|s| s["id"] == "s-ahead").count(), 1, "같은 세션 id 는 한 번만");
        assert!(!truthy(sessions.iter().find(|s| s["id"] == "s-ahead").unwrap().get("remote")), "이 기기에 있으면 이 기기 것");
        let far = sessions.iter().find(|s| s["id"] == "s-book").unwrap();
        assert_eq!(far["remote"], true);
        assert_eq!(far["machine"], "MacBook");
        assert_eq!(far["file"], Value::Null, "다른 기기 세션은 대화 파일 없음");
        assert_eq!(far["git"], "dirty");
        assert_eq!(far["status"], "idle", "상태는 시각으로 다시 계산");
        let only = projects.iter().find(|p| p["root"] == "/Users/kim/only-book").unwrap();
        assert_eq!(only["remoteOnly"], true, "다른 기기에만 있는 폴더는 remoteOnly");
        assert_eq!(only["sessions"][0]["status"], "working");
        let las: Vec<f64> = projects.iter().map(|p| p["lastAt"].as_f64().unwrap()).collect();
        let mut sorted = las.clone();
        sorted.sort_by(|a, b| b.partial_cmp(a).unwrap());
        assert_eq!(las, sorted, "최근 순으로 섞인다");
        assert!(!index["projects"][0]["sessions"].as_array().unwrap().iter().any(|s| truthy(s.get("remote"))), "원래 목록은 그대로");

        // 다시 publish 해도 다른 기기 세션은 내 파일에 들어가지 않는다
        mini.publish(&merged);
        let again: Value = serde_json::from_str(&fs::read_to_string(dir.join("machines/Mac mini.json")).unwrap()).unwrap();
        let text = again.to_string();
        assert!(!text.contains("s-book") && !text.contains("s-far"), "남의 세션은 다시 쓰지 않는다");
    }

    #[test]
    fn status_buckets() {
        assert_eq!(MachineSync::status(Some(NOW as f64 - 1000.0), Some(NOW)), "working");
        assert_eq!(MachineSync::status(Some(NOW as f64 - 3_600_000.0), Some(NOW)), "recent");
        assert_eq!(MachineSync::status(Some(NOW as f64 - 2.0 * 864e5), Some(NOW)), "idle");
        assert_eq!(MachineSync::status(None, Some(NOW)), "idle");
    }
}
