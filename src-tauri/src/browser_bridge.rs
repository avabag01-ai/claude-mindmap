//! src/core/BrowserBridge.js 를 옮긴 것.
//! 맥의 진짜 브라우저(크롬·사파리·Brave·Edge)를 애플스크립트로 조종한다.
//! 읽기·클릭·입력은 브라우저 안에서 자바스크립트를 실행하므로, 브라우저에서 한 번 켜 줘야 한다:
//!   크롬·Brave·Edge: 보기 > 개발자 정보 > Apple Events의 자바스크립트 허용
//!   사파리: 개발자용 > Apple Events의 JavaScript 허용
//! 모든 함수는 막힌다(동기). 핸들러에서 스레드로 부른다.

use crate::login_path;
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde::Serialize;
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::process::Stdio;
use std::time::{Duration, Instant};

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Browser {
    pub app: &'static str,
    pub family: &'static str,
}

pub const BROWSERS: [(&str, Browser); 4] = [
    ("chrome", Browser { app: "Google Chrome", family: "chrome" }),
    ("brave", Browser { app: "Brave Browser", family: "chrome" }),
    ("edge", Browser { app: "Microsoft Edge", family: "chrome" }),
    ("safari", Browser { app: "Safari", family: "safari" }),
];

pub fn browser_by_name(name: &str) -> Option<Browser> {
    BROWSERS.iter().find(|(n, _)| *n == name).map(|(_, b)| *b)
}

const US: char = '\u{1f}'; // 칸 나눔
const RS: char = '\u{1e}'; // 줄 나눔

#[derive(Debug, Clone, PartialEq, Serialize)]
pub struct Tab {
    pub window: i64,
    pub tab: i64,
    pub active: bool,
    pub title: String,
    pub url: String,
}

type Runner = Box<dyn Fn(&str) -> Result<String> + Send + Sync>;

pub struct BrowserBridge {
    pub name: String,
    pub b: Browser,
    osascript: String,
    run_script: Option<Runner>,
}

// 번호(data-mindmap-id) · CSS 선택자 · 보이는 글자 순서로 찾는다
pub const FIND: &str = r##"
function find(t) {
  if (/^\d+$/.test(t)) { var byId = document.querySelector('[data-mindmap-id="' + t + '"]'); if (byId) return byId; }
  try { var bySel = document.querySelector(t); if (bySel) return bySel; } catch (x) {}
  var all = document.querySelectorAll('a, button, input, textarea, select, [role=button], [role=link], label, summary');
  var low = t.toLowerCase();
  for (var i = 0; i < all.length; i++) {
    var s = (all[i].innerText || all[i].value || all[i].getAttribute('aria-label') || all[i].getAttribute('placeholder') || '').trim().toLowerCase();
    if (s && (s === low || s.indexOf(low) >= 0)) return all[i];
  }
  return null;
}"##;

static RE_JS_OFF: Lazy<Regex> = Lazy::new(|| {
    Regex::new(r"(?i)JavaScript.*Apple ?Events|Apple ?Events.*JavaScript|JavaScript through AppleScript is turned off|자바스크립트").unwrap()
});
static RE_AUTH: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)-1743|Not authorized|not allowed to send Apple events|권한").unwrap());
static RE_NOT_RUNNING: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)-600|isn.t running|application isn.t running").unwrap());
static RE_NO_WINDOW: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)-1728|Can.t get window").unwrap());
static RE_SCHEME: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)^(https?|file|about|chrome):").unwrap());
static RE_HOST: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[A-Za-z0-9_-]+(\.[A-Za-z0-9_-]+)+(:\d+)?(/.*)?$").unwrap());
static RE_LOCAL: Lazy<Regex> = Lazy::new(|| Regex::new(r"^localhost(:\d+)?(/.*)?$").unwrap());

/// JS 의 encodeURIComponent
pub fn encode_uri_component(s: &str) -> String {
    let mut out = String::new();
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{:02X}", b));
        }
    }
    out
}

/// JS 의 JSON.stringify(String(s))
fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

impl BrowserBridge {
    /// browser: chrome | brave | edge | safari (없으면 chrome). osascript: 실행 파일 (없으면 MINDMAP_OSASCRIPT, 그것도 없으면 osascript)
    pub fn new(browser: Option<&str>, osascript: Option<&str>) -> Result<Self> {
        let name = browser.unwrap_or("chrome");
        let b = browser_by_name(name).ok_or_else(|| anyhow!("모르는 브라우저예요: {name}"))?;
        let osascript = osascript
            .map(str::to_string)
            .or_else(|| std::env::var("MINDMAP_OSASCRIPT").ok().filter(|s| !s.is_empty()))
            .unwrap_or_else(|| "osascript".into());
        Ok(BrowserBridge { name: name.into(), b, osascript, run_script: None })
    }

