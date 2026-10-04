//! src/core/GitPanel.js 를 옮긴 것. 세션 허브 GitHub 탭의 git / gh 실행.
//! - git: 상태, 최근 커밋, 변경 diff, 가져오기(pull --ff-only), 커밋, 푸시, 새 브랜치
//! - gh: PR 목록, 이슈 목록, PR 만들기(draft), 현재 브랜치 PR 체크 (gh api REST)
//! - 되돌리기 어려운 명령(force push, reset, 브랜치 삭제)은 만들지 않는다.
//! 화면(HTML)이 그대로 읽으니 JSON 모양과 한국어 오류 문구는 JS 와 같아야 한다.

use crate::login_path;
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::io::{Read, Write};
use std::path::Path;
use std::process::Stdio;
use std::time::{Duration, Instant};

/// 명령 실행 결과 (명령이 없으면 code 127)
pub struct Run {
    pub code: i32,
    pub stdout: String,
    pub stderr: String,
}

#[derive(Default)]
struct Opts<'a> {
    input: Option<&'a str>,
    timeout_ms: Option<u64>,
}

pub struct GitPanel {
    pub timeout_ms: u64,
    pub gh_bin: String,
}

impl Default for GitPanel {
    fn default() -> Self {
        Self::new()
    }
}

fn err(s: impl Into<String>) -> anyhow::Error {
    anyhow!(s.into())
}

fn truthy(v: Option<&Value>) -> bool {
    match v {
        None | Some(Value::Null) => false,
        Some(Value::Bool(b)) => *b,
        Some(Value::String(s)) => !s.is_empty(),
        Some(Value::Number(n)) => n.as_f64().map(|f| f != 0.0).unwrap_or(true),
        Some(_) => true,
    }
}

/// JS String(x || '') 흉내
fn str_of(v: Option<&Value>) -> String {
    match v {
        None | Some(Value::Null) => String::new(),
        Some(Value::String(s)) => s.clone(),
        Some(Value::Bool(false)) => String::new(),
        Some(other) => other.to_string(),
    }
}

fn slice_chars(s: &str, n: usize) -> String {
    s.chars().take(n).collect()
}

static HEAD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^(.+?)(?:\.\.\.(\S+))?(?: \[(.+)\])?$").unwrap());
static AHEAD_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"ahead (\d+)").unwrap());
static BEHIND_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"behind (\d+)").unwrap());
static WEB_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"github\.com[:/]([^/\s]+)/([^/\s]+?)(?:\.git)?/?$").unwrap());
static BRANCH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\w./-]+$").unwrap());
static NO_GH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"command not found|not found: gh").unwrap());
static AUTH_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)auth login|not logged").unwrap());

