//! src/core/UsageMeter.js 를 옮긴 것.
//! Claude 구독 사용량(지금 세션 5시간 한도, 주간 한도)을 읽는다.
//! - Claude Code 의 /usage 와 같은 곳: GET https://api.anthropic.com/api/oauth/usage (공개 문서 없음, 바뀔 수 있음)
//! - 로그인 정보는 Claude Code 가 저장한 것을 읽기만 한다: 맥은 키체인 "Claude Code-credentials", 그 밖은 ~/.claude/.credentials.json
//!   토큰은 api.anthropic.com 에만 보낸다 (curl 설정을 stdin 으로 넘겨서 argv 에 안 남김). 만료됐어도 새로 받지 않는다.
//! - MINDMAP_USAGE_FILE 에 JSON 파일을 주면 그걸 읽는다 (테스트·미리보기).

use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::time::{Duration, Instant};

pub const ENDPOINT: &str = "https://api.anthropic.com/api/oauth/usage";

/// HTTP 응답 (상태 코드 + 본문)
pub struct HttpResp {
    pub status: u16,
    pub body: String,
}

type KeychainFn = Arc<dyn Fn() -> Option<String> + Send + Sync>;
/// 토큰을 받아 ENDPOINT 를 GET. 네트워크 오류는 Err(메시지)
type HttpGetFn = Arc<dyn Fn(&str) -> Result<HttpResp, String> + Send + Sync>;
type NowFn = Arc<dyn Fn() -> i64 + Send + Sync>;

#[derive(Default)]
pub struct UsageMeterOptions {
    pub http_get: Option<HttpGetFn>,
    pub read_keychain: Option<KeychainFn>,
    pub cred_file: Option<PathBuf>,
    pub file: Option<PathBuf>,
    /// "darwin" 이면 키체인부터 본다
    pub platform: Option<String>,
    pub now: Option<NowFn>,
}

pub struct UsageMeter {
    http_get: HttpGetFn,
    read_keychain: KeychainFn,
    cred_file: PathBuf,
    file: Option<PathBuf>,
    platform: String,
    now: NowFn,
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

/// JS 숫자처럼: 정수면 정수로
fn num(f: f64) -> Value {
    if f.fract() == 0.0 && f.abs() < 9e15 {
        json!(f as i64)
    } else {
        serde_json::Number::from_f64(f).map(Value::Number).unwrap_or(Value::Null)
    }
}

/// 키체인에서 Claude Code 로그인 JSON 읽기 (5초 제한)
pub fn keychain_token_json() -> Option<String> {
    let mut child = Command::new("/usr/bin/security")
        .args(["find-generic-password", "-s", "Claude Code-credentials", "-w"])
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .ok()?;
    let mut out = child.stdout.take()?;
    let reader = std::thread::spawn(move || {
        let mut s = String::new();
        out.read_to_string(&mut s).ok();
        s
    });
    let start = Instant::now();
    loop {
        match child.try_wait() {
            Ok(Some(st)) => {
                let s = reader.join().ok()?;
                return st.success().then(|| s.trim().to_string());
            }
            Ok(None) if start.elapsed() < Duration::from_secs(5) => std::thread::sleep(Duration::from_millis(20)),
            _ => {
                child.kill().ok();
                child.wait().ok();
                return None;
            }
        }
    }
}

/// curl 로 GET. 토큰은 stdin 의 설정(-K -)으로만 넘긴다.
pub fn curl_get(token: &str) -> Result<HttpResp, String> {
    let esc = |s: &str| s.replace('\\', "\\\\").replace('"', "\\\"");
    let cfg = format!(
        "url = \"{ENDPOINT}\"\nheader = \"Authorization: Bearer {}\"\nheader = \"anthropic-beta: oauth-2025-04-20\"\nheader = \"Content-Type: application/json\"\n",
        esc(token)
    );
    let mut child = Command::new("/usr/bin/curl")
        .args(["-sS", "--max-time", "15", "-w", "\n%{http_code}", "-K", "-"])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| e.to_string())?;
    child.stdin.take().unwrap().write_all(cfg.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        let e = String::from_utf8_lossy(&out.stderr);
        let e = e.trim().trim_start_matches("curl: ");
        return Err(if e.is_empty() { "fetch failed".into() } else { e.to_string() });
    }
    let s = String::from_utf8_lossy(&out.stdout);
    let (body, code) = s.rsplit_once('\n').ok_or("fetch failed")?;
    Ok(HttpResp { status: code.trim().parse().map_err(|_| "fetch failed".to_string())?, body: body.to_string() })
}