    /// 애플스크립트 실행기를 바꾼다 (테스트용)
    pub fn with_runner(mut self, run: impl Fn(&str) -> Result<String> + Send + Sync + 'static) -> Self {
        self.run_script = Some(Box::new(run));
        self
    }

    pub fn set_browser(&mut self, name: &str) -> Result<()> {
        let b = browser_by_name(name).ok_or_else(|| anyhow!("모르는 브라우저예요: {name}"))?;
        self.name = name.into();
        self.b = b;
        Ok(())
    }

    fn run_script(&self, script: &str) -> Result<String> {
        match &self.run_script {
            Some(f) => f(script),
            None => self.osascript_run(script),
        }
    }

    fn osascript_run(&self, script: &str) -> Result<String> {
        if !cfg!(target_os = "macos") && self.osascript == "osascript" {
            return Err(anyhow!("브라우저 조종은 맥에서만 돼요"));
        }
        let mut cmd = login_path::command(&self.osascript);
        cmd.arg("-").stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::piped());
        let mut child = cmd.spawn().map_err(|e| anyhow!(Self::friendly_error(&e.to_string(), &self.b)))?;
        let mut stdin = child.stdin.take().unwrap();
        let script = script.to_string();
        std::thread::spawn(move || {
            let _ = stdin.write_all(script.as_bytes());
        });
        let mut so = child.stdout.take().unwrap();
        let mut se = child.stderr.take().unwrap();
        let h_out = std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = so.read_to_end(&mut v);
            v
        });
        let h_err = std::thread::spawn(move || {
            let mut v = Vec::new();
            let _ = se.read_to_end(&mut v);
            v
        });
        // 30초 넘으면 죽인다
        let deadline = Instant::now() + Duration::from_secs(30);
        let status = loop {
            match child.try_wait() {
                Ok(Some(s)) => break Ok(s),
                Ok(None) if Instant::now() >= deadline => {
                    let _ = child.kill();
                    let _ = child.wait();
                    break Err("Command failed: osascript - (시간 초과)".to_string());
                }
                Ok(None) => std::thread::sleep(Duration::from_millis(10)),
                Err(e) => break Err(e.to_string()),
            }
        };
        let stdout = String::from_utf8_lossy(&h_out.join().unwrap_or_default()).into_owned();
        let stderr = String::from_utf8_lossy(&h_err.join().unwrap_or_default()).into_owned();
        match status {
            Ok(s) if s.success() => Ok(stdout.strip_suffix('\n').unwrap_or(&stdout).to_string()),
            Ok(_) => {
                let msg = if stderr.is_empty() { "Command failed: osascript -".to_string() } else { stderr };
                Err(anyhow!(Self::friendly_error(&msg, &self.b)))
            }
            Err(m) => Err(anyhow!(Self::friendly_error(if stderr.is_empty() { &m } else { &stderr }, &self.b))),
        }
    }

    pub fn friendly_error(msg: &str, b: &Browser) -> String {
        if RE_JS_OFF.is_match(msg) {
            return if b.family == "safari" {
                "사파리에서 개발자용 메뉴 > \"Apple Events의 JavaScript 허용\"을 켜 주세요".to_string()
            } else {
                format!("{} 에서 보기 > 개발자 정보 > \"Apple Events의 자바스크립트 허용\"을 켜 주세요", b.app)
            };
        }
        if RE_AUTH.is_match(msg) {
            return format!("맥 설정 > 개인정보 보호 및 보안 > 자동화에서 클로드 마인드맵(Electron, 또는 터미널)가 {} 를 제어하도록 허용해 주세요", b.app);
        }
        if RE_NOT_RUNNING.is_match(msg) {
            return format!("{} 가 켜져 있지 않아요", b.app);
        }
        if RE_NO_WINDOW.is_match(msg) {
            return format!("{} 에 열린 창이 없어요", b.app);
        }
        msg.trim().split('\n').last().unwrap_or("").to_string()
    }

    /// 애플스크립트 문자열 리터럴
    pub fn q(s: &str) -> String {
        format!("\"{}\"", s.replace('\\', "\\\\").replace('"', "\\\""))
    }

    fn tell(&self, body: &str) -> String {
        format!("tell application {}\n{}\nend tell", Self::q(self.b.app), body)
    }

    // ---------------------------------------------------------------------
    // 탭
    // ---------------------------------------------------------------------
    pub fn tabs(&self) -> Result<Vec<Tab>> {
        let safari = self.b.family == "safari";
        let body = r#"
set US to (character id 31)
set RS to (character id 30)
set out to ""
set wi to 0
repeat with w in windows
  set wi to wi + 1
  try
    set act to __ACT__
    set ti to 0
    repeat with t in tabs of w
      set ti to ti + 1
      set out to out & wi & US & ti & US & (ti = act) & US & (__NAME__ of t) & US & (URL of t) & RS
    end repeat
  end try
end repeat
return out"#
            .replace("__ACT__", if safari { "index of current tab of w" } else { "active tab index of w" })
            .replace("__NAME__", if safari { "name" } else { "title" });
        let out = self.run_script(&self.tell(&body))?;
        Ok(Self::parse_tabs(&out))
    }

    pub fn parse_tabs(out: &str) -> Vec<Tab> {
        out.split(RS)
            .filter(|l| !l.trim().is_empty())
            .map(|l| {
                let mut p = l.split(US);
                let w = p.next().unwrap_or("");
                let t = p.next().unwrap_or("");
                let active = p.next().unwrap_or("");
                let title = p.next().unwrap_or("");
                let url = p.next().unwrap_or("");
                Tab {
                    window: w.trim().parse().unwrap_or(0),
                    tab: t.trim().parse().unwrap_or(0),
                    active: active == "true",
                    title: title.to_string(),
                    url: url.trim().to_string(),
                }
            })
            .collect()
    }

    pub fn open(&self, url: &str, new_tab: bool) -> Result<Value> {
        let url = Self::normalize_url(url)?;
        let q = Self::q(&url);
        let nt = if new_tab { "true" } else { "false" };
        let body = if self.b.family == "safari" {
            format!(
                "activate\nif (count of windows) = 0 then\n  make new document with properties {{URL:{q}}}\nelse if {nt} then\n  tell front window to set current tab to (make new tab with properties {{URL:{q}}})\nelse\n  set URL of current tab of front window to {q}\nend if"
            )
        } else {
            format!(
                "activate\nif (count of windows) = 0 then\n  make new window\n  set URL of active tab of front window to {q}\nelse if {nt} then\n  tell front window to make new tab with properties {{URL:{q}}}\nelse\n  set URL of active tab of front window to {q}\nend if"
            )
        };
        self.run_script(&self.tell(&body))?;
        Ok(json!({ "url": url }))
    }

    pub fn activate(&self, window_index: i64, tab_index: i64) -> Result<Value> {
        let (w, t) = (window_index, tab_index);
        let body = if self.b.family == "safari" {
            format!("activate\nset current tab of window {w} to tab {t} of window {w}\nset index of window {w} to 1")
        } else {
            format!("activate\nset active tab index of window {w} to {t}\nset index of window {w} to 1")
        };
        self.run_script(&self.tell(&body))?;
        Ok(json!({ "window": w, "tab": t }))
    }

    /// engine: google(기본) | naver
    pub fn search(&self, query: &str, engine: &str) -> Result<Value> {
        let u = if engine == "naver" {
            format!("https://search.naver.com/search.naver?query={}", encode_uri_component(query))
        } else {
            format!("https://www.google.com/search?q={}", encode_uri_component(query))
        };
        self.open(&u, true)
    }

    // ---------------------------------------------------------------------
    // 페이지 안에서 자바스크립트 (앞 창의 보이는 탭)
    // ---------------------------------------------------------------------
    pub fn eval(&self, js: &str) -> Result<String> {
        let q = Self::q(js);
        let body = if self.b.family == "safari" {
            format!("do JavaScript {q} in current tab of front window")
        } else {
            format!("execute active tab of front window javascript {q}")
        };
        self.run_script(&self.tell(&body))
    }

    fn eval_json(&self, js: &str) -> Result<Value> {
        let out = self.eval(&format!("JSON.stringify((function(){{ {js} }})())"))?;
        serde_json::from_str(&out).map_err(|_| anyhow!("페이지에서 결과를 받지 못했어요"))
    }

    /// 페이지 글과 누를 수 있는 것들(번호 붙여서). 기본 12000자 · 120개.
    pub fn read(&self, max_chars: Option<usize>, max_items: Option<usize>) -> Result<Value> {
        let (mc, mi) = (max_chars.unwrap_or(12000), max_items.unwrap_or(120));
        let js = r#"
var items = [], n = 0;
var els = document.querySelectorAll('a[href], button, input, textarea, select, [role=button], [role=link], [onclick], summary');
for (var i = 0; i < els.length && items.length < __MAXITEMS__; i++) {
  var e = els[i], r = e.getBoundingClientRect();
  if (!r.width || !r.height) continue;
  var st = getComputedStyle(e); if (st.visibility === 'hidden' || st.display === 'none') continue;
  n++; e.setAttribute('data-mindmap-id', String(n));
  var label = (e.innerText || e.value || e.getAttribute('aria-label') || e.getAttribute('placeholder') || e.getAttribute('title') || e.name || '').trim().replace(/\s+/g, ' ').slice(0, 80);
  items.push({ id: n, tag: e.tagName.toLowerCase(), type: e.type || undefined, text: label, href: e.href || undefined });
}
var text = (document.body ? document.body.innerText : '').replace(/\n{3,}/g, '\n\n');
return { title: document.title, url: location.href, text: text.slice(0, __MAXCHARS__), truncated: text.length > __MAXCHARS__, items: items };"#
            .replace("__MAXITEMS__", &mi.to_string())
            .replace("__MAXCHARS__", &mc.to_string());
        self.eval_json(&js)
    }

    /// target: read 의 번호, CSS 선택자, 또는 보이는 글자
    pub fn click(&self, target: &str) -> Result<Value> {
        let t = js_str(target);
        let js = format!(
            "{FIND}\nvar e = find({t});\nif (!e) return {{ ok: false, error: '누를 것을 찾지 못했어요: ' + {t} }};\ne.scrollIntoView({{ block: 'center' }}); e.focus && e.focus(); e.click();\nreturn {{ ok: true, clicked: (e.innerText || e.value || e.tagName).trim().slice(0, 80) }};"
        );
        self.eval_json(&js)
    }

    pub fn type_text(&self, target: &str, text: &str, submit: bool) -> Result<Value> {
        let t = js_str(target);
        let x = js_str(text);
        let sub = if submit { "true" } else { "false" };
        let js = format!(
            "{FIND}\nvar e = find({t});\nif (!e) return {{ ok: false, error: '입력할 곳을 찾지 못했어요: ' + {t} }};\ne.focus();\nvar proto = e.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;\nvar setter = Object.getOwnPropertyDescriptor(proto, 'value');\nif (e.isContentEditable) {{ e.innerText = {x}; }}\nelse if (setter && setter.set) {{ setter.set.call(e, {x}); }} else {{ e.value = {x}; }}\ne.dispatchEvent(new Event('input', {{ bubbles: true }})); e.dispatchEvent(new Event('change', {{ bubbles: true }}));\nif ({sub}) {{\n  if (e.form && e.form.requestSubmit) e.form.requestSubmit();\n  else e.dispatchEvent(new KeyboardEvent('keydown', {{ key: 'Enter', code: 'Enter', keyCode: 13, bubbles: true }}));\n}}\nreturn {{ ok: true }};"
        );
        self.eval_json(&js)
    }

    /// action: back | forward | reload
    pub fn navigate(&self, action: &str) -> Result<Value> {
        let js = match action {
            "back" => "history.back()",
            "forward" => "history.forward()",
            "reload" => "location.reload()",
            _ => return Err(anyhow!("back · forward · reload 중에 골라 주세요")),
        };
        self.eval(&format!("{js}; 'ok'"))?;
        Ok(json!({ "ok": true, "action": action }))
    }

    pub fn normalize_url(url: &str) -> Result<String> {
        let u = url.trim();
        if u.is_empty() {
            return Err(anyhow!("주소가 비었어요"));
        }
        if RE_SCHEME.is_match(u) {
            return Ok(u.to_string());
        }
        if RE_HOST.is_match(u) || RE_LOCAL.is_match(u) {
            return Ok(format!("https://{u}"));
        }
        Err(anyhow!("주소가 아니에요: {u}"))
    }

    /// 주소처럼 보이면 true (주소창: 주소면 열고 아니면 검색)
    pub fn looks_like_url(s: &str) -> bool {
        Self::normalize_url(s).is_ok()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fake() -> String {
        format!("{}/../scripts/fake-osascript.js", env!("CARGO_MANIFEST_DIR"))
    }

    #[test]
    fn urls_and_errors() {
        assert_eq!(BrowserBridge::normalize_url("github.com/avabag01-ai").unwrap(), "https://github.com/avabag01-ai");
        assert_eq!(BrowserBridge::normalize_url("localhost:3000/x").unwrap(), "https://localhost:3000/x");
        assert_eq!(BrowserBridge::normalize_url("http://a.b").unwrap(), "http://a.b");
        assert!(!BrowserBridge::looks_like_url("맥미니 램 업그레이드"));
        assert!(BrowserBridge::normalize_url("").unwrap_err().to_string().contains("비었어요"));
        assert!(BrowserBridge::new(Some("netscape"), None).err().unwrap().to_string().contains("모르는 브라우저"));
        assert_eq!(encode_uri_component("맥미니 램"), "%EB%A7%A5%EB%AF%B8%EB%8B%88%20%EB%9E%A8");
        let chrome = BROWSERS[0].1;
        let safari = BROWSERS[3].1;
        assert!(BrowserBridge::friendly_error("execution error: Executing JavaScript through AppleScript is turned off.", &chrome).contains("개발자 정보"));
        assert!(BrowserBridge::friendly_error("Not authorized to send Apple events to Safari. (-1743)", &safari).contains("자동화"));
        assert_eq!(BrowserBridge::friendly_error("a\nb\n", &chrome), "b");
    }

    // 가짜 osascript 로 전체 흐름 (환경 변수를 쓰므로 한 테스트 안에서 차례로)
    #[test]
    fn scripts_with_fake_osascript() {
        let log = std::env::temp_dir().join(format!("osa-rs-{}.log", std::process::id()));
        std::env::set_var("FAKE_OSA_LOG", &log);
        let last = || std::fs::read_to_string(&log).unwrap().split("\n=====\n").filter(|s| !s.is_empty()).last().unwrap().to_string();

        let chrome = BrowserBridge::new(Some("chrome"), Some(&fake())).unwrap();
        let tabs = chrome.tabs().unwrap();
        assert_eq!(tabs[1], Tab { window: 1, tab: 2, active: true, title: "검색: \"따옴표\"".into(), url: "https://www.google.com/search?q=x".into() });
        assert!(last().contains("tell application \"Google Chrome\"") && last().contains("active tab index of w"));
        chrome.open("https://ex.com/?q=\"a\"", true).unwrap();
        assert!(last().contains("make new tab with properties {URL:\"https://ex.com/?q=\\\"a\\\"\"}"), "따옴표 이스케이프");
        chrome.activate(2, 3).unwrap();
        assert!(last().contains("set active tab index of window 2 to 3"));
        chrome.search("맥미니 램", "naver").unwrap();
        assert!(last().contains("search.naver.com/search.naver?query=%EB%A7%A5"));

        let safari = BrowserBridge::new(Some("safari"), Some(&fake())).unwrap();
        safari.tabs().unwrap();
        let l = last();
        assert!(l.contains("tell application \"Safari\"") && l.contains("index of current tab of w") && l.contains("(name of t)"));
        safari.eval("1+1").unwrap();
        assert!(last().contains("do JavaScript \"1+1\" in current tab of front window"));

        let r = chrome.read(None, None).unwrap();
        assert_eq!(r["items"][0]["text"], "로그인");
        assert!(last().contains("execute active tab of front window javascript"));
        assert!(last().contains("data-mindmap-id"));
        assert_eq!(chrome.click("로그인").unwrap(), json!({ "ok": true, "clicked": "로그인" }));
        chrome.type_text("#q", "안녕 \"세상\"", true).unwrap();
        assert!(last().contains("requestSubmit"));
        chrome.navigate("back").unwrap();
        assert!(chrome.navigate("sideways").is_err());

        std::env::set_var("FAKE_OSA_FAIL", "Google Chrome got an error: Application isn’t running. (-600)");
        let e = BrowserBridge::new(None, Some(&fake())).unwrap().tabs().unwrap_err();
        assert!(e.to_string().contains("켜져 있지 않아요"), "{e}");
        std::env::remove_var("FAKE_OSA_FAIL");
        std::env::remove_var("FAKE_OSA_LOG");
        let _ = std::fs::remove_file(&log);
    }
}
