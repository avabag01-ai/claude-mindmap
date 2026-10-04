//! src/core/SessionIndexer.js 를 옮긴 것.
//! Claude Code 세션 기록(~/.claude/projects/<인코딩된 cwd>/<sessionId>.jsonl)을 읽어
//! "프로젝트 → 세션 → 수정한 파일" 구조로 정리한다. 출력 JSON 모양은 JS 와 똑같이 맞춘다
//! (화면 코드가 그대로 읽음). 동기 I/O — 일꾼 스레드에서 부른다.

use crate::{app_dir, login_path};
use anyhow::{bail, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::{json, Map, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

mod trash; // 세션 지우기 (session_indexer/trash.rs)
mod rename; // 세션 제목 바꾸기 (session_indexer/rename.rs)

const EDIT_TOOLS: [&str; 4] = ["Edit", "Write", "MultiEdit", "NotebookEdit"];
const WORKING_MS: f64 = 10.0 * 60.0 * 1000.0; // 마지막 기록이 10분 안이면 "작업 중"
const RECENT_MS: f64 = 24.0 * 60.0 * 60.0 * 1000.0; // 24시간 안이면 "최근"

macro_rules! re {
    ($name:ident, $pat:expr) => {
        static $name: Lazy<Regex> = Lazy::new(|| Regex::new($pat).unwrap());
    };
}
re!(TS_RE, r#""timestamp":"([^"]+)""#);
re!(CWD_RE, r#""cwd":"((?:[^"\\]|\\.)*)""#);
re!(BRANCH_RE, r#""gitBranch":"((?:[^"\\]|\\.)*)""#);
re!(IN_RE, r#""input_tokens":(\d+)"#);
re!(CACHE_NEW_RE, r#""cache_creation_input_tokens":(\d+)"#);
re!(CACHE_READ_RE, r#""cache_read_input_tokens":(\d+)"#);
re!(MODEL_RE, r#""model":"([^"]+)""#);
re!(TTL_1H_RE, r#""ephemeral_1h_input_tokens":[1-9]\d*"#);
re!(TTL_5M_RE, r#""ephemeral_5m_input_tokens":[1-9]\d*"#);
re!(TOPIC_RE, r"(?-u)\btopic:\s*([\w.-]+)");
re!(TOPIC_NAME_RE, r"(?-u)^[\w.-]+$");
re!(NOT_CODE_RE, r"(?i)\.(md|markdown|toon|txt|json|ya?ml|csv)$");
re!(TOON_DIR_RE, r"[\\/]\.toon[\\/]");
re!(TITLE_RE, r"(?m)^title:\s*(.+)$");
re!(NEXT_RE, r"NEXT");
re!(CMD_TEXT_RE, r"^<(command-|local-command|system-reminder)");
re!(REMINDER_RE, r"(?s)<system-reminder>.*?</system-reminder>");
re!(WS_RE, r"\s+");
re!(LINE_SPLIT_RE, r"\r\n|\n|\r");
re!(ISO_RE, r"^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:[.,](\d+))?)?)?\s*(Z|[+-]\d{2}:?\d{2})?$");

// ---------------------------------------------------------------------
// JS 와 같게 굴리는 작은 도구들 (숫자 출력, 경로, UTF-16 길이, 날짜)
// ---------------------------------------------------------------------

/// JS 처럼 딱 떨어지는 수는 정수로 낸다 (1700000000000 이지 1700000000000.0 이 아님)
fn ser_num<S: Serializer>(v: &f64, s: S) -> Result<S::Ok, S::Error> {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 9e15 {
        s.serialize_i64(*v as i64)
    } else {
        s.serialize_f64(*v)
    }
}

fn ser_opt_num<S: Serializer>(v: &Option<f64>, s: S) -> Result<S::Ok, S::Error> {
    match v {
        Some(x) => ser_num(x, s),
        None => s.serialize_none(),
    }
}

/// 값이 없음(undefined) / null / 값 을 구분해서 읽는다
pub fn double_opt<'de, D, T>(d: D) -> Result<Option<Option<T>>, D::Error>
where
    D: Deserializer<'de>,
    T: Deserialize<'de>,
{
    Ok(Some(Option::deserialize(d)?))
}

fn js_truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::Number(n)) => n.as_f64().map(|x| x != 0.0 && !x.is_nan()).unwrap_or(true),
        Some(Value::String(s)) => !s.is_empty(),
        Some(_) => true,
    }
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

/// JS 의 s.slice(0, n) (UTF-16 기준)
fn utf16_head(s: &str, n: usize) -> String {
    let u: Vec<u16> = s.encode_utf16().take(n).collect();
    String::from_utf16_lossy(&u)
}

/// path.dirname
fn js_dirname(p: &str) -> String {
    if p.is_empty() {
        return ".".into();
    }
    let t = p.trim_end_matches('/');
    if t.is_empty() {
        return "/".into();
    }
    match t.rfind('/') {
        None => ".".into(),
        Some(0) => "/".into(),
        Some(i) => {
            let d = t[..i].trim_end_matches('/');
            if d.is_empty() {
                "/".into()
            } else {
                d.to_string()
            }
        }
    }
}

/// path.basename
fn js_basename(p: &str) -> String {
    let t = p.trim_end_matches('/');
    match t.rfind('/') {
        Some(i) => t[i + 1..].to_string(),
        None => t.to_string(),
    }
}

fn norm_parts(p: &str) -> Vec<String> {
    let abs = if p.starts_with('/') {
        p.to_string()
    } else {
        format!("{}/{}", std::env::current_dir().map(|d| d.to_string_lossy().into_owned()).unwrap_or_default(), p)
    };
    let mut out: Vec<String> = Vec::new();
    for c in abs.split('/') {
        match c {
            "" | "." => {}
            ".." => {
                out.pop();
            }
            _ => out.push(c.to_string()),
        }
    }
    out
}

/// path.relative(from, to)
fn js_relative(from: &str, to: &str) -> String {
    let a = norm_parts(from);
    let b = norm_parts(to);
    let mut i = 0;
    while i < a.len() && i < b.len() && a[i] == b[i] {
        i += 1;
    }
    let mut parts: Vec<String> = vec!["..".into(); a.len() - i];
    parts.extend(b[i..].iter().cloned());
    parts.join("/")
}

/// Date.parse (ISO 꼴만. 시간대 없는 날짜+시각도 UTC 로 본다)
fn date_parse(s: &str) -> Option<f64> {
    let c = ISO_RE.captures(s.trim())?;
    let n = |i: usize| c.get(i).map(|m| m.as_str().parse::<i64>().unwrap_or(0)).unwrap_or(0);
    let (y, mo, d) = (n(1), n(2), n(3));
    let (h, mi, sec) = (n(4), n(5), n(6));
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || sec > 59 {
        return None;
    }
    let ms = match c.get(7) {
        Some(m) => {
            let mut t: String = m.as_str().chars().take(3).collect();
            while t.len() < 3 {
                t.push('0');
            }
            t.parse::<i64>().unwrap_or(0)
        }
        None => 0,
    };
    // 날짜 → 1970-01-01 부터의 일 수 (civil)
    let y2 = if mo <= 2 { y - 1 } else { y };
    let era = y2.div_euclid(400);
    let yoe = y2 - era * 400;
    let mp = (mo + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let mut total = ((days * 24 + h) * 60 + mi) * 60 + sec;
    if let Some(z) = c.get(8) {
        let z = z.as_str();
        if z != "Z" {
            let sign = if z.starts_with('-') { -1 } else { 1 };
            let digits: String = z[1..].chars().filter(|c| c.is_ascii_digit()).collect();
            let oh: i64 = digits[..2].parse().unwrap_or(0);
            let om: i64 = digits[2..].parse().unwrap_or(0);
            total -= sign * (oh * 3600 + om * 60);
        }
    }
    Some((total * 1000 + ms) as f64)
}

fn mtime_ms(m: &fs::Metadata) -> f64 {
    m.modified()
        .ok()
        .and_then(|t| t.duration_since(UNIX_EPOCH).ok())
        .map(|d| d.as_nanos() as f64 / 1e6)
        .unwrap_or(0.0)
}

/// Node 의 statSync 오류 문구와 같게 (UI 에 그대로 보임)
fn io_err(e: std::io::Error, op: &str, path: &Path) -> anyhow::Error {
    if e.kind() == std::io::ErrorKind::NotFound {
        anyhow::anyhow!("ENOENT: no such file or directory, {} '{}'", op, path.display())
    } else {
        anyhow::anyhow!("{}", e)
    }
}

fn now_ms() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as f64).unwrap_or(0.0)
}

// ---------------------------------------------------------------------
// 결과 구조 (JS 와 같은 camelCase 키)
// ---------------------------------------------------------------------

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct FileEdit {
    pub path: String,
    pub edits: u32,
    pub rel: String,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize, PartialEq)]
#[serde(default)]
pub struct Context {
    #[serde(serialize_with = "ser_num")]
    pub tokens: f64,
    pub model: String,
    pub ttl: Option<String>,
    #[serde(serialize_with = "ser_num")]
    pub at: f64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Session {
    pub id: String,
    pub file: String,
    pub title: String,
    pub first_prompt: String,
    pub cwd: String,
    pub git_branch: String,
    #[serde(serialize_with = "ser_num")]
    pub first_at: f64,
    #[serde(serialize_with = "ser_num")]
    pub last_at: f64,
    #[serde(rename = "costUSD", serialize_with = "ser_opt_num")]
    pub cost_usd: Option<f64>,
    pub context: Option<Context>,
    pub files: Vec<FileEdit>,
    pub status: String,
    pub parent_id: Option<String>,
    pub prev_id: Option<String>,
    pub topic: Option<String>,
    pub kind: String,
    /// attachGit 전에는 키 자체가 없다. 뒤에는 'dirty'|'ahead'|'pushed'|null
    #[serde(skip_serializing_if = "Option::is_none", deserialize_with = "double_opt")]
    pub git: Option<Option<String>>,
    /// 사람이 바꾼 제목(custom-title)이면 true. 클로드 앱 제목보다 먼저 쓴다
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    pub custom_title: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default)]
pub struct Hub {
    pub path: String,
    pub next: Vec<String>,
    pub topics: Vec<String>,
    pub titles: Map<String, Value>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Project {
    pub root: String,
    pub name: String,
    #[serde(serialize_with = "ser_num")]
    pub last_at: f64,
    pub hub: Option<Hub>,
    pub sessions: Vec<Session>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub added: Option<bool>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Index {
    #[serde(serialize_with = "ser_num")]
    pub generated_at: f64,
    pub claude_dir: String,
    pub projects: Vec<Project>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ToolUse {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub name: Option<Value>,
    pub target: String,
}

#[derive(Debug, Clone, Serialize)]
pub struct Message {
    pub role: String,
    pub text: String,
    pub tools: Vec<ToolUse>,
    #[serde(serialize_with = "ser_num")]
    pub at: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcript {
    pub messages: Vec<Message>,
    pub truncated: bool,
    #[serde(serialize_with = "ser_num")]
    pub mtime_ms: f64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct HubText {
    pub root: String,
    pub topic: Option<String>,
    pub path: String,
    pub text: String,
    #[serde(serialize_with = "ser_num")]
    pub mtime_ms: f64,
    pub topics: Vec<String>,
    pub titles: Map<String, Value>,
}

/// set_meta 에 넘기는 값. 안 줌(None) = 그대로, 줌(Some(None)) = null = 지움
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct MetaPatch {
    #[serde(deserialize_with = "double_opt")]
    pub parent_id: Option<Option<String>>,
    #[serde(deserialize_with = "double_opt")]
    pub prev_id: Option<Option<String>>,
    #[serde(deserialize_with = "double_opt")]
    pub topic: Option<Option<String>>,
    #[serde(deserialize_with = "double_opt")]
    pub kind: Option<Option<String>>,
}

pub type NowFn = Arc<dyn Fn() -> f64 + Send + Sync>;

#[derive(Default, Clone)]
pub struct Options {
    pub claude_dir: Option<PathBuf>,
    pub max_sessions: Option<usize>,
    pub max_files_per_session: Option<usize>,
    pub now: Option<NowFn>,
    pub links_file: Option<PathBuf>,
    pub folders_file: Option<PathBuf>,
}

struct Transcript0 {
    file: PathBuf,
    mtime_ms: f64,
    size: u64,
}

#[derive(Clone)]
struct Last {
    file: String,
    cwd: String,
}

/// 세션 묶기 파일 (parents / prev / topics / kinds)
struct Links {
    parents: Map<String, Value>,
    prev: Map<String, Value>,
    topics: Map<String, Value>,
    kinds: Map<String, Value>,
}

pub struct SessionIndexer {
    pub claude_dir: PathBuf,
    pub max_sessions: usize,
    pub max_files_per_session: usize,
    now: NowFn,
    cache: HashMap<PathBuf, (String, Session)>,
    pub links_file: PathBuf,
    pub folders_file: PathBuf,
    last_sessions: HashMap<String, Last>,
    pub last_roots: HashSet<String>,
}

impl SessionIndexer {
    pub fn new(o: Options) -> Self {
        SessionIndexer {
            claude_dir: o.claude_dir.unwrap_or_else(|| app_dir::home().join(".claude")),
            max_sessions: o.max_sessions.filter(|n| *n > 0).unwrap_or(150),
            max_files_per_session: o.max_files_per_session.filter(|n| *n > 0).unwrap_or(60),
            now: o.now.unwrap_or_else(|| Arc::new(now_ms)),
            cache: HashMap::new(),
            links_file: o.links_file.unwrap_or_else(|| app_dir::settings_file("session-links.json")),
            folders_file: o.folders_file.unwrap_or_else(|| app_dir::settings_file("folders.json")),
            last_sessions: HashMap::new(),
            last_roots: HashSet::new(),
        }
    }

    fn now(&self) -> f64 {
        (self.now)()
    }

    pub fn index(&mut self) -> Result<Index> {
        let projects_dir = self.claude_dir.join("projects");
        let mut ts = list_transcripts(&projects_dir);
        ts.sort_by(|a, b| b.mtime_ms.partial_cmp(&a.mtime_ms).unwrap_or(std::cmp::Ordering::Equal));
        ts.truncate(self.max_sessions);

        let mut sessions = Vec::new();
        for t in &ts {
            if let Some(s) = self.read_session_cached(t) {
                sessions.push(s);
            }
        }

        // 프로젝트 루트별로 묶기 (처음 나온 순서 유지)
        let mut by_root: Vec<(String, Vec<Session>)> = Vec::new();
        let mut pos: HashMap<String, usize> = HashMap::new();
        for s in sessions {
            let root = project_root(&s.cwd);
            let i = *pos.entry(root.clone()).or_insert_with(|| {
                by_root.push((root.clone(), Vec::new()));
                by_root.len() - 1
            });
            by_root[i].1.push(s);
        }

        let links = self.read_links();
        let mut projects: Vec<Project> = Vec::new();
        self.last_sessions = HashMap::new();
        for (root, mut list) in by_root {
            list.sort_by(|a, b| b.last_at.partial_cmp(&a.last_at).unwrap_or(std::cmp::Ordering::Equal));
            let ids: HashSet<String> = list.iter().map(|s| s.id.clone()).collect();
            for s in list.iter_mut() {
                for f in s.files.iter_mut() {
                    f.rel = relative_label(&root, &f.path);
                }
                let key = format!("{}::{}", root, s.id);
                let pick = |m: &Map<String, Value>| -> Option<String> {
                    m.get(&key)
                        .and_then(|v| v.as_str())
                        .filter(|p| !p.is_empty() && ids.contains(*p) && *p != s.id)
                        .map(|p| p.to_string())
                };
                s.parent_id = pick(&links.parents);
                s.prev_id = pick(&links.prev); // 줄기: 툰 이어가기로 이어진 앞 세션
                // 주제 가지: 정해 둔 것 → 첫 메시지의 "topic: X"
                s.topic = match links.topics.get(&key) {
                    Some(v) => v.as_str().map(|x| x.to_string()),
                    None => topic_of(&s.first_prompt),
                };
                // 종류: 정해 둔 것 → 코드 파일을 고쳤으면 code, 아니면 chat
                s.kind = match links.kinds.get(&key).and_then(|v| v.as_str()) {
                    Some(k) if k == "chat" || k == "code" => k.to_string(),
                    _ => kind_of(&s.files).to_string(),
                };
                self.last_sessions.insert(key, Last { file: s.file.clone(), cwd: s.cwd.clone() });
            }
            let name = js_basename(&root);
            projects.push(Project {
                name: if name.is_empty() { root.clone() } else { name },
                last_at: list[0].last_at,
                hub: read_hub_short(&root),
                root,
                sessions: list,
                added: None,
            });
        }
        // 더해 둔 폴더 중 세션이 아직 없는 것: 빈 폴더로 넣는다 (지운 폴더는 뺀다)
        for dir in self.folders() {
            let root = project_root(&dir);
            if pos.contains_key(&root) || projects.iter().any(|p| p.root == root) {
                continue;
            }
            let st = match fs::metadata(&root) {
                Ok(s) => s,
                Err(_) => continue,
            };
            if !st.is_dir() {
                continue;
            }
            let name = js_basename(&root);
            projects.push(Project {
                name: if name.is_empty() { root.clone() } else { name },
                last_at: mtime_ms(&st),
                hub: read_hub_short(&root),
                root,
                sessions: vec![],
                added: Some(true),
            });
        }
        projects.sort_by(|a, b| b.last_at.partial_cmp(&a.last_at).unwrap_or(std::cmp::Ordering::Equal));
        self.last_roots = projects.iter().map(|p| p.root.clone()).collect();

        Ok(Index { generated_at: self.now(), claude_dir: self.claude_dir.to_string_lossy().into_owned(), projects })
    }

    /// 더해 둔 폴더 목록
    pub fn folders(&self) -> Vec<String> {
        let d: Value = match fs::read_to_string(&self.folders_file).ok().and_then(|t| serde_json::from_str(&t).ok()) {
            Some(d) => d,
            None => return vec![],
        };
        match d.get("folders").and_then(|f| f.as_array()) {
            Some(a) => a.iter().filter_map(|f| f.as_str()).filter(|f| f.starts_with('/')).map(|f| f.to_string()).collect(),
            None => vec![],
        }
    }

    /// 폴더 더하기 (새로 만든 폴더 등). 이미 있으면 그대로
    pub fn add_folder(&self, dir: &str) -> Result<String> {
        if dir.is_empty() || !dir.starts_with('/') {
            bail!("폴더 경로가 아니에요");
        }
        let st = fs::metadata(dir).map_err(|e| io_err(e, "stat", Path::new(dir)))?;
        if !st.is_dir() {
            bail!("폴더가 아니에요");
        }
        let mut list = self.folders();
        if !list.iter().any(|f| f == dir) {
            list.push(dir.to_string());
        }
        if let Some(p) = self.folders_file.parent() {
            fs::create_dir_all(p)?;
        }
        fs::write(&self.folders_file, serde_json::to_string_pretty(&json!({ "version": 1, "folders": list }))?)?;
        Ok(project_root(dir))
    }

    // ---------------------------------------------------------------------
    // 세션 묶기 / 다른 폴더로 복사
    // ---------------------------------------------------------------------
    fn read_links(&self) -> Links {
        let d: Option<Value> = fs::read_to_string(&self.links_file).ok().and_then(|t| serde_json::from_str(&t).ok());
        let obj = |k: &str| -> Map<String, Value> {
            d.as_ref().and_then(|d| d.get(k)).and_then(|v| v.as_object()).cloned().unwrap_or_default()
        };
        Links { parents: obj("parents"), prev: obj("prev"), topics: obj("topics"), kinds: obj("kinds") }
    }

    fn write_links(&self, l: &Links) -> Result<()> {
        if let Some(p) = self.links_file.parent() {
            fs::create_dir_all(p)?;
        }
        let v = json!({ "version": 1, "parents": l.parents, "prev": l.prev, "topics": l.topics, "kinds": l.kinds });
        let mut tmp = self.links_file.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        fs::write(&tmp, serde_json::to_string_pretty(&v)?)?;
        fs::rename(&tmp, &self.links_file)?;
        Ok(())
    }

    fn has(&self, root: &str, id: &str) -> bool {
        self.last_sessions.contains_key(&format!("{}::{}", root, id))
    }

    /// 복사·이동 직후 바로 붙일 수 있게 임시 등록 (main.js 의 lastSessions.set)
    pub fn remember_session(&mut self, root: &str, id: &str) {
        self.last_sessions.entry(format!("{}::{}", root, id)).or_insert(Last { file: String::new(), cwd: root.to_string() });
    }

    /// 지난 index 에 나온 폴더인가
    pub fn has_root(&self, root: &str) -> bool {
        self.last_roots.contains(root)
    }

    /// 세션을 같은 폴더의 다른 세션 아래에 붙인다 (parent_id 가 None 이면 떼어낸다)
    pub fn set_parent(&self, root: &str, id: &str, parent_id: Option<&str>) -> Result<Value> {
        let parent_id = parent_id.filter(|p| !p.is_empty());
        if !self.has(root, id) {
            bail!("세션 목록에 없는 세션이에요");
        }
        if let Some(p) = parent_id {
            if !self.has(root, p) {
                bail!("같은 폴더의 세션에만 붙일 수 있어요");
            }
        }
        let mut links = self.read_links();
        let key = format!("{}::{}", root, id);
        if let Some(p) = parent_id {
            // 자기 자신이나 자기 하위 세션 아래로는 못 붙인다
            let mut cur = Some(p.to_string());
            let mut guard = 0;
            while let Some(c) = cur {
                if c == id || guard > 1000 {
                    bail!("자기 하위 세션 아래로는 붙일 수 없어요");
                }
                cur = links.parents.get(&format!("{}::{}", root, c)).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
                guard += 1;
            }
            links.parents.insert(key, Value::String(p.to_string()));
        } else {
            links.parents.remove(&key);
        }
        self.write_links(&links)?;
        Ok(json!({ "root": root, "id": id, "parentId": parent_id }))
    }

    /// 새로 만든 세션을 제자리에 붙인다 (한 번에 쓰기): 하위 세션, 줄기의 앞 세션, 주제, 종류
    pub fn set_meta(&self, root: &str, id: &str, p: &MetaPatch) -> Result<Value> {
        if let Some(Some(k)) = &p.kind {
            if k != "chat" && k != "code" {
                bail!("세션 종류는 chat 또는 code 예요");
            }
        }
        if !self.has(root, id) {
            bail!("세션 목록에 없는 세션이에요");
        }
        let topic_s = p.topic.as_ref().and_then(|t| t.as_deref()).filter(|t| !t.is_empty());
        if let Some(t) = topic_s {
            if !TOPIC_NAME_RE.is_match(t) {
                bail!("주제 이름이 올바르지 않아요");
            }
        }
        if let Some(pid) = &p.parent_id {
            self.set_parent(root, id, pid.as_deref())?;
        }
        let mut links = self.read_links();
        let key = format!("{}::{}", root, id);
        if let Some(prev) = &p.prev_id {
            let prev = prev.as_deref().filter(|s| !s.is_empty());
            if let Some(pv) = prev {
                if pv == id || !self.has(root, pv) {
                    bail!("같은 폴더의 세션만 이을 수 있어요");
                }
            }
            let mut cur = prev.map(|s| s.to_string());
            let mut guard = 0;
            while let Some(c) = cur {
                if c == id || guard > 1000 {
                    bail!("돌고 도는 줄기는 만들 수 없어요");
                }
                cur = links.prev.get(&format!("{}::{}", root, c)).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
                guard += 1;
            }
            match prev {
                Some(pv) => {
                    links.prev.insert(key.clone(), Value::String(pv.to_string()));
                }
                None => {
                    links.prev.remove(&key);
                }
            }
        }
        if p.topic.is_some() {
            // null = 주제 없음으로 고정
            links.topics.insert(key.clone(), topic_s.map(|t| Value::String(t.to_string())).unwrap_or(Value::Null));
        }
        if let Some(k) = &p.kind {
            match k.as_deref().filter(|s| !s.is_empty()) {
                Some(k) => {
                    links.kinds.insert(key.clone(), Value::String(k.to_string()));
                }
                None => {
                    links.kinds.remove(&key); // null = 다시 자동
                }
            }
        }
        self.write_links(&links)?;
        let mut out = Map::new();
        out.insert("root".into(), json!(root));
        out.insert("id".into(), json!(id));
        for (k, v) in [("parentId", &p.parent_id), ("prevId", &p.prev_id), ("topic", &p.topic), ("kind", &p.kind)] {
            if let Some(v) = v {
                out.insert(k.into(), json!(v));
            }
        }
        Ok(Value::Object(out))
    }

    fn check_dest(to_root: &str) -> Result<()> {
        if to_root.is_empty() || !Path::new(to_root).is_dir() {
            bail!("폴더가 없어요: {}", to_root);
        }
        Ok(())
    }

    /// 세션을 다른 폴더로 복사한다. 원본은 그대로, 기록의 sessionId 와 cwd 를 바꿔 새 폴더 기록 자리에 쓴다.
    pub fn copy_session(&self, root: &str, id: &str, to_root: &str) -> Result<Value> {
        let s = match self.last_sessions.get(&format!("{}::{}", root, id)) {
            Some(s) => s.clone(),
            None => bail!("세션 목록에 없는 세션이에요"),
        };
        Self::check_dest(to_root)?;
        let new_id = uuid::Uuid::new_v4().to_string();
        let file = self.write_in(&s, to_root, &new_id)?;
        Ok(json!({ "root": to_root, "id": new_id, "file": file, "from": { "root": root, "id": id } }))
    }

    /// 세션을 다른 폴더로 옮긴다. id 그대로, 기록의 cwd 만 바꿔 쓰고 원본을 지운다.
    /// 작업 중(10분 안에 기록됨)인 세션은 옮기지 않는다. 하위·줄기 묶음은 끊고 세션 종류만 따라간다.
    pub fn move_session(&mut self, root: &str, id: &str, to_root: &str) -> Result<Value> {
        let s = match self.last_sessions.get(&format!("{}::{}", root, id)) {
            Some(s) => s.clone(),
            None => bail!("세션 목록에 없는 세션이에요"),
        };
        Self::check_dest(to_root)?;
        if project_root(to_root) == root {
            bail!("같은 폴더예요");
        }
        let mtime = match fs::metadata(&s.file) {
            Ok(m) => mtime_ms(&m),
            Err(_) => bail!("기록 파일이 없어요"),
        };
        if self.now() - mtime < WORKING_MS {
            bail!("작업 중인 세션이라 옮기지 않아요. 끝나고 10분 뒤에 다시 해 주세요");
        }
        let dest = self.claude_dir.join("projects").join(encode_cwd(to_root)).join(format!("{}.jsonl", id));
        if dest.exists() {
            bail!("그 폴더에 같은 세션이 이미 있어요");
        }
        let file = self.write_in(&s, to_root, id)?;
        fs::remove_file(&s.file).map_err(|e| io_err(e, "unlink", Path::new(&s.file)))?;
        // 하위 에이전트 기록 폴더(<id>/)가 있으면 같이 옮긴다
        let sub = &s.file[..s.file.len() - ".jsonl".len()];
        if Path::new(sub).is_dir() {
            let _ = fs::rename(sub, &file[..file.len() - ".jsonl".len()]);
        }
        let mut links = self.read_links();
        let key = format!("{}::{}", root, id);
        let kind = links.kinds.get(&key).and_then(|v| v.as_str()).filter(|s| !s.is_empty()).map(|s| s.to_string());
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
        if let Some(k) = kind {
            links.kinds.insert(format!("{}::{}", to_root, id), Value::String(k));
        }
        self.write_links(&links)?;
        self.cache.remove(Path::new(&s.file));
        Ok(json!({ "root": to_root, "id": id, "file": file, "from": { "root": root, "id": id } }))
    }

    /// 기록을 to_root 의 기록 자리에 new_id 로 쓴다 (sessionId·cwd 바꿈). 새 파일 경로를 돌려준다
    fn write_in(&self, s: &Last, to_root: &str, new_id: &str) -> Result<String> {
        let from_cwd = &s.cwd;
        let text = fs::read_to_string(&s.file).map_err(|e| io_err(e, "open", Path::new(&s.file)))?;
        let out: Vec<String> = text
            .split('\n')
            .map(|line| {
                if line.trim().is_empty() {
                    return line.to_string();
                }
                let mut d: Value = match serde_json::from_str(line) {
                    Ok(d) => d,
                    Err(_) => return line.to_string(),
                };
                if let Some(o) = d.as_object_mut() {
                    if js_truthy(o.get("sessionId")) {
                        o.insert("sessionId".into(), Value::String(new_id.to_string()));
                    }
                    if let Some(c) = o.get("cwd").and_then(|c| c.as_str()).map(|c| c.to_string()) {
                        if !from_cwd.is_empty() && (c == *from_cwd || c.starts_with(&format!("{}/", from_cwd))) {
                            o.insert("cwd".into(), Value::String(format!("{}{}", to_root, &c[from_cwd.len()..])));
                        }
                    }
                }
                serde_json::to_string(&d).unwrap_or_else(|_| line.to_string())
            })
            .collect();
        let dir = self.claude_dir.join("projects").join(encode_cwd(to_root));
        fs::create_dir_all(&dir)?;
        let file = dir.join(format!("{}.jsonl", new_id));
        fs::write(&file, out.join("\n"))?;
        Ok(file.to_string_lossy().into_owned())
    }

    // ---------------------------------------------------------------------
    // 기록 한 개 읽기 (캐시)
    // ---------------------------------------------------------------------
    fn read_session_cached(&mut self, t: &Transcript0) -> Option<Session> {
        let key = format!("{}:{}", t.size, t.mtime_ms);
        let mut session = match self.cache.get(&t.file) {
            Some((k, s)) if *k == key => Some(s.clone()),
            _ => {
                let s = self.read_session(&t.file, t.mtime_ms);
                if let Some(s) = &s {
                    self.cache.insert(t.file.clone(), (key, s.clone()));
                }
                s
            }
        };
        if let Some(s) = session.as_mut() {
            s.status = self.status(s.last_at).to_string();
        }
        session
    }

    fn read_session(&self, file: &Path, mtime: f64) -> Option<Session> {
        let mut s = Session {
            id: file.file_stem().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default(),
            file: file.to_string_lossy().into_owned(),
            ..Default::default()
        };
        let mut edit_order: Vec<(String, u32)> = Vec::new();
        let mut edit_pos: HashMap<String, usize> = HashMap::new();

        let dir_key = crate::session_cwd::dir_key(file);
        let bytes = fs::read(file).ok()?;
        let text = String::from_utf8_lossy(&bytes);
        for line in LINE_SPLIT_RE.split(&text) {
            if line.is_empty() {
                continue;
            }
            let ts = TS_RE.captures(line);
            if let Some(ts) = &ts {
                if let Some(ms) = date_parse(&ts[1]) {
                    if s.first_at == 0.0 || ms < s.first_at {
                        s.first_at = ms;
                    }
                    if ms > s.last_at {
                        s.last_at = ms;
                    }
                }
            }
            if !crate::session_cwd::settled(&s.cwd, &dir_key) {
                if let Some(m) = CWD_RE.captures(line) {
                    let c = unescape(&m[1]);
                    if crate::session_cwd::better(&s.cwd, &c, &dir_key) {
                        s.cwd = c;
                    }
                }
            }
            if s.git_branch.is_empty() {
                if let Some(m) = BRANCH_RE.captures(line) {
                    s.git_branch = unescape(&m[1]);
                }
            }

            // 세션 분량: 하위 에이전트 말고 본 대화의 마지막 답 (JSON 파싱 없이 숫자만)
            if line.contains("\"usage\"") && line.contains("\"type\":\"assistant\"") && !line.contains("\"isSidechain\":true") {
                if let Some(a) = IN_RE.captures(line) {
                    let num = |c: Option<regex::Captures>| c.map(|c| c[1].parse::<f64>().unwrap_or(0.0)).unwrap_or(0.0);
                    let b = num(CACHE_NEW_RE.captures(line));
                    let c = num(CACHE_READ_RE.captures(line));
                    let prev_ttl = s.context.as_ref().and_then(|c| c.ttl.clone());
                    let prev_model = s.context.as_ref().map(|c| c.model.clone()).unwrap_or_default();
                    let ttl = if TTL_1H_RE.is_match(line) {
                        Some("1h".to_string())
                    } else if TTL_5M_RE.is_match(line) {
                        Some("5m".to_string())
                    } else {
                        prev_ttl
                    };
                    let model = MODEL_RE.captures(line).map(|m| m[1].to_string()).unwrap_or(prev_model);
                    s.context = Some(Context {
                        tokens: a[1].parse::<f64>().unwrap_or(0.0) + b + c,
                        model,
                        ttl,
                        at: ts.as_ref().and_then(|t| date_parse(&t[1])).unwrap_or(0.0),
                    });
                }
            }

            // 필요한 줄만 파싱
            let want_title = line.contains("\"ai-title\"") || line.contains("\"custom-title\"");
            let want_cost = line.contains("\"cost-state\"");
            let want_tool = line.contains("\"tool_use\"") && line.contains("\"assistant\"");
            let want_prompt = s.first_prompt.is_empty() && line.contains("\"type\":\"user\"");
            if !want_title && !want_cost && !want_tool && !want_prompt {
                continue;
            }
            let d: Value = match serde_json::from_str(line) {
                Ok(d) => d,
                Err(_) => continue,
            };
            let ty = d.get("type").and_then(|t| t.as_str()).unwrap_or("");
            if ty == "custom-title" && js_truthy(d.get("customTitle")) {
                if let Some(t) = d.get("customTitle").and_then(|t| t.as_str()) {
                    s.title = t.to_string();
                    s.custom_title = true;
                }
            } else if ty == "ai-title" && !s.custom_title && js_truthy(d.get("aiTitle")) {
                if let Some(t) = d.get("aiTitle").and_then(|t| t.as_str()) {
                    s.title = t.to_string();
                }
            } else if ty == "cost-state" && d.get("totalCostUSD").map(|v| v.is_number()).unwrap_or(false) {
                s.cost_usd = d["totalCostUSD"].as_f64();
            } else if ty == "user" && s.first_prompt.is_empty() {
                s.first_prompt = prompt_text(&d);
            } else if ty == "assistant" {
                let content = d.get("message").and_then(|m| m.get("content")).and_then(|c| c.as_array());
                for b in content.into_iter().flatten() {
                    if b.get("type").and_then(|t| t.as_str()) != Some("tool_use") {
                        continue;
                    }
                    let name = b.get("name").and_then(|n| n.as_str()).unwrap_or("");
                    if !EDIT_TOOLS.contains(&name) || !js_truthy(b.get("input")) {
                        continue;
                    }
                    let input = &b["input"];
                    let pv = if js_truthy(input.get("file_path")) { input.get("file_path") } else { input.get("notebook_path") };
                    if let Some(p) = pv.and_then(|p| p.as_str()).filter(|p| !p.is_empty()) {
                        let i = *edit_pos.entry(p.to_string()).or_insert_with(|| {
                            edit_order.push((p.to_string(), 0));
                            edit_order.len() - 1
                        });
                        edit_order[i].1 += 1;
                    }
                }
            }
        }

        if s.cwd.is_empty() && s.first_at == 0.0 {
            return None; // 대화가 없는 기록
        }
        if s.last_at == 0.0 {
            s.last_at = mtime;
        }
        if s.first_at == 0.0 {
            s.first_at = s.last_at;
        }
        if s.title.is_empty() {
            s.title = if !s.first_prompt.is_empty() { crate::claude_app::title_from(&s.first_prompt, 60) } else { utf16_head(&s.id, 8) };
        }
        edit_order.sort_by(|a, b| b.1.cmp(&a.1)); // 안정 정렬 = JS 와 같다
        s.files = edit_order
            .into_iter()
            .take(self.max_files_per_session)
            .map(|(path, edits)| FileEdit { path, edits, rel: String::new() })
            .collect();
        Some(s)
    }

    fn status(&self, last_at: f64) -> &'static str {
        let age = self.now() - last_at;
        if age < WORKING_MS {
            "working"
        } else if age < RECENT_MS {
            "recent"
        } else {
            "idle"
        }
    }
}

fn unescape(raw: &str) -> String {
    serde_json::from_str::<String>(&format!("\"{}\"", raw)).unwrap_or_else(|_| raw.to_string())
}

fn prompt_text(d: &Value) -> String {
    let c = d.get("message").and_then(|m| m.get("content"));
    match c {
        Some(Value::String(s)) => s.trim().to_string(),
        Some(Value::Array(a)) => a
            .iter()
            .find(|b| b.get("type").and_then(|t| t.as_str()) == Some("text") && b.get("text").map(|t| t.is_string()).unwrap_or(false))
            .map(|b| b["text"].as_str().unwrap_or("").trim().to_string())
            .unwrap_or_default(),
        _ => String::new(),
    }
}

fn list_transcripts(projects_dir: &Path) -> Vec<Transcript0> {
    let mut out = Vec::new();
    let dirs = match fs::read_dir(projects_dir) {
        Ok(d) => d,
        Err(_) => return out,
    };
    let mut dirs: Vec<_> = dirs.flatten().collect();
    dirs.sort_by_key(|d| d.file_name()); // Node readdir 처럼 이름순 (mtime 같을 때 순서가 같아지게)
    for d in dirs {
        if !d.file_type().map(|t| t.is_dir()).unwrap_or(false) {
            continue;
        }
        let mut files: Vec<_> = match fs::read_dir(d.path()) {
            Ok(f) => f.flatten().map(|f| f.file_name().to_string_lossy().into_owned()).collect(),
            Err(_) => continue,
        };
        files.sort();
        for name in files {
            if !name.ends_with(".jsonl") {
                continue;
            }
            let file = d.path().join(&name);
            // 읽는 사이에 지워진 파일은 건너뛴다
            if let Ok(st) = fs::metadata(&file) {
                if st.is_file() && st.len() > 0 {
                    out.push(Transcript0 { file, mtime_ms: mtime_ms(&st), size: st.len() });
                }
            }
        }
    }
    out
}

// ---------------------------------------------------------------------
// 프로젝트 루트, 툰 허브
// ---------------------------------------------------------------------
fn project_root(cwd: &str) -> String {
    if cwd.is_empty() {
        return "(알 수 없음)".into();
    }
    let mut dir = cwd.to_string();
    loop {
        if Path::new(&dir).join(".git").exists() {
            return dir;
        }
        let parent = js_dirname(&dir);
        if parent == dir {
            break;
        }
        dir = parent;
    }
    cwd.to_string() // git 저장소가 아니거나 지금은 없는 폴더
}

fn relative_label(root: &str, p: &str) -> String {
    let rel = js_relative(root, p);
    if !rel.is_empty() && !rel.starts_with("..") && !rel.starts_with('/') {
        return rel;
    }
    let home = app_dir::home().to_string_lossy().into_owned();
    match p.strip_prefix(&format!("{}/", home)) {
        Some(rest) => format!("~/{}", rest),
        None => p.to_string(),
    }
}

fn topic_dirs(toon_dir: &Path) -> Option<Vec<String>> {
    let rd = fs::read_dir(toon_dir).ok()?;
    // Node readdir 은 이름순으로 돌려준다
    let mut v: Vec<String> = rd
        .flatten()
        .filter(|d| d.file_type().map(|t| t.is_dir()).unwrap_or(false) && toon_dir.join(d.file_name()).join("HUB.toon").exists())
        .map(|d| d.file_name().to_string_lossy().into_owned())
        .collect();
    v.sort();
    Some(v)
}

fn read_hub_short(root: &str) -> Option<Hub> {
    let hub_path = Path::new(root).join(".toon").join("HUB.toon");
    let text = String::from_utf8_lossy(&fs::read(&hub_path).ok()?).into_owned();
    let next: Vec<String> = text
        .split('\n')
        .map(|l| l.trim())
        .filter(|l| NEXT_RE.is_match(l) && utf16_len(l) > 4)
        .take(6)
        .map(|l| if utf16_len(l) > 160 { format!("{}…", utf16_head(l, 157)) } else { l.to_string() })
        .collect();
    let topics = topic_dirs(&Path::new(root).join(".toon")).unwrap_or_default();
    let titles = topic_titles(root, &topics);
    Some(Hub { path: hub_path.to_string_lossy().into_owned(), next, topics, titles })
}

/// 주제 허브의 화면 이름: HUB.toon 앞부분의 "title: …" (없으면 폴더 이름)
fn topic_titles(root: &str, topics: &[String]) -> Map<String, Value> {
    let mut out = Map::new();
    for t in topics {
        let name = match fs::read(Path::new(root).join(".toon").join(t).join("HUB.toon")) {
            Ok(b) => {
                let head = utf16_head(&String::from_utf8_lossy(&b), 2000);
                match TITLE_RE.captures(&head) {
                    Some(m) => m[1].trim().to_string(),
                    None => t.clone(),
                }
            }
            Err(_) => t.clone(),
        };
        out.insert(t.clone(), Value::String(name));
    }
    out
}

// ---------------------------------------------------------------------
// 공개 정적 함수
// ---------------------------------------------------------------------

/// 첫 메시지 "툰 불러와 — …, topic: X, …" 의 주제
pub fn topic_of(prompt: &str) -> Option<String> {
    let head = utf16_head(prompt, 2000);
    TOPIC_RE.captures(&head).map(|m| m[1].to_string())
}

/// 세션 종류 짐작: 문서·툰·설정 말고 코드 파일을 고쳤으면 code, 아니면 chat
pub fn kind_of(files: &[FileEdit]) -> &'static str {
    if files.iter().any(|f| !NOT_CODE_RE.is_match(&f.path) && !TOON_DIR_RE.is_match(&f.path)) {
        "code"
    } else {
        "chat"
    }
}

/// Claude Code 가 기록 폴더 이름을 만드는 방식: 영문·숫자 말고는 모두 '-'
pub fn encode_cwd(cwd: &str) -> String {
    cwd.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect()
}

/// 툰 허브 전문 읽기: <root>/.toon/HUB.toon, 또는 주제 허브 <root>/.toon/<topic>/HUB.toon
pub fn read_hub(root: &str, topic: Option<&str>) -> Result<HubText> {
    let topic = topic.filter(|t| !t.is_empty());
    if let Some(t) = topic {
        if !TOPIC_NAME_RE.is_match(t) {
            bail!("주제 이름이 올바르지 않아요");
        }
    }
    let toon_dir = Path::new(root).join(".toon");
    let hub_path = match topic {
        Some(t) => toon_dir.join(t).join("HUB.toon"),
        None => toon_dir.join("HUB.toon"),
    };
    let st = fs::metadata(&hub_path).map_err(|e| io_err(e, "stat", &hub_path))?;
    if st.len() > 2 * 1024 * 1024 {
        bail!("허브 파일이 너무 커요");
    }
    let mut topics = topic_dirs(&toon_dir).unwrap_or_default();
    topics.sort();
    let text = fs::read(&hub_path).map_err(|e| io_err(e, "open", &hub_path))?;
    let titles = topic_titles(root, &topics);
    Ok(HubText {
        root: root.to_string(),
        topic: topic.map(|t| t.to_string()),
        path: hub_path.to_string_lossy().into_owned(),
        text: String::from_utf8_lossy(&text).into_owned(),
        mtime_ms: mtime_ms(&st),
        topics,
        titles,
    })
}

fn tool_target(input: &Value) -> String {
    let mut v = String::new();
    for k in ["file_path", "notebook_path", "path", "pattern", "command", "url", "description", "query"] {
        let x = input.get(k);
        if js_truthy(x) {
            v = match x.unwrap() {
                Value::String(s) => s.clone(),
                Value::Number(n) => n.to_string(),
                Value::Bool(b) => b.to_string(),
                _ => "[object Object]".into(),
            };
            break;
        }
    }
    let s = WS_RE.replace_all(&v, " ").trim().to_string();
    if utf16_len(&s) > 80 {
        format!("{}…", utf16_head(&s, 79))
    } else {
        s
    }
}

/// 대화창용: 기록 파일을 사람/Claude 메시지 목록으로 바꾼다.
/// 사람이 쓴 메시지만 user 로, 이어진 assistant 기록은 한 덩어리로 합치고 도구 호출은 {name, target} 으로 요약.
pub fn read_transcript(file: &str, limit: Option<usize>) -> Result<Transcript> {
    let limit = limit.unwrap_or(300);
    let st = fs::metadata(file).map_err(|e| io_err(e, "stat", Path::new(file)))?;
    let bytes = fs::read(file).map_err(|e| io_err(e, "open", Path::new(file)))?;
    let text = String::from_utf8_lossy(&bytes);
    let mut messages: Vec<Message> = Vec::new();
    for line in LINE_SPLIT_RE.split(&text) {
        if line.is_empty() || (!line.contains("\"type\":\"user\"") && !line.contains("\"type\":\"assistant\"")) {
            continue;
        }
        let d: Value = match serde_json::from_str(line) {
            Ok(d) => d,
            Err(_) => continue,
        };
        if js_truthy(d.get("isSidechain")) || js_truthy(d.get("isMeta")) || !js_truthy(d.get("message")) {
            continue;
        }
        let at = d.get("timestamp").and_then(|t| t.as_str()).and_then(date_parse).unwrap_or(0.0);
        let content = d["message"].get("content");
        let ty = d.get("type").and_then(|t| t.as_str()).unwrap_or("");

        if ty == "user" {
            let mut text = String::new();
            match content {
                Some(Value::String(s)) => text = s.clone(),
                Some(Value::Array(a)) => {
                    if a.iter().any(|b| b.get("type").and_then(|t| t.as_str()) == Some("tool_result")) {
                        continue;
                    }
                    text = a
                        .iter()
                        .filter(|b| b.get("type").and_then(|t| t.as_str()) == Some("text"))
                        .map(|b| b.get("text").and_then(|t| t.as_str()).unwrap_or(""))
                        .collect::<Vec<_>>()
                        .join("\n");
                }
                _ => {}
            }
            // 클로드 앱이 보낸 메시지는 앞에 <system-reminder> 안내가 붙는다 → 안내만 빼고 사람 글은 남긴다
            let text = REMINDER_RE.replace_all(&text, "").trim().to_string();
            if text.is_empty() || CMD_TEXT_RE.is_match(&text) {
                continue;
            }
            messages.push(Message { role: "user".into(), text, tools: vec![], at });
            continue;
        }
        if ty != "assistant" {
            continue;
        }

        let blocks: &[Value] = content.and_then(|c| c.as_array()).map(|a| a.as_slice()).unwrap_or(&[]);
        if messages.last().map(|m| m.role != "assistant").unwrap_or(true) {
            messages.push(Message { role: "assistant".into(), text: String::new(), tools: vec![], at });
        }
        let last = messages.last_mut().unwrap();
        for b in blocks {
            match b.get("type").and_then(|t| t.as_str()) {
                Some("text") if js_truthy(b.get("text")) => {
                    if let Some(t) = b["text"].as_str() {
                        if !last.text.is_empty() {
                            last.text.push_str("\n\n");
                        }
                        last.text.push_str(t.trim());
                    }
                }
                Some("tool_use") => {
                    let input = match b.get("input") {
                        Some(i) if js_truthy(Some(i)) => i.clone(),
                        _ => json!({}),
                    };
                    last.tools.push(ToolUse { name: b.get("name").cloned(), target: tool_target(&input) });
                }
                _ => {}
            }
        }
        if at != 0.0 {
            last.at = at;
        }
    }
    let cleaned: Vec<Message> = messages.into_iter().filter(|m| !m.text.is_empty() || !m.tools.is_empty()).collect();
    let truncated = cleaned.len() > limit;
    let skip = cleaned.len().saturating_sub(limit);
    Ok(Transcript { messages: cleaned.into_iter().skip(skip).collect(), truncated, mtime_ms: mtime_ms(&st) })
}

// ---------------------------------------------------------------------
// git 상태
// ---------------------------------------------------------------------
pub struct RunResult {
    pub code: i32,
    pub stdout: String,
}

pub struct GitState {
    pub dirty: HashSet<String>,
    pub ahead: HashSet<String>,
    pub upstream: Option<String>,
}

/// 로그인 셸 PATH 로 git 실행 (실패해도 던지지 않고 code 를 돌려준다). 15초 넘으면 죽인다
pub fn run_git(args: &[&str], cwd: &str) -> RunResult {
    use std::process::Stdio;
    let mut cmd = login_path::command("git");
    cmd.args(args)
        .current_dir(cwd)
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_OPTIONAL_LOCKS", "0")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(_) => return RunResult { code: 1, stdout: String::new() },
    };
    let mut out = child.stdout.take().unwrap();
    let reader = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let _ = out.read_to_end(&mut buf);
        buf
    });
    let start = Instant::now();
    let code = loop {
        match child.try_wait() {
            Ok(Some(st)) => break st.code().unwrap_or(1),
            Ok(None) => {
                if start.elapsed() > Duration::from_secs(15) {
                    let _ = child.kill();
                    let _ = child.wait();
                    break 1;
                }
                std::thread::sleep(Duration::from_millis(5));
            }
            Err(_) => break 1,
        }
    };
    let buf = reader.join().unwrap_or_default();
    RunResult { code, stdout: String::from_utf8_lossy(&buf).into_owned() }
}

/// 저장소 한 개의 상태 (git 저장소가 아니면 None)
pub fn git_state(root: &str, run: &dyn Fn(&[&str], &str) -> RunResult) -> Option<GitState> {
    let status = run(&["status", "--porcelain=v1", "-z", "--untracked-files=all"], root);
    if status.code != 0 {
        return None;
    }
    let mut dirty = HashSet::new();
    let parts: Vec<&str> = status.stdout.split('\0').collect();
    let mut i = 0;
    while i < parts.len() {
        let e = parts[i];
        if e.chars().count() >= 4 {
            // 앞 3글자(XY + 공백)를 뺀다
            let rest: String = e.chars().skip(3).collect();
            dirty.insert(rest);
            let c0 = e.chars().next().unwrap();
            if c0 == 'R' || c0 == 'C' {
                i += 1; // 이름 바꾸기: 다음 칸이 옛 이름
                if let Some(old) = parts.get(i) {
                    dirty.insert(old.to_string());
                }
            }
        }
        i += 1;
    }
    let up = run(&["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], root);
    let upstream = if up.code == 0 { Some(up.stdout.trim().to_string()) } else { None };
    // 올릴 곳(upstream)이 없는 새 브랜치면 어느 원격 브랜치에도 없는 커밋만 (원격이 아예 없으면 전부)
    let range: Vec<&str> = if upstream.is_some() { vec!["@{u}..HEAD"] } else { vec!["HEAD", "--not", "--remotes"] };
    let mut args = vec!["log"];
    args.extend(range);
    args.extend(["--name-only", "--pretty=format:", "-n", "500"]);
    let log = run(&args, root);
    let ahead: HashSet<String> = if log.code == 0 {
        log.stdout.split('\n').map(|l| l.trim().to_string()).filter(|l| !l.is_empty()).collect()
    } else {
        HashSet::new()
    };
    Some(GitState { dirty, ahead, upstream })
}

/// 세션마다 git 상태를 붙인다 (그 세션이 고친 파일 기준): dirty / ahead / pushed.
/// 고친 파일이 없거나 git 저장소가 아니면 null. 프로젝트마다 스레드로 돈다
pub fn attach_git(index: &mut Index, run: &(dyn Fn(&[&str], &str) -> RunResult + Sync)) {
    let states: Vec<Option<Option<GitState>>> = std::thread::scope(|sc| {
        let hs: Vec<_> = index
            .projects
            .iter()
            .map(|p| {
                let has_files = p.sessions.iter().any(|s| !s.files.is_empty());
                let root = p.root.clone();
                sc.spawn(move || if has_files { Some(git_state(&root, run)) } else { None })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap_or(None)).collect()
    });
    for (p, st) in index.projects.iter_mut().zip(states) {
        let st = match st {
            Some(st) => st,
            None => continue, // 고친 파일이 있는 세션이 없으면 건드리지 않는다
        };
        for s in p.sessions.iter_mut() {
            s.git = Some(None);
        }
        let st = match st {
            Some(st) => st,
            None => continue,
        };
        for s in p.sessions.iter_mut().filter(|s| !s.files.is_empty()) {
            let rels: Vec<String> = s
                .files
                .iter()
                .map(|f| js_relative(&p.root, &f.path))
                .filter(|r| !r.is_empty() && !r.starts_with("..") && !r.starts_with('/'))
                .collect();
            if rels.is_empty() {
                continue;
            }
            let g = if rels.iter().any(|r| st.dirty.contains(r)) {
                "dirty"
            } else if rels.iter().any(|r| st.ahead.contains(r)) {
                "ahead"
            } else {
                "pushed"
            };
            s.git = Some(Some(g.to_string()));
        }
    }
}

/// attach_git 기본 실행기 (진짜 git)
pub fn attach_git_real(index: &mut Index) {
    attach_git(index, &|args, cwd| run_git(args, cwd));
}

#[cfg(test)]
mod tests {
    use super::*;

    const NOW: f64 = 1_791_039_600_000.0; // 2026-10-03T15:00:00Z

    fn line(v: Value) -> String {
        format!("{}\n", v)
    }
    fn user(ts: &str, cwd: &str, content: Value) -> String {
        line(json!({"type":"user","timestamp":ts,"cwd":cwd,"gitBranch":"main","sessionId":"x","message":{"role":"user","content":content}}))
    }
    fn edit(ts: &str, name: &str, key: &str, p: &str) -> String {
        line(json!({"type":"assistant","timestamp":ts,"message":{"role":"assistant","content":[{"type":"tool_use","name":name,"input":{key:p}}]}}))
    }
    fn usage(ts: &str, u: Value, side: bool) -> String {
        line(json!({"type":"assistant","timestamp":ts,"isSidechain":side,"message":{"model":"claude-x","role":"assistant","content":[{"type":"text","text":"\"input_tokens\":7"}],"usage":u}}))
    }
    fn write_session(claude: &Path, dir: &str, id: &str, body: &str) {
        let d = claude.join("projects").join(dir);
        fs::create_dir_all(&d).unwrap();
        fs::write(d.join(format!("{}.jsonl", id)), body).unwrap();
    }
    fn s<'a>(p: &'a Project, id: &str) -> &'a Session {
        p.sessions.iter().find(|x| x.id == id).unwrap()
    }
    fn opts(claude: &Path, links: &Path, folders: &Path, now: f64) -> Options {
        Options {
            claude_dir: Some(claude.to_path_buf()),
            links_file: Some(links.to_path_buf()),
            folders_file: Some(folders.to_path_buf()),
            now: Some(Arc::new(move || now)),
            ..Default::default()
        }
    }
    fn err(r: Result<Value>) -> String {
        r.unwrap_err().to_string()
    }

    #[test]
    fn indexer_all() {
        let tmp_h = tempfile::tempdir().unwrap();
        let tmp = tmp_h.path().to_path_buf();
        let claude = tmp.join(".claude");
        let repo = tmp.join("logic-pro-mcp");
        let repo_s = repo.to_string_lossy().into_owned();
        let links0 = tmp.join("links0.json");
        let folders0 = tmp.join("folders0.json");

        fs::create_dir_all(repo.join(".git")).unwrap();
        fs::create_dir_all(repo.join(".toon/logic-ax")).unwrap();
        fs::write(repo.join(".toon/HUB.toon"), "GOAL: x\nNEXT 000000 AMT 후보 3개 듣기\nNEXT 000001 MLX 검토\nother\n").unwrap();
        fs::write(repo.join(".toon/logic-ax/HUB.toon"), "topic\n").unwrap();

        let sub = repo.join(".local-tools/amt");
        let sub_s = sub.to_string_lossy().into_owned();
        let pj = |a: &Path, b: &str| a.join(b).to_string_lossy().into_owned();
        write_session(
            &claude,
            "-logic-pro-mcp",
            "sess-a",
            &(user("2026-10-03T14:00:00Z", &sub_s, json!("AMT 빠르게 해줘"))
                + &edit("2026-10-03T14:10:00Z", "Edit", "file_path", &pj(&sub, "fast_sample.py"))
                + &edit("2026-10-03T14:20:00Z", "Edit", "file_path", &pj(&sub, "fast_sample.py"))
                + &edit("2026-10-03T14:30:00Z", "Write", "file_path", &pj(&sub, "batch_sample.py"))
                + &edit("2026-10-03T14:40:00Z", "Read", "file_path", &pj(&sub, "ignored.py"))
                + &line(json!({"type":"ai-title","aiTitle":"AMT 반주 최적화","sessionId":"sess-a"}))
                + &line(json!({"type":"cost-state","totalCostUSD":3.24}))
                + &usage("2026-10-03T14:44:00Z", json!({"input_tokens":5,"cache_creation_input_tokens":1000,"cache_read_input_tokens":50000,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":1000}}), false)
                + &usage("2026-10-03T14:45:00Z", json!({"input_tokens":3,"cache_creation_input_tokens":0,"cache_read_input_tokens":90000}), false)
                + &usage("2026-10-03T14:46:00Z", json!({"input_tokens":999999,"cache_read_input_tokens":1}), true)
                + "not json\n"
                + &edit("2026-10-03T14:55:00Z", "NotebookEdit", "notebook_path", &pj(&repo, "nb.ipynb"))),
        );
        write_session(
            &claude,
            "-logic-pro-mcp",
            "sess-b",
            &(user("2026-10-01T10:00:00Z", &repo_s, json!([{"type":"text","text":"툰 불러와 logic-pro-mcp"}]))
                + &edit("2026-10-01T10:05:00Z", "MultiEdit", "file_path", &pj(&sub, "fast_sample.py"))),
        );
        let notes = pj(&tmp, "notes");
        write_session(&claude, "-notes", "sess-c", &user("2026-10-03T12:00:00Z", &notes, json!("메모")));
        write_session(&claude, "-empty", "sess-empty", "");
        write_session(&claude, "-empty", "sess-meta", &line(json!({"type":"mode","mode":"normal"})));

        let mut ix0 = SessionIndexer::new(opts(&claude, &links0, &folders0, NOW));
        let r = ix0.index().unwrap();
        assert_eq!(r.projects.len(), 2, "프로젝트 2개 (git 루트로 묶임 + git 아닌 폴더)");
        let p = &r.projects[0];
        assert_eq!(p.root, repo_s, "하위 폴더 세션도 git 루트로 묶인다");
        assert_eq!(p.name, "logic-pro-mcp");
        assert_eq!(p.sessions.iter().map(|s| s.id.as_str()).collect::<Vec<_>>(), ["sess-a", "sess-b"], "최근 세션이 먼저");

        let a = &p.sessions[0];
        assert_eq!(a.title, "AMT 반주 최적화");
        assert_eq!(a.cost_usd, Some(3.24));
        assert_eq!(a.git_branch, "main");
        assert_eq!(a.status, "working", "5분 전이면 작업 중");
        let files: Vec<(String, u32)> = a.files.iter().map(|f| (f.rel.clone(), f.edits)).collect();
        assert_eq!(
            files,
            [(".local-tools/amt/fast_sample.py".to_string(), 2), (".local-tools/amt/batch_sample.py".to_string(), 1), ("nb.ipynb".to_string(), 1)],
            "Edit/Write/NotebookEdit 만 세고, Read 는 뺀다"
        );
        let c = a.context.clone().unwrap();
        assert_eq!((c.tokens, c.model.as_str(), c.ttl.as_deref()), (90003.0, "claude-x", Some("1h")), "세션 분량 = 마지막 답 합, 하위 에이전트·글 속 숫자 무시, 캐시 종류는 앞에서 이어받음");

        let b = &p.sessions[1];
        assert!(b.context.is_none(), "사용량 없는 기록");
        assert_eq!(b.title, "툰 불러와 logic-pro-mcp", "제목이 없으면 첫 프롬프트");
        assert_eq!(b.status, "idle");
        assert_eq!(b.files[0].rel, ".local-tools/amt/fast_sample.py");

        let hub = p.hub.as_ref().unwrap();
        assert_eq!(hub.next, ["NEXT 000000 AMT 후보 3개 듣기", "NEXT 000001 MLX 검토"]);
        assert_eq!(hub.topics, ["logic-ax"]);

        let c = &r.projects[1];
        assert_eq!(c.sessions[0].status, "recent", "3시간 전이면 최근");
        assert!(c.hub.is_none());

        // 캐시: 파일이 그대로면 같은 결과, 바뀌면 다시 읽는다
        let again = ix0.index().unwrap();
        assert_eq!(again.projects[0].sessions[0].files, r.projects[0].sessions[0].files);
        let bf = claude.join("projects/-logic-pro-mcp/sess-b.jsonl");
        let mut body = fs::read_to_string(&bf).unwrap();
        body += &edit("2026-10-03T14:59:00Z", "Edit", "file_path", &pj(&repo, "new.py"));
        fs::write(&bf, body).unwrap();
        let third = ix0.index().unwrap();
        let b3 = s(&third.projects[0], "sess-b");
        assert!(b3.files.iter().any(|f| f.rel == "new.py"), "바뀐 기록은 다시 읽는다");
        assert_eq!(b3.status, "working");

        // 대화창용 기록 읽기
        assert!(a.file.ends_with("sess-a.jsonl"), "세션에 기록 파일 경로가 있다");
        let tfile = claude.join("projects/-chat/sess-t.jsonl");
        fs::create_dir_all(tfile.parent().unwrap()).unwrap();
        fs::write(
            &tfile,
            user("2026-10-03T10:00:00Z", &repo_s, json!("첫 질문"))
                + &line(json!({"type":"user","timestamp":"2026-10-03T10:00:01Z","isMeta":true,"message":{"content":"메타"}}))
                + &line(json!({"type":"user","timestamp":"2026-10-03T10:00:02Z","message":{"content":"<command-name>/clear</command-name>"}}))
                + &line(json!({"type":"user","timestamp":"2026-10-03T10:00:03Z","message":{"content":[{"type":"text","text":"<system-reminder>\n앱 안내\n</system-reminder>\n"},{"type":"text","text":"앱에서 보낸 말"}]}}))
                + &line(json!({"type":"assistant","timestamp":"2026-10-03T10:00:03Z","message":{"content":[{"type":"text","text":"보고 있어"}]}}))
                + &line(json!({"type":"assistant","timestamp":"2026-10-03T10:00:04Z","message":{"content":[{"type":"tool_use","name":"Bash","input":{"command":"ls -la"}}]}}))
                + &line(json!({"type":"user","timestamp":"2026-10-03T10:00:05Z","message":{"content":[{"type":"tool_result","content":"x"}]}}))
                + &line(json!({"type":"assistant","timestamp":"2026-10-03T10:00:06Z","message":{"content":[{"type":"text","text":"끝"}]}}))
                + &line(json!({"type":"assistant","timestamp":"2026-10-03T10:00:07Z","isSidechain":true,"message":{"content":[{"type":"text","text":"하위 에이전트"}]}}))
                + &user("2026-10-03T10:01:00Z", &repo_s, json!([{"type":"text","text":"두 번째"}])),
        )
        .unwrap();
        let tf = tfile.to_string_lossy().into_owned();
        let t = read_transcript(&tf, None).unwrap();
        let got: Vec<(String, String, Vec<String>)> = t
            .messages
            .iter()
            .map(|m| (m.role.clone(), m.text.clone(), m.tools.iter().map(|x| format!("{}:{}", x.name.as_ref().unwrap().as_str().unwrap(), x.target)).collect()))
            .collect();
        assert_eq!(
            got,
            [
                ("user".to_string(), "첫 질문".to_string(), vec![]),
                ("user".to_string(), "앱에서 보낸 말".to_string(), vec![]),
                ("assistant".to_string(), "보고 있어\n\n끝".to_string(), vec!["Bash:ls -la".to_string()]),
                ("user".to_string(), "두 번째".to_string(), vec![]),
            ],
            "메타·명령·도구 결과·하위 에이전트는 빼고(앱 안내 <system-reminder> 는 그 부분만), 이어진 assistant 는 합친다"
        );
        let t2 = read_transcript(&tf, Some(2)).unwrap();
        assert!(t2.truncated);
        assert_eq!(t2.messages[0].role, "assistant");

        // 세션 묶기 / 복사
        let links = tmp.join("links.json");
        let mut ix = SessionIndexer::new(opts(&claude, &links, &folders0, NOW));
        ix.index().unwrap();
        ix.set_parent(&repo_s, "sess-b", Some("sess-a")).unwrap();
        let mut r2 = ix.index().unwrap();
        let mut pr = r2.projects.iter().find(|x| x.root == repo_s).unwrap().clone();
        assert_eq!(s(&pr, "sess-b").parent_id.as_deref(), Some("sess-a"), "같은 폴더 세션 아래로 붙는다");
        assert_eq!(s(&pr, "sess-a").parent_id, None);
        assert!(err(ix.set_parent(&repo_s, "sess-a", Some("sess-b"))).contains("하위 세션"), "돌고 도는 묶기는 막는다");
        assert!(err(ix.set_parent(&repo_s, "sess-a", Some("nope"))).contains("같은 폴더"));
        ix.set_parent(&repo_s, "sess-b", None).unwrap();
        r2 = ix.index().unwrap();
        assert_eq!(s(r2.projects.iter().find(|x| x.root == repo_s).unwrap(), "sess-b").parent_id, None, "떼어낼 수 있다");

        // 주제 가지 · 줄기
        assert_eq!(topic_of("툰 불러와 — 하위 세션, root: /a, topic: logic-ax, hub_task: x").as_deref(), Some("logic-ax"));
        assert_eq!(topic_of("그냥 질문"), None);
        assert_eq!(s(&pr, "sess-b").topic, None, "첫 메시지에 topic 없음");
        let patch = |j: Value| -> MetaPatch { serde_json::from_value(j).unwrap() };
        ix.set_meta(&repo_s, "sess-a", &patch(json!({"prevId":"sess-b","topic":"logic-ax"}))).unwrap();
        r2 = ix.index().unwrap();
        pr = r2.projects.iter().find(|x| x.root == repo_s).unwrap().clone();
        let sa = s(&pr, "sess-a");
        assert_eq!(sa.prev_id.as_deref(), Some("sess-b"), "툰 이어가기 줄기");
        assert_eq!(sa.topic.as_deref(), Some("logic-ax"), "정한 주제");
        assert_eq!(serde_json::to_value(&pr.hub.as_ref().unwrap().titles).unwrap(), json!({"logic-ax":"logic-ax"}), "title: 이 없으면 폴더 이름");
        assert!(err(ix.set_meta(&repo_s, "sess-b", &patch(json!({"prevId":"sess-a"})))).contains("돌고 도는"));
        assert!(err(ix.set_meta(&repo_s, "sess-a", &patch(json!({"topic":"눈 귀"})))).contains("주제 이름"));
        ix.set_meta(&repo_s, "sess-a", &patch(json!({"prevId":null,"topic":null}))).unwrap();
        r2 = ix.index().unwrap();
        let sa2 = s(r2.projects.iter().find(|x| x.root == repo_s).unwrap(), "sess-a").clone();
        assert_eq!(sa2.prev_id, None);
        assert_eq!(sa2.topic, None, "null 로 정하면 첫 메시지 주제도 안 쓴다");
        fs::write(repo.join(".toon/logic-ax/HUB.toon"), "## TOPIC_HUB\ntopic: logic-ax\ntitle: 로직 AX\n").unwrap();
        assert_eq!(serde_json::to_value(read_hub(&repo_s, None).unwrap().titles).unwrap(), json!({"logic-ax":"로직 AX"}), "화면 이름은 title:");

        // 세션 종류
        let fe = |p: &str| FileEdit { path: p.into(), edits: 1, rel: String::new() };
        assert_eq!(kind_of(&[fe("/a/b.js")]), "code");
        assert_eq!(kind_of(&[fe("/a/README.md"), fe("/a/.toon/x/HUB.toon")]), "chat");
        assert_eq!(kind_of(&[]), "chat");
        assert_eq!(s(&pr, "sess-a").kind, "code");
        ix.set_meta(&repo_s, "sess-a", &patch(json!({"kind":"chat"}))).unwrap();
        r2 = ix.index().unwrap();
        assert_eq!(s(r2.projects.iter().find(|x| x.root == repo_s).unwrap(), "sess-a").kind, "chat", "정해 둔 종류");
        assert!(err(ix.set_meta(&repo_s, "sess-a", &patch(json!({"kind":"music"})))).contains("종류"));
        ix.set_meta(&repo_s, "sess-a", &patch(json!({"kind":null}))).unwrap();

        let other = tmp.join("other");
        fs::create_dir(&other).unwrap();
        let other_s = other.to_string_lossy().into_owned();
        let copied = ix.copy_session(&repo_s, "sess-a", &other_s).unwrap();
        let cfile = copied["file"].as_str().unwrap();
        assert!(cfile.contains(&format!("projects/{}", encode_cwd(&other_s))), "새 폴더의 기록 폴더에 쓴다");
        let text = fs::read_to_string(cfile).unwrap();
        let lines: Vec<&str> = text.split('\n').filter(|l| !l.is_empty()).collect();
        let parsed: Vec<Value> = lines.iter().filter(|l| l.starts_with('{')).map(|l| serde_json::from_str(l).unwrap()).collect();
        let cid = copied["id"].as_str().unwrap();
        assert!(parsed.iter().filter(|d| d.get("sessionId").is_some()).all(|d| d["sessionId"] == cid), "sessionId 를 새 id 로");
        assert!(parsed.iter().filter(|d| d.get("cwd").is_some()).all(|d| d["cwd"].as_str().unwrap().starts_with(&other_s)), "cwd 를 새 폴더로");
        assert!(lines.contains(&"not json"), "JSON 아닌 줄은 그대로");
        assert!(claude.join("projects/-logic-pro-mcp/sess-a.jsonl").exists(), "원본은 그대로");
        assert_eq!(encode_cwd("/home/user/a.b_c"), "-home-user-a-b-c");

        // 이동: id 그대로, 원본은 사라짐, 작업 중이면 거절
        let src = claude.join("projects/-logic-pro-mcp/sess-a.jsonl");
        let old = SystemTime::UNIX_EPOCH + Duration::from_millis((NOW - 3_600_000.0) as u64);
        fs::OpenOptions::new().write(true).open(&src).unwrap().set_modified(old).unwrap();
        ix.set_meta(&repo_s, "sess-a", &patch(json!({"kind":"chat"}))).unwrap();
        let mut busy = SessionIndexer::new(opts(&claude, &links, &folders0, NOW - 3_600_000.0 + 1000.0));
        busy.index().unwrap();
        assert!(err(busy.move_session(&repo_s, "sess-a", &other_s)).contains("작업 중"));
        assert!(err(ix.move_session(&repo_s, "sess-a", &repo_s)).contains("같은 폴더"));
        let moved = ix.move_session(&repo_s, "sess-a", &other_s).unwrap();
        assert_eq!(moved["id"], "sess-a", "id 그대로");
        assert!(!src.exists(), "원래 자리에서는 사라진다");
        let mt = fs::read_to_string(moved["file"].as_str().unwrap()).unwrap();
        let mp: Vec<Value> = mt.split('\n').filter(|l| l.starts_with('{')).map(|l| serde_json::from_str(l).unwrap()).collect();
        assert!(
            mp.iter().filter(|d| d.get("sessionId").is_some()).all(|d| d["sessionId"] == "sess-a")
                && mp.iter().filter(|d| d.get("cwd").is_some()).all(|d| d["cwd"].as_str().unwrap().starts_with(&other_s)),
            "cwd 만 새 폴더로"
        );
        let lk: Value = serde_json::from_str(&fs::read_to_string(&links).unwrap()).unwrap();
        assert_eq!(lk["kinds"][format!("{}::sess-a", other_s)], "chat", "세션 종류는 따라간다");
        assert!(lk["kinds"].get(format!("{}::sess-a", repo_s)).is_none(), "옛 자리 묶음은 지운다");
        let after = ix.index().unwrap();
        assert!(after.projects.iter().find(|p| p.root == other_s).unwrap().sessions.iter().any(|s| s.id == "sess-a"), "새 폴더에 보인다");
        assert!(!after.projects.iter().find(|p| p.root == repo_s).map(|p| p.sessions.iter().any(|s| s.id == "sess-a")).unwrap_or(false), "옛 폴더에는 없다");

        // ~/.claude 가 없어도 빈 결과
        let none = SessionIndexer::new(opts(&tmp.join("nope"), &links0, &folders0, NOW)).index().unwrap();
        assert!(none.projects.is_empty());

        // 더한 폴더
        let folders = tmp.join("folders.json");
        let fresh = tmp.join("새 폴더");
        let fresh_s = fresh.to_string_lossy().into_owned();
        fs::create_dir(&fresh).unwrap();
        let mut fx = SessionIndexer::new(opts(&claude, &tmp.join("links2.json"), &folders, NOW));
        assert!(fx.folders().is_empty(), "파일 없으면 빈 목록");
        fx.add_folder(&fresh_s).unwrap();
        fx.add_folder(&fresh_s).unwrap();
        fx.add_folder(&repo_s).unwrap();
        fx.add_folder(&repo_s).unwrap();
        assert_eq!(fx.folders().len(), 2, "같은 폴더는 한 번만");
        assert!(fx.add_folder("relative/dir").is_err());
        let r = fx.index().unwrap();
        let added = r.projects.iter().find(|p| p.root == fresh_s).unwrap();
        assert!(added.added == Some(true) && added.sessions.is_empty(), "세션 없는 새 폴더도 보임");
        assert_eq!(r.projects.iter().filter(|p| p.root == repo_s).count(), 1, "세션 있는 폴더는 한 번만");
        fs::remove_dir_all(&fresh).unwrap();
        assert!(!fx.index().unwrap().projects.iter().any(|p| p.root == fresh_s), "지운 폴더는 안 보임");
    }

    #[test]
    fn small_helpers() {
        assert_eq!(date_parse("2026-10-03T15:00:00Z"), Some(NOW));
        assert_eq!(date_parse("2026-10-03T15:00:00.123Z"), Some(NOW + 123.0));
        assert_eq!(date_parse("2026-10-03T16:00:00+01:00"), Some(NOW));
        assert_eq!(date_parse("nope"), None);
        assert_eq!(js_relative("/a/b", "/a/b/c/d"), "c/d");
        assert_eq!(js_relative("/a/b", "/a/x"), "../x");
        assert_eq!(js_relative("/a", "/a"), "");
        assert_eq!(js_dirname("/a/b"), "/a");
        assert_eq!(js_dirname("/a"), "/");
        assert_eq!(js_basename("/a/b/"), "b");
    }

    // ---- git 상태 (test-machine-sync.js 의 앞부분) ----
    fn git(cwd: &Path, args: &[&str]) {
        let out = login_path::command("git")
            .args(args)
            .current_dir(cwd)
            .env("GIT_AUTHOR_NAME", "t")
            .env("GIT_AUTHOR_EMAIL", "t@t")
            .env("GIT_COMMITTER_NAME", "t")
            .env("GIT_COMMITTER_EMAIL", "t@t")
            .output()
            .unwrap();
        assert!(out.status.success(), "git {:?}: {}", args, String::from_utf8_lossy(&out.stderr));
    }
    fn sorted(set: &HashSet<String>) -> Vec<String> {
        let mut v: Vec<String> = set.iter().cloned().collect();
        v.sort();
        v
    }
    fn sess(id: &str, root: &str, files: &[&str]) -> Session {
        Session {
            id: id.into(),
            title: id.into(),
            cwd: root.into(),
            git_branch: "main".into(),
            status: "working".into(),
            file: format!("/x/{}.jsonl", id),
            files: files.iter().map(|f| FileEdit { path: format!("{}/{}", root, f), edits: 1, rel: (*f).into() }).collect(),
            ..Default::default()
        }
    }

    #[test]
    fn git_status() {
        let tmp_h = tempfile::tempdir().unwrap();
        let tmp = fs::canonicalize(tmp_h.path()).unwrap();
        let remote = tmp.join("remote.git");
        let repo = tmp.join("app");
        fs::create_dir(&repo).unwrap();
        git(&tmp, &["init", "-q", "--bare", remote.to_str().unwrap()]);
        git(&repo, &["init", "-q", "-b", "main"]);
        for f in ["a.js", "b.js", "c.js"] {
            fs::write(repo.join(f), "1\n").unwrap();
        }
        git(&repo, &["add", "."]);
        git(&repo, &["commit", "-q", "-m", "first"]);
        git(&repo, &["remote", "add", "origin", remote.to_str().unwrap()]);
        git(&repo, &["push", "-q", "-u", "origin", "main"]);
        fs::write(repo.join("b.js"), "2\n").unwrap();
        git(&repo, &["commit", "-q", "-am", "b"]);
        fs::write(repo.join("c.js"), "3\n").unwrap();
        fs::create_dir(repo.join("new")).unwrap();
        fs::write(repo.join("new/d.js"), "4\n").unwrap();

        let lonely = tmp.join("lonely");
        fs::create_dir(&lonely).unwrap();
        git(&lonely, &["init", "-q", "-b", "main"]);
        fs::write(lonely.join("x.js"), "1\n").unwrap();
        git(&lonely, &["add", "."]);
        git(&lonely, &["commit", "-q", "-m", "x"]);

        let real = |a: &[&str], c: &str| run_git(a, c);
        let (repo_s, lonely_s) = (repo.to_string_lossy().into_owned(), lonely.to_string_lossy().into_owned());
        let plain_s = tmp.join("plain").to_string_lossy().into_owned();
        let st = git_state(&repo_s, &real).unwrap();
        assert_eq!(sorted(&st.dirty), ["c.js", "new/d.js"], "미커밋: 고친 파일 + 새 파일(폴더 안까지)");
        assert_eq!(sorted(&st.ahead), ["b.js"], "푸시 전: @{{u}}..HEAD");
        assert_eq!(st.upstream.as_deref(), Some("origin/main"));
        assert!(git_state(&tmp.to_string_lossy(), &real).is_none(), "git 저장소가 아니면 null");

        let proj = |root: &str, name: &str, sessions: Vec<Session>| Project { root: root.into(), name: name.into(), last_at: NOW, sessions, ..Default::default() };
        let mut index = Index {
            generated_at: NOW,
            projects: vec![
                proj(
                    &repo_s,
                    "app",
                    vec![
                        sess("s-pushed", &repo_s, &["a.js"]),
                        sess("s-ahead", &repo_s, &["a.js", "b.js"]),
                        sess("s-dirty", &repo_s, &["b.js", "new/d.js"]),
                        sess("s-none", &repo_s, &[]),
                        sess("s-outside", &repo_s, &["../elsewhere.js"]),
                    ],
                ),
                proj(&lonely_s, "lonely", vec![sess("s-lonely", &lonely_s, &["x.js"])]),
                proj(&plain_s, "plain", vec![sess("s-plain", &plain_s, &["y.js"])]),
            ],
            ..Default::default()
        };
        attach_git_real(&mut index);
        let git_of = |id: &str| -> Option<Option<String>> { index.projects.iter().flat_map(|p| p.sessions.iter()).find(|s| s.id == id).unwrap().git.clone() };
        let g = |x: &str| Some(Some(x.to_string()));
        assert_eq!(git_of("s-pushed"), g("pushed"));
        assert_eq!(git_of("s-ahead"), g("ahead"));
        assert_eq!(git_of("s-dirty"), g("dirty"), "미커밋이 푸시 전보다 먼저");
        assert_eq!(git_of("s-none"), Some(None), "고친 파일이 없으면 표시 안 함");
        assert_eq!(git_of("s-outside"), Some(None), "저장소 밖 파일만 고쳤으면 표시 안 함");
        assert_eq!(git_of("s-lonely"), g("ahead"), "올릴 곳이 없으면 커밋해도 이 기기에만 있음");
        assert_eq!(git_of("s-plain"), Some(None), "git 아닌 폴더");

        // upstream 없는 새 브랜치
        git(&repo, &["stash", "-u", "-q"]);
        git(&repo, &["push", "-q", "origin", "main"]);
        git(&repo, &["checkout", "-q", "-b", "feature"]);
        fs::write(repo.join("a.js"), "5\n").unwrap();
        git(&repo, &["commit", "-q", "-am", "feature a"]);
        let st3 = git_state(&repo_s, &real).unwrap();
        assert_eq!(st3.upstream, None);
        assert_eq!(sorted(&st3.ahead), ["a.js"], "upstream 없으면 원격 브랜치에 없는 커밋만");
        git(&repo, &["checkout", "-q", "main"]);
        git(&repo, &["stash", "pop", "-q"]);

        // 이름 바꾸기도 미커밋으로
        git(&repo, &["mv", "a.js", "a2.js"]);
        let st2 = git_state(&repo_s, &real).unwrap();
        assert!(st2.dirty.contains("a.js") && st2.dirty.contains("a2.js"), "이름 바꾼 파일: 옛 이름·새 이름 모두");
        git(&repo, &["mv", "a2.js", "a.js"]);
    }
}