impl UsageMeter {
    pub fn new(o: UsageMeterOptions) -> Self {
        UsageMeter {
            http_get: o.http_get.unwrap_or_else(|| Arc::new(curl_get)),
            read_keychain: o.read_keychain.unwrap_or_else(|| Arc::new(keychain_token_json)),
            cred_file: o.cred_file.unwrap_or_else(|| crate::app_dir::home().join(".claude").join(".credentials.json")),
            file: o.file.or_else(|| std::env::var("MINDMAP_USAGE_FILE").ok().filter(|s| !s.is_empty()).map(PathBuf::from)),
            platform: o.platform.unwrap_or_else(|| if cfg!(target_os = "macos") { "darwin".into() } else { std::env::consts::OS.into() }),
            now: o.now.unwrap_or_else(|| Arc::new(now_ms)),
        }
    }

    fn token(&self) -> Result<String, &'static str> {
        let mut raw = None;
        if self.platform == "darwin" {
            raw = (self.read_keychain)().filter(|s| !s.is_empty());
        }
        if raw.is_none() {
            raw = std::fs::read_to_string(&self.cred_file).ok().filter(|s| !s.is_empty());
        }
        let Some(raw) = raw else {
            return Err("Claude Code 로그인 정보를 찾지 못했어요 (터미널에서 claude 로 한 번 로그인)");
        };
        let Ok(d) = serde_json::from_str::<Value>(&raw) else {
            return Err("Claude Code 로그인 정보를 읽지 못했어요");
        };
        let o = match d.get("claudeAiOauth") {
            Some(v) if !v.is_null() => v,
            _ => &d,
        };
        let token = match o.get("accessToken") {
            Some(Value::String(s)) if !s.is_empty() => s.clone(),
            _ => return Err("Claude 구독 로그인이 아니에요 (API 키로 쓰는 중이면 한도가 없어요)"),
        };
        if let Some(exp) = o.get("expiresAt").and_then(Value::as_f64) {
            if exp != 0.0 && exp < (self.now)() as f64 {
                return Err("로그인이 만료됐어요. Claude Code 를 한 번 쓰면 다시 보여요");
            }
        }
        Ok(token)
    }

    /// 지금 사용량. 결과 JSON 은 JS 와 같다: { ok, at, session, week, weekOpus } 또는 { ok:false, error, at }
    pub fn read(&self) -> Value {
        let at = (self.now)();
        if let Some(f) = &self.file {
            return match std::fs::read_to_string(f).map_err(|e| e.to_string()).and_then(|s| serde_json::from_str::<Value>(&s).map_err(|e| e.to_string())) {
                Ok(d) => Self::parse(&d, at),
                Err(e) => json!({ "ok": false, "error": format!("사용량 파일을 읽지 못했어요: {e}"), "at": at }),
            };
        }
        let token = match self.token() {
            Ok(t) => t,
            Err(e) => return json!({ "ok": false, "error": e, "at": at }),
        };
        let res = match (self.http_get)(&token) {
            Ok(r) => r,
            Err(e) => return json!({ "ok": false, "error": format!("사용량을 가져오지 못했어요: {e}"), "at": at }),
        };
        if res.status == 401 {
            return json!({ "ok": false, "error": "로그인이 만료됐어요. Claude Code 를 한 번 쓰면 다시 보여요", "at": at });
        }
        if !(200..300).contains(&res.status) {
            return json!({ "ok": false, "error": format!("사용량을 가져오지 못했어요 (HTTP {})", res.status), "at": at });
        }
        match serde_json::from_str::<Value>(&res.body) {
            Ok(d) => Self::parse(&d, at),
            Err(e) => json!({ "ok": false, "error": format!("사용량을 가져오지 못했어요: {e}"), "at": at }),
        }
    }

    /// 응답 → 화면용. utilization 은 쓴 비율(0~100). 남은 비율 = 100 - 쓴 비율.
    /// Bar = { used, left, resetsAt }
    pub fn parse(d: &Value, now: i64) -> Value {
        let now = if now == 0 { now_ms() } else { now };
        let bar = |x: Option<&Value>| -> Value {
            let Some(u) = x.and_then(|x| x.get("utilization")).and_then(Value::as_f64) else {
                return Value::Null;
            };
            let used = u.clamp(0.0, 100.0);
            let resets = x.and_then(|x| x.get("resets_at")).and_then(Value::as_str).and_then(parse_date);
            json!({ "used": num(used), "left": num(((100.0 - used) * 10.0).round() / 10.0), "resetsAt": resets })
        };
        let session = bar(d.get("five_hour"));
        let week = bar(d.get("seven_day"));
        let week_opus = bar(d.get("seven_day_opus"));
        if session.is_null() && week.is_null() {
            return json!({ "ok": false, "error": "사용량 형식을 알아보지 못했어요 (Claude 쪽이 바뀌었을 수 있어요)", "at": now });
        }
        json!({ "ok": true, "at": now, "session": session, "week": week, "weekOpus": week_opus })
    }
}