impl GitPanel {
    pub fn new() -> Self {
        let gh_bin = std::env::var("MINDMAP_GH_BIN").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "gh".into());
        GitPanel { timeout_ms: 60000, gh_bin }
    }

    pub fn with_gh_bin(gh_bin: &str) -> Self {
        GitPanel { timeout_ms: 60000, gh_bin: gh_bin.to_string() }
    }

    /// 로그인 셸 PATH 로 실행: Run (명령이 없으면 code 127)
    fn run(&self, bin: &str, args: &[&str], cwd: &str, o: Opts) -> Result<Run> {
        let mut cmd = login_path::command(bin);
        cmd.args(args)
            .current_dir(cwd)
            .env("GIT_TERMINAL_PROMPT", "0")
            .env("GH_PROMPT_DISABLED", "1")
            .env("NO_COLOR", "1")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        let mut child = match cmd.spawn() {
            Ok(c) => c,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
                if Path::new(cwd).exists() {
                    return Ok(Run { code: 127, stdout: String::new(), stderr: format!("{bin}: command not found") });
                }
                return Err(err(format!("폴더가 없어요: {cwd}")));
            }
            Err(e) => return Err(err(e.to_string())),
        };
        if let Some(mut si) = child.stdin.take() {
            if let Some(input) = o.input {
                let data = input.as_bytes().to_vec();
                // 파이프가 차서 막히지 않게 스레드에서 쓰고 닫는다
                std::thread::spawn(move || {
                    let _ = si.write_all(&data);
                });
            }
        }
        let mut so = child.stdout.take().unwrap();
        let mut se = child.stderr.take().unwrap();
        let t_out = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = so.read_to_end(&mut b);
            b
        });
        let t_err = std::thread::spawn(move || {
            let mut b = Vec::new();
            let _ = se.read_to_end(&mut b);
            b
        });
        let deadline = Instant::now() + Duration::from_millis(o.timeout_ms.unwrap_or(self.timeout_ms));
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break s,
                Ok(None) => {
                    if Instant::now() >= deadline {
                        let _ = child.kill();
                        let _ = child.wait();
                        return Err(err(format!("{bin} 가 너무 오래 걸려서 멈췄어요")));
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
                Err(e) => return Err(err(e.to_string())),
            }
        };
        let stdout = String::from_utf8_lossy(&t_out.join().unwrap_or_default()).into_owned();
        let stderr = String::from_utf8_lossy(&t_err.join().unwrap_or_default()).into_owned();
        Ok(Run { code: status.code().unwrap_or(-1), stdout, stderr })
    }

    pub(crate) fn git(&self, cwd: &str, args: &[&str]) -> Result<String> {
        self.git_o(cwd, args, Opts::default())
    }

    fn git_o(&self, cwd: &str, args: &[&str], o: Opts) -> Result<String> {
        let r = self.run("git", args, cwd, o)?;
        if r.code != 0 {
            let m = if !r.stderr.is_empty() { &r.stderr } else if !r.stdout.is_empty() { &r.stdout } else { "" };
            if m.is_empty() {
                return Err(err(format!("git {} 실패", args[0])));
            }
            return Err(err(m.trim()));
        }
        Ok(r.stdout)
    }

    fn gh(&self, cwd: &str, args: &[&str], o: Opts) -> Result<String> {
        let r = self.run(&self.gh_bin, args, cwd, o)?;
        if r.code != 0 {
            let msg = if !r.stderr.is_empty() { &r.stderr } else { &r.stdout }.trim().to_string();
            if r.code == 127 || NO_GH_RE.is_match(&msg) {
                return Err(err("gh(GitHub CLI)가 없어요. 터미널에서 brew install gh && gh auth login"));
            }
            if AUTH_RE.is_match(&msg) {
                return Err(err("gh 로그인이 필요해요. 터미널에서 gh auth login"));
            }
            if msg.is_empty() {
                return Err(err(format!("gh {} 실패", args[0])));
            }
            return Err(err(msg));
        }
        Ok(r.stdout)
    }

    fn check_dir(cwd: &str) -> Result<()> {
        if cwd.is_empty() || !Path::new(cwd).is_dir() {
            return Err(err(format!("폴더가 없어요: {cwd}")));
        }
        Ok(())
    }

    /// 저장소 상태 한 번에
    pub fn info(&self, cwd: &str) -> Result<Value> {
        Self::check_dir(cwd)?;
        let root = match self.git(cwd, &["rev-parse", "--show-toplevel"]) {
            Ok(s) => s.trim().to_string(),
            Err(_) => return Ok(json!({ "cwd": cwd, "isRepo": false })),
        };
        let status_out = self.git(&root, &["status", "--porcelain=v1", "--branch", "-z"])?;
        let log_out = self.git(&root, &["log", "-15", "--date=iso-strict", "--pretty=format:%h%x1f%s%x1f%an%x1f%ad"]).unwrap_or_default();
        let remote = self.git(&root, &["remote", "get-url", "origin"]).unwrap_or_default().trim().to_string();
        let mut res = Map::new();
        res.insert("cwd".into(), json!(cwd));
        res.insert("root".into(), json!(root));
        res.insert("isRepo".into(), json!(true));
        if let Value::Object(st) = Self::parse_status(&status_out) {
            res.extend(st);
        }
        res.insert("log".into(), Self::parse_log(&log_out));
        res.insert("remote".into(), json!(remote));
        res.insert("web".into(), Self::web_url(&remote).map(Value::from).unwrap_or(Value::Null));
        Ok(Value::Object(res))
    }

    pub fn diff(&self, root: &str, file: Option<&str>) -> Result<Value> {
        Self::check_dir(root)?;
        let file = file.filter(|f| !f.is_empty());
        let mut args = vec!["diff", "--no-color", "HEAD", "--"];
        if let Some(f) = file {
            args.push(f);
        }
        let mut out = self.git(root, &args).unwrap_or_default();
        if out.is_empty() {
            if let Some(f) = file {
                // 새 파일(추적 전)은 내용 앞부분을 보여 준다
                let full = Path::new(root).join(f);
                if full.is_file() {
                    let body = String::from_utf8_lossy(&std::fs::read(&full).unwrap_or_default()).into_owned();
                    out = format!("새 파일: {f}\n\n{}", slice_chars(&body, 20000));
                }
            }
        }
        let diff = if out.chars().count() > 200000 { format!("{}\n… (너무 길어서 잘랐어요)", slice_chars(&out, 200000)) } else { out };
        let mut m = Map::new();
        m.insert("root".into(), json!(root));
        if let Some(f) = file {
            m.insert("file".into(), json!(f));
        }
        m.insert("diff".into(), json!(diff));
        Ok(Value::Object(m))
    }

    pub fn action(&self, root: &str, req: &Value) -> Result<Value> {
        Self::check_dir(root)?;
        let action = req.get("action").and_then(Value::as_str).unwrap_or("");
        match action {
            "pull" => Ok(json!({ "out": self.git_o(root, &["pull", "--ff-only"], Opts { timeout_ms: Some(120000), ..Default::default() })? })),
            "commit" => {
                let msg = str_of(req.get("message")).trim().to_string();
                if msg.is_empty() {
                    return Err(err("커밋 메시지를 써 주세요"));
                }
                let files: Vec<String> = req
                    .get("files")
                    .and_then(Value::as_array)
                    .map(|a| a.iter().map(|v| str_of(Some(v))).collect())
                    .unwrap_or_default();
                if truthy(req.get("all")) {
                    self.git(root, &["add", "-A"])?;
                } else if !files.is_empty() {
                    let mut args = vec!["add", "--"];
                    args.extend(files.iter().map(String::as_str));
                    self.git(root, &args)?;
                }
                Ok(json!({ "out": self.git_o(root, &["commit", "-F", "-"], Opts { input: Some(&msg), ..Default::default() })? }))
            }
            "push" => {
                let branch = self.git(root, &["rev-parse", "--abbrev-ref", "HEAD"])?.trim().to_string();
                if branch == "HEAD" {
                    return Err(err("브랜치가 없는 상태(detached)라서 푸시하지 않아요"));
                }
                let r = self.run("git", &["push", "-u", "origin", &branch], root, Opts { timeout_ms: Some(180000), ..Default::default() })?;
                if r.code != 0 {
                    let m = if !r.stderr.is_empty() { &r.stderr } else { &r.stdout };
                    return Err(err(m.trim()));
                }
                Ok(json!({ "out": format!("{}{}", r.stderr, r.stdout).trim() }))
            }
            "branch" => {
                let name = str_of(req.get("name")).trim().to_string();
                if !BRANCH_RE.is_match(&name) || name.contains("..") {
                    return Err(err("브랜치 이름이 올바르지 않아요"));
                }
                Ok(json!({ "out": self.git(root, &["switch", "-c", &name])? }))
            }
            "pr-create" => {
                let mut args: Vec<String> = vec!["pr".into(), "create".into(), "--draft".into()];
                if truthy(req.get("title")) {
                    args.extend(["--title".into(), str_of(req.get("title")), "--body".into(), str_of(req.get("body"))]);
                } else {
                    args.push("--fill".into());
                }
                let a: Vec<&str> = args.iter().map(String::as_str).collect();
                Ok(json!({ "out": self.gh(root, &a, Opts { timeout_ms: Some(120000), ..Default::default() })? }))
            }
            _ => Err(err("모르는 작업이에요")),
        }
    }

    // gh api(REST)로 읽는다: GraphQL 이 막힌 환경에서도 동작
    fn repo_slug(&self, root: &str) -> Result<String> {
        let remote = self.git(root, &["remote", "get-url", "origin"]).unwrap_or_default().trim().to_string();
        match Self::web_url(&remote) {
            Some(web) => Ok(web.replace("https://github.com/", "")),
            None => Err(err("GitHub 저장소가 아니에요 (origin 이 github.com 이 아님)")),
        }
    }

    pub(crate) fn gh_json(&self, root: &str, path: &str, empty: &str) -> Result<Value> {
        let out = self.gh(root, &["api", path], Opts::default())?;
        let text = if out.is_empty() { empty } else { &out };
        serde_json::from_str(text).map_err(|e| err(e.to_string()))
    }

    pub fn gh_list(&self, root: &str, what: &str) -> Result<Value> {
        Self::check_dir(root)?;
        let slug = self.repo_slug(root)?;
        let arr = |v: &Value| v.as_array().cloned().unwrap_or_default();
        match what {
            "prs" => {
                let items = self.gh_json(root, &format!("repos/{slug}/pulls?state=open&per_page=30"), "[]")?;
                Ok(json!({ "what": what, "items": arr(&items).iter().map(Self::pr_from_rest).collect::<Vec<_>>() }))
            }
            "issues" => {
                let items = self.gh_json(root, &format!("repos/{slug}/issues?state=open&per_page=30"), "[]")?;
                let list: Vec<Value> = arr(&items)
                    .iter()
                    .filter(|x| truthy(x.get("pull_request")) == false)
                    .map(|x| {
                        let labels: Vec<Value> = x.get("labels").and_then(Value::as_array).map(|a| a.iter().map(|l| l.get("name").cloned().unwrap_or(Value::Null)).collect()).unwrap_or_default();
                        json!({ "number": x.get("number"), "title": x.get("title"), "url": x.get("html_url"), "labels": labels, "updatedAt": x.get("updated_at") })
                    })
                    .collect();
                Ok(json!({ "what": what, "items": list }))
            }
            "checks" => {
                let sha = self.git(root, &["rev-parse", "HEAD"])?.trim().to_string();
                let data = self.gh_json(root, &format!("repos/{slug}/commits/{sha}/check-runs?per_page=50"), "{}")?;
                let runs: Vec<Value> = data
                    .get("check_runs")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .map(|c| {
                                let st = ["conclusion", "status"].iter().filter_map(|k| c.get(*k).and_then(Value::as_str)).find(|s| !s.is_empty()).unwrap_or("").to_uppercase();
                                json!({ "name": c.get("name"), "state": st, "link": c.get("html_url") })
                            })
                            .collect()
                    })
                    .unwrap_or_default();
                let mut m = Map::new();
                m.insert("what".into(), json!(what));
                let empty = runs.is_empty();
                m.insert("items".into(), Value::Array(runs));
                if empty {
                    m.insert("note".into(), json!("이 커밋에 체크가 없어요 (푸시 전이거나 CI 가 없음)"));
                }
                Ok(Value::Object(m))
            }
            _ => Err(err("모르는 목록이에요")),
        }
    }

    pub fn pr_from_rest(p: &Value) -> Value {
        let head_ref = p.get("head").filter(|h| truthy(Some(h))).map(|h| h.get("ref").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null);
        let author = p.get("user").filter(|u| truthy(Some(u))).map(|u| u.get("login").cloned().unwrap_or(Value::Null)).unwrap_or(Value::Null);
        json!({
            "number": p.get("number"), "title": p.get("title"), "isDraft": truthy(p.get("draft")),
            "headRefName": head_ref, "url": p.get("html_url"), "author": author, "updatedAt": p.get("updated_at")
        })
    }

    // ---------------------------------------------------------------------
    // 파싱
    // ---------------------------------------------------------------------
    pub fn parse_status(out: &str) -> Value {
        let parts: Vec<&str> = out.split('\0').filter(|s| !s.is_empty()).collect();
        let (mut branch, mut upstream, mut ahead, mut behind) = (Value::Null, Value::Null, 0u64, 0u64);
        let mut changes: Vec<Value> = Vec::new();
        let mut i = 0;
        while i < parts.len() {
            let p = parts[i];
            if let Some(head) = p.strip_prefix("## ") {
                if let Some(m) = HEAD_RE.captures(head) {
                    let b = m.get(1).unwrap().as_str();
                    branch = json!(b.strip_prefix("No commits yet on ").unwrap_or(b));
                    upstream = m.get(2).map(|x| json!(x.as_str())).unwrap_or(Value::Null);
                    let tail = m.get(3).map(|x| x.as_str()).unwrap_or("");
                    ahead = AHEAD_RE.captures(tail).and_then(|c| c[1].parse().ok()).unwrap_or(0);
                    behind = BEHIND_RE.captures(tail).and_then(|c| c[1].parse().ok()).unwrap_or(0);
                }
                i += 1;
                continue;
            }
            let xy: String = p.chars().take(2).collect();
            let file: String = p.chars().skip(3).collect();
            let x0 = xy.chars().next().unwrap_or(' ');
            let mut ch = Map::new();
            ch.insert("xy".into(), json!(xy));
            ch.insert("path".into(), json!(file));
            ch.insert("staged".into(), json!(x0 != ' ' && x0 != '?'));
            ch.insert("label".into(), json!(Self::label(&xy)));
            if x0 == 'R' || x0 == 'C' {
                i += 1;
                if let Some(from) = parts.get(i) {
                    ch.insert("from".into(), json!(from));
                }
            }
            changes.push(Value::Object(ch));
            i += 1;
        }
        json!({ "branch": branch, "upstream": upstream, "ahead": ahead, "behind": behind, "changes": changes })
    }

    pub fn label(xy: &str) -> String {
        if xy == "??" {
            return "새 파일".into();
        }
        let mut it = xy.chars();
        let a = it.next().unwrap_or(' ');
        let b = it.next().unwrap_or(' ');
        let c = if a != ' ' { a } else { b };
        match c {
            'M' => "수정".into(),
            'A' => "추가".into(),
            'D' => "삭제".into(),
            'R' => "이름 바꿈".into(),
            'C' => "복사".into(),
            'U' => "충돌".into(),
            _ => xy.trim().to_string(),
        }
    }

    pub fn parse_log(out: &str) -> Value {
        Value::Array(
            out.split('\n')
                .filter(|l| !l.is_empty())
                .map(|l| {
                    let mut f = l.split('\x1f');
                    json!({ "sha": f.next(), "subject": f.next(), "author": f.next(), "date": f.next() })
                })
                .collect(),
        )
    }

    /// origin 주소 → GitHub 웹 주소 (아니면 None)
    pub fn web_url(remote: &str) -> Option<String> {
        WEB_RE.captures(remote).map(|m| format!("https://github.com/{}/{}", &m[1], &m[2]))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::process::Command;

    fn g(cwd: &Path, args: &[&str]) -> String {
        let o = Command::new("git").args(args).current_dir(cwd).output().unwrap();
        assert!(o.status.success(), "git {args:?}: {}", String::from_utf8_lossy(&o.stderr));
        String::from_utf8_lossy(&o.stdout).into_owned()
    }

    fn gi(cwd: &Path, args: &[&str]) -> String {
        let mut a = vec!["-c", "user.name=t", "-c", "user.email=t@t"];
        a.extend(args);
        g(cwd, &a)
    }

    fn err_of(r: Result<Value>) -> String {
        r.expect_err("오류가 나야 함").to_string()
    }

    fn s(v: &Value, k: &str) -> String {
        v[k].as_str().unwrap_or("").to_string()
    }

    #[test]
    fn git_panel_flow() {
        let tmp = tempfile::tempdir().unwrap();
        let t: PathBuf = fs::canonicalize(tmp.path()).unwrap();
        // 이 컴퓨터의 전역 git 설정(서명 등)이 테스트에 끼지 않게
        let empty = t.join("empty-gitconfig");
        fs::write(&empty, "").unwrap();
        std::env::set_var("GIT_CONFIG_GLOBAL", &empty);
        for (k, v) in [("GIT_AUTHOR_NAME", "t"), ("GIT_COMMITTER_NAME", "t"), ("GIT_AUTHOR_EMAIL", "t@t"), ("GIT_COMMITTER_EMAIL", "t@t")] {
            std::env::set_var(k, v);
        }
        let (bare, repo, other) = (t.join("remote.git"), t.join("repo"), t.join("other"));
        let ps = |p: &Path| p.to_str().unwrap().to_string();
        g(&t, &["init", "-q", "--bare", "-b", "main", &ps(&bare)]);
        g(&t, &["clone", "-q", &ps(&bare), &ps(&repo)]);
        fs::write(repo.join("a.txt"), "one\n").unwrap();
        gi(&repo, &["add", "."]);
        gi(&repo, &["commit", "-q", "-m", "처음"]);
        g(&repo, &["push", "-q", "-u", "origin", "HEAD:main"]);

        let gp = GitPanel::new();
        let r = ps(&repo);

        // 저장소 아님
        assert_eq!(gp.info(&ps(&t)).unwrap()["isRepo"], json!(false));
        assert!(err_of(gp.info(&ps(&t.join("nope")))).contains("폴더가 없어요"));

        // 하위 폴더에서도 저장소 루트를 찾는다
        fs::create_dir(repo.join("sub")).unwrap();
        fs::write(repo.join("a.txt"), "one\ntwo\n").unwrap();
        fs::write(repo.join("sub").join("new.txt"), "new\n").unwrap();
        let mut info = gp.info(&ps(&repo.join("sub"))).unwrap();
        assert_eq!(s(&info, "root"), r);
        assert_eq!(s(&info, "branch"), "main");
        assert_eq!(s(&info, "upstream"), "origin/main");
        let mut ch: Vec<(String, String)> = info["changes"].as_array().unwrap().iter().map(|c| (s(c, "label"), s(c, "path"))).collect();
        ch.sort();
        let mut want = vec![("새 파일".to_string(), "sub/".to_string()), ("수정".to_string(), "a.txt".to_string())];
        want.sort();
        assert_eq!(ch, want);
        assert_eq!(s(&info["log"][0], "subject"), "처음");
        assert_eq!(info["web"], Value::Null);

        // diff: 수정 파일, 추적 전 새 파일
        assert!(s(&gp.diff(&r, Some("a.txt")).unwrap(), "diff").contains("+two"));
        assert!(s(&gp.diff(&r, Some("sub/new.txt")).unwrap(), "diff").starts_with("새 파일"));
        assert!(gp.diff(&r, None).unwrap().get("file").is_none());

        // 커밋 (모두) → ahead 1 → 푸시 → ahead 0
        assert!(err_of(gp.action(&r, &json!({"action": "commit", "message": "  ", "all": true}))).contains("메시지"));
        gp.action(&r, &json!({"action": "commit", "message": "둘째 줄\n\n본문", "all": true})).unwrap();
        info = gp.info(&r).unwrap();
        assert_eq!(info["changes"].as_array().unwrap().len(), 0);
        assert_eq!(info["ahead"], json!(1));
        assert_eq!(s(&info["log"][0], "subject"), "둘째 줄");
        gp.action(&r, &json!({"action": "push"})).unwrap();
        assert_eq!(gp.info(&r).unwrap()["ahead"], json!(0));

        // 다른 클론에서 커밋 → 가져오기
        g(&t, &["clone", "-q", &ps(&bare), &ps(&other)]);
        fs::write(other.join("b.txt"), "b\n").unwrap();
        gi(&other, &["add", "."]);
        gi(&other, &["commit", "-q", "-m", "다른 곳"]);
        g(&other, &["push", "-q"]);
        gp.action(&r, &json!({"action": "pull"})).unwrap();
        assert_eq!(s(&gp.info(&r).unwrap()["log"][0], "subject"), "다른 곳");

        // 새 브랜치, 이름 검사, 모르는 작업
        gp.action(&r, &json!({"action": "branch", "name": "claude/test-1"})).unwrap();
        assert_eq!(s(&gp.info(&r).unwrap(), "branch"), "claude/test-1");
        assert!(err_of(gp.action(&r, &json!({"action": "branch", "name": "a b"}))).contains("이름"));
        assert!(err_of(gp.action(&r, &json!({"action": "branch", "name": "a..b"}))).contains("이름"));
        assert!(err_of(gp.action(&r, &json!({"action": "reset"}))).contains("모르는"));

        // 로컬 원격이면 GitHub 아님
        assert!(err_of(gp.gh_list(&r, "prs")).contains("GitHub 저장소가 아니에요"));

        // gh 가 없을 때 알아듣게 (GitHub 원격처럼 보이게 바꿔서)
        g(&repo, &["remote", "set-url", "origin", "https://github.com/x/y.git"]);
        let no_gh = GitPanel::with_gh_bin("gh-does-not-exist");
        assert!(err_of(no_gh.gh_list(&r, "prs")).contains("gh(GitHub CLI)가 없어요"));

        // 가짜 gh: 주소(경로)에 따라 REST 응답을 돌려준다
        let fake = t.join("fake-gh.sh");
        fs::write(
            &fake,
            r#"#!/bin/sh
case "$2" in
  repos/x/y/pulls*) echo '[{"number":5,"title":"t","draft":true,"head":{"ref":"b"},"html_url":"u","user":{"login":"x"},"updated_at":"d"}]';;
  repos/x/y/issues*) echo '[{"number":1,"title":"i","html_url":"iu","labels":[{"name":"bug"}],"updated_at":"d"},{"number":2,"title":"p","pull_request":{},"labels":[]}]';;
  repos/x/y/commits/*) echo '{"check_runs":[{"name":"ci","conclusion":"success","status":"completed","html_url":"c"},{"name":"lint","conclusion":null,"status":"in_progress","html_url":"l"}]}';;
  *) echo "gh: not logged in, run: gh auth login" >&2; exit 1;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let fg = GitPanel::with_gh_bin(fake.to_str().unwrap());
        assert_eq!(
            fg.gh_list(&r, "prs").unwrap(),
            json!({"what": "prs", "items": [{"number": 5, "title": "t", "isDraft": true, "headRefName": "b", "url": "u", "author": "x", "updatedAt": "d"}]})
        );
        assert_eq!(
            fg.gh_list(&r, "issues").unwrap(),
            json!({"what": "issues", "items": [{"number": 1, "title": "i", "url": "iu", "labels": ["bug"], "updatedAt": "d"}]})
        );
        let checks = fg.gh_list(&r, "checks").unwrap();
        assert_eq!(checks["items"], json!([{"name": "ci", "state": "SUCCESS", "link": "c"}, {"name": "lint", "state": "IN_PROGRESS", "link": "l"}]));
        assert!(checks.get("note").is_none());
        assert!(err_of(fg.gh_list(&r, "nope")).contains("모르는 목록"));
        // 로그인 안 된 gh
        let unauth = t.join("unauth-gh.sh");
        fs::write(&unauth, "#!/bin/sh\necho 'To get started with GitHub CLI, please run: gh auth login' >&2\nexit 4\n").unwrap();
        fs::set_permissions(&unauth, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(err_of(GitPanel::with_gh_bin(unauth.to_str().unwrap()).gh_list(&r, "prs")).contains("gh 로그인이 필요해요"));
    }

    #[test]
    fn parsing() {
        assert_eq!(GitPanel::web_url("git@github.com:avabag01-ai/flowcode.git").as_deref(), Some("https://github.com/avabag01-ai/flowcode"));
        assert_eq!(GitPanel::web_url("https://github.com/avabag01-ai/flowcode").as_deref(), Some("https://github.com/avabag01-ai/flowcode"));
        assert_eq!(GitPanel::web_url("/local/remote.git"), None);
        let st = GitPanel::parse_status("## feat...origin/feat [ahead 2, behind 1]\0R  new.js\0old.js\0 M x.js\0");
        assert_eq!((st["branch"].as_str(), st["upstream"].as_str(), st["ahead"].as_u64(), st["behind"].as_u64()), (Some("feat"), Some("origin/feat"), Some(2), Some(1)));
        assert_eq!(
            st["changes"],
            json!([
                {"xy": "R ", "path": "new.js", "staged": true, "label": "이름 바꿈", "from": "old.js"},
                {"xy": " M", "path": "x.js", "staged": false, "label": "수정"}
            ])
        );
        let st = GitPanel::parse_status("## No commits yet on main\0?? a\0");
        assert_eq!(st["branch"], json!("main"));
        assert_eq!(st["changes"][0]["label"], json!("새 파일"));
        assert_eq!(st["changes"][0]["staged"], json!(false));
        // REST 응답 → 화면용
        assert_eq!(
            GitPanel::pr_from_rest(&json!({"number": 5, "title": "t", "draft": true, "head": {"ref": "b"}, "html_url": "u", "user": {"login": "x"}, "updated_at": "d"})),
            json!({"number": 5, "title": "t", "isDraft": true, "headRefName": "b", "url": "u", "author": "x", "updatedAt": "d"})
        );
    }
}