/// ISO 8601 → 밀리초 (Date.parse 처럼). 못 읽으면 None (0 도 JS 에선 null 이 됨)
fn parse_date(s: &str) -> Option<i64> {
    let s = s.trim();
    let b = s.as_bytes();
    let n = |a: usize, z: usize| -> Option<i64> { s.get(a..z)?.parse::<i64>().ok() };
    if b.len() < 10 || b[4] != b'-' || b[7] != b'-' {
        return None;
    }
    let (y, mo, d) = (n(0, 4)?, n(5, 7)?, n(8, 10)?);
    let (mut h, mut mi, mut sec, mut ms) = (0, 0, 0, 0);
    let mut rest = &s[10..];
    let mut offset_min = 0i64;
    if !rest.is_empty() {
        if !(rest.starts_with('T') || rest.starts_with(' ')) || rest.len() < 6 {
            return None;
        }
        let t = &rest[1..];
        h = t.get(0..2)?.parse().ok()?;
        mi = t.get(3..5)?.parse().ok()?;
        rest = &t[5..];
        if let Some(r) = rest.strip_prefix(':') {
            sec = r.get(0..2)?.parse().ok()?;
            rest = &r[2..];
            if let Some(r) = rest.strip_prefix('.') {
                let digits: String = r.chars().take_while(|c| c.is_ascii_digit()).collect();
                if digits.is_empty() {
                    return None;
                }
                let three = format!("{:0<3}", &digits[..digits.len().min(3)]);
                ms = three.parse().ok()?;
                rest = &r[digits.len()..];
            }
        }
        if rest == "Z" || rest == "z" {
        } else if rest.len() == 6 && (rest.starts_with('+') || rest.starts_with('-')) && rest.as_bytes()[3] == b':' {
            let sign = if rest.starts_with('-') { -1 } else { 1 };
            offset_min = sign * (rest[1..3].parse::<i64>().ok()? * 60 + rest[4..6].parse::<i64>().ok()?);
        } else if !rest.is_empty() {
            return None;
        }
        // 오프셋 없는 시각은 JS 에선 지역 시간이지만 API 는 항상 오프셋을 줘서 UTC 로 본다
    }
    if !(1..=12).contains(&mo) || !(1..=31).contains(&d) || h > 24 || mi > 59 || sec > 59 {
        return None;
    }
    // 날짜 → 일수 (Howard Hinnant)
    let yy = if mo <= 2 { y - 1 } else { y };
    let era = yy.div_euclid(400);
    let yoe = yy - era * 400;
    let doy = (153 * (if mo > 2 { mo - 3 } else { mo + 9 }) + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146097 + doe - 719468;
    let t = ((days * 24 + h) * 60 + mi - offset_min) * 60 + sec;
    let v = t * 1000 + ms;
    (v != 0).then_some(v)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    const NOW: i64 = 1_791_043_200_000; // 2026-10-03T16:00:00Z
    fn body() -> Value {
        json!({ "five_hour": { "utilization": 37.5, "resets_at": "2026-10-03T19:00:00Z" }, "seven_day": { "utilization": 82, "resets_at": "2026-10-06T09:00:00Z" }, "seven_day_opus": null })
    }
    fn ok_get(seen: Arc<Mutex<Option<String>>>) -> HttpGetFn {
        Arc::new(move |t| {
            *seen.lock().unwrap() = Some(t.to_string());
            Ok(HttpResp { status: 200, body: body().to_string() })
        })
    }
    fn meter(platform: &str, http_get: HttpGetFn, cred: PathBuf) -> UsageMeter {
        UsageMeter::new(UsageMeterOptions { platform: Some(platform.into()), http_get: Some(http_get), now: Some(Arc::new(|| NOW)), cred_file: Some(cred), ..Default::default() })
    }
    fn err_of(v: &Value) -> String {
        assert_eq!(v["ok"], false);
        v["error"].as_str().unwrap().to_string()
    }

    #[test]
    fn date_parse() {
        assert_eq!(parse_date("2026-10-03T16:00:00Z"), Some(NOW));
        assert_eq!(parse_date("2026-10-03T16:00:00.123456+00:00"), Some(NOW + 123));
        assert_eq!(parse_date("2026-10-04T01:00:00+09:00"), Some(NOW));
        assert_eq!(parse_date("nope"), None);
    }

    #[test]
    fn parse_response() {
        let p = UsageMeter::parse(&body(), NOW);
        assert_eq!(p["session"], json!({ "used": 37.5, "left": 62.5, "resetsAt": 1_791_054_000_000i64 }));
        assert_eq!(p["week"]["left"], 18);
        assert_eq!(p["weekOpus"], Value::Null);
        assert_eq!(UsageMeter::parse(&json!({ "five_hour": { "utilization": 130 } }), NOW)["session"]["left"], 0, "100% 넘어도 0 에서 멈춘다");
        assert_eq!(UsageMeter::parse(&json!({ "nope": 1 }), NOW)["ok"], false, "모르는 형식");
    }

    #[test]
    fn keychain_then_file_and_errors() {
        let tmp = tempfile::tempdir().unwrap();
        let cred = tmp.path().join("cred.json");
        let seen = Arc::new(Mutex::new(None));
        // 키체인(맥) → 토큰
        let mac = UsageMeter::new(UsageMeterOptions {
            platform: Some("darwin".into()),
            http_get: Some(ok_get(seen.clone())),
            now: Some(Arc::new(|| NOW)),
            read_keychain: Some(Arc::new(|| Some(json!({ "claudeAiOauth": { "accessToken": "tok-1", "expiresAt": NOW + 1_000_000 } }).to_string()))),
            cred_file: Some(cred.clone()),
            ..Default::default()
        });
        let r = mac.read();
        assert_eq!(r["ok"], true);
        assert_eq!(r["week"]["left"], 18);
        assert_eq!(seen.lock().unwrap().as_deref(), Some("tok-1"));

        // 맥이 아니면 파일에서
        std::fs::write(&cred, json!({ "claudeAiOauth": { "accessToken": "tok-2", "expiresAt": NOW + 1_000_000 } }).to_string()).unwrap();
        meter("linux", ok_get(seen.clone()), cred.clone()).read();
        assert_eq!(seen.lock().unwrap().as_deref(), Some("tok-2"));

        // 오류: 정보 없음 / 만료 / API 키 / 401 / 네트워크
        assert!(err_of(&meter("linux", ok_get(seen.clone()), tmp.path().join("none")).read()).contains("찾지 못했어요"));
        std::fs::write(&cred, json!({ "claudeAiOauth": { "accessToken": "x", "expiresAt": NOW - 1 } }).to_string()).unwrap();
        assert!(err_of(&meter("linux", ok_get(seen.clone()), cred.clone()).read()).contains("만료"));
        std::fs::write(&cred, json!({ "apiKey": "sk" }).to_string()).unwrap();
        assert!(err_of(&meter("linux", ok_get(seen.clone()), cred.clone()).read()).contains("구독 로그인이 아니에요"));
        std::fs::write(&cred, json!({ "claudeAiOauth": { "accessToken": "x" } }).to_string()).unwrap();
        let r401: HttpGetFn = Arc::new(|_| Ok(HttpResp { status: 401, body: String::new() }));
        assert!(err_of(&meter("linux", r401, cred.clone()).read()).contains("만료"));
        let r500: HttpGetFn = Arc::new(|_| Ok(HttpResp { status: 500, body: String::new() }));
        assert!(err_of(&meter("linux", r500, cred.clone()).read()).contains("HTTP 500"));
        let off: HttpGetFn = Arc::new(|_| Err("offline".into()));
        assert!(err_of(&meter("linux", off, cred.clone()).read()).contains("offline"));
        std::fs::write(&cred, "not json").unwrap();
        assert!(err_of(&meter("linux", ok_get(seen), cred).read()).contains("읽지 못했어요"));
    }

    #[test]
    fn file_override() {
        let tmp = tempfile::tempdir().unwrap();
        let f = tmp.path().join("u.json");
        std::fs::write(&f, body().to_string()).unwrap();
        let m = UsageMeter::new(UsageMeterOptions { file: Some(f), now: Some(Arc::new(|| NOW)), ..Default::default() });
        assert_eq!(m.read()["session"]["left"], 62.5);
    }
}
