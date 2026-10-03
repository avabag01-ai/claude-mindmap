//! src/core/ClaudeRunner.js 를 옮긴 것.
//! 세션 허브 대화창의 메시지를 claude CLI 로 실행한다.
//!   이어서:  claude -p --output-format stream-json --verbose --resume <id> "<메시지>"
//!   새 세션: claude -p --output-format stream-json --verbose "<메시지>"   (cwd = 고른 폴더)
//! - PATH 는 로그인 셸 것. MINDMAP_CLAUDE_BIN 으로 실행 파일을 바꿀 수 있다 (테스트용 가짜 claude).
//! - stdout 한 줄 = 이벤트 하나 (JSON 이 아니면 { type: 'stderr', text }).

use crate::login_path;
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::Read;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// 화면이 보낸 실행 요청 (키 이름은 JS 와 같다)
#[derive(Debug, Clone, Default, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct RunRequest {
    pub run_id: String,
    pub cwd: String,
    pub text: String,
    pub session_id: Option<String>,
    pub permission_mode: Option<String>,
    pub answer_mode: Option<String>,
}

/// 답 길이: --append-system-prompt 로 붙여서 사람이 쓴 메시지는 그대로 남는다.
pub fn answer_style(mode: &str) -> Option<&'static str> {
    match mode {
        "result" => Some("이번 답은 결과만 한두 줄로 쓴다. 과정·설명·다음 제안은 빼고, 사용자가 물으면 그때 말한다. 막힌 것이 있으면 그것만 한 줄로."),
        "summary" => Some("이번 답은 짧게 요약한다. 5줄 안쪽으로 결과와 꼭 알아야 할 것만, 쉬운 말로."),
        "detail" => Some("이번 답은 자세히 쓴다. 무엇을 왜 했는지, 무엇을 확인했는지, 남은 것은 무엇인지 쉬운 말로 충분히 설명한다."),
        _ => None,
    }
}

struct RunState {
    pid: u32,
    stopped: AtomicBool,
}

static RUNS: Lazy<Mutex<HashMap<String, Arc<RunState>>>> = Lazy::new(|| Mutex::new(HashMap::new()));

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
}

fn send_signal(pid: u32, sig: i32) {
    #[cfg(unix)]
    unsafe {
        kill(pid as i32, sig);
    }
    #[cfg(not(unix))]
    let _ = (pid, sig);
}

#[cfg(unix)]
fn signal_name(sig: i32) -> String {
    match sig {
        1 => "SIGHUP".into(),
        2 => "SIGINT".into(),
        3 => "SIGQUIT".into(),
        6 => "SIGABRT".into(),
        9 => "SIGKILL".into(),
        13 => "SIGPIPE".into(),
        14 => "SIGALRM".into(),
        15 => "SIGTERM".into(),
        n => format!("SIG{n}"),
    }
}

fn exit_payload(status: &std::io::Result<std::process::ExitStatus>, stopped: bool) -> Value {
    let (mut code, mut signal): (Option<i32>, Option<String>) = (None, None);
    if let Ok(s) = status {
        code = s.code();
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            signal = s.signal().map(signal_name);
        }
    }
    json!({ "code": code, "signal": signal, "stopped": stopped })
}

/// MINDMAP_CLAUDE_BIN 이 있으면 그것, 없으면 claude
pub fn default_bin() -> String {
    std::env::var("MINDMAP_CLAUDE_BIN").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "claude".into())
}

/// claude 실행. 입력이 틀리면 Err (JS 의 throw). 이벤트·종료는 콜백으로.
/// on_event: stream-json 이벤트, 또는 { type: "stderr", text }
/// on_exit:  { code, signal, stopped } (정확히 한 번)
pub fn run(
    req: &RunRequest,
    on_event: impl Fn(Value) + Send + Sync + 'static,
    on_exit: impl Fn(Value) + Send + Sync + 'static,
) -> Result<()> {
    run_with_bin(&default_bin(), req, on_event, on_exit)
}

pub fn run_with_bin(
    bin: &str,
    req: &RunRequest,
    on_event: impl Fn(Value) + Send + Sync + 'static,
    on_exit: impl Fn(Value) + Send + Sync + 'static,
) -> Result<()> {
    if req.text.trim().is_empty() {
        return Err(anyhow!("보낼 메시지가 비어 있어요"));
    }
    if req.cwd.is_empty() || !std::path::Path::new(&req.cwd).exists() {
        return Err(anyhow!("폴더가 없어요: {}", req.cwd));
    }

    let mut args: Vec<String> = ["-p", "--output-format", "stream-json", "--verbose"].iter().map(|s| s.to_string()).collect();
    if let Some(id) = req.session_id.as_deref().filter(|s| !s.is_empty()) {
        args.push("--resume".into());
        args.push(id.into());
    }
    if let Some(m) = req.permission_mode.as_deref() {
        if m == "acceptEdits" || m == "plan" {
            args.push("--permission-mode".into());
            args.push(m.into());
        }
    }
    if let Some(style) = req.answer_mode.as_deref().and_then(answer_style) {
        args.push("--append-system-prompt".into());
        args.push(style.into());
    }
    args.push(req.text.clone());

    let on_event: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(on_event);
    let on_exit: Arc<dyn Fn(Value) + Send + Sync> = Arc::new(on_exit);

    // 셸을 거치지 않고 바로 실행, PATH 는 로그인 셸 것
    let mut cmd = login_path::command(bin);
    cmd.args(&args).current_dir(&req.cwd).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped());
    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(err) => {
            let text = if err.kind() == std::io::ErrorKind::NotFound {
                format!("claude 를 찾지 못했어요 ({bin}). 터미널에서 which claude 로 위치를 확인하고 MINDMAP_CLAUDE_BIN 으로 알려 주세요.")
            } else {
                format!("실행 실패: {err}")
            };
            // JS 처럼 run() 이 돌아온 뒤에 알린다
            std::thread::spawn(move || {
                on_event(json!({ "type": "stderr", "text": text }));
                on_exit(json!({ "code": null, "signal": null, "stopped": false }));
            });
            return Ok(());
        }
    };

    let state = Arc::new(RunState { pid: child.id(), stopped: AtomicBool::new(false) });
    RUNS.lock().unwrap().insert(req.run_id.clone(), state.clone());
    let run_id = req.run_id.clone();
    let mut stdout = child.stdout.take().unwrap();
    let mut stderr = child.stderr.take().unwrap();

    std::thread::spawn(move || {
        let ev = on_event.clone();
        let h_out = std::thread::spawn(move || {
            let mut buf: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 65536];
            let emit = |line: &[u8]| {
                let line = String::from_utf8_lossy(line);
                let line = line.trim();
                if line.is_empty() {
                    return;
                }
                match serde_json::from_str::<Value>(line) {
                    Ok(v) => ev(v),
                    Err(_) => ev(json!({ "type": "stderr", "text": line })),
                }
            };
            loop {
                match stdout.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        buf.extend_from_slice(&chunk[..n]);
                        while let Some(i) = buf.iter().position(|&b| b == b'\n') {
                            let line: Vec<u8> = buf.drain(..=i).collect();
                            emit(&line);
                        }
                    }
                }
            }
            // 줄바꿈 없이 끝난 마지막 줄
            emit(&buf);
        });
        let ev = on_event.clone();
        let h_err = std::thread::spawn(move || {
            let mut pending: Vec<u8> = Vec::new();
            let mut chunk = [0u8; 65536];
            loop {
                match stderr.read(&mut chunk) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => {
                        pending.extend_from_slice(&chunk[..n]);
                        // 글자 중간에서 끊기면 다음 조각과 이어 붙인다
                        let keep = match std::str::from_utf8(&pending) {
                            Ok(_) => 0,
                            Err(e) if e.error_len().is_none() => pending.len() - e.valid_up_to(),
                            Err(_) => 0,
                        };
                        let cut = pending.len() - keep;
                        let text = String::from_utf8_lossy(&pending[..cut]).into_owned();
                        pending.drain(..cut);
                        if !text.is_empty() {
                            ev(json!({ "type": "stderr", "text": text }));
                        }
                    }
                }
            }
            if !pending.is_empty() {
                ev(json!({ "type": "stderr", "text": String::from_utf8_lossy(&pending).into_owned() }));
            }
        });
        let _ = h_out.join();
        let _ = h_err.join();
        let status = child.wait();
        {
            let mut runs = RUNS.lock().unwrap();
            if runs.get(&run_id).map_or(false, |s| Arc::ptr_eq(s, &state)) {
                runs.remove(&run_id);
            }
        }
        on_exit(exit_payload(&status, state.stopped.load(Ordering::SeqCst)));
    });
    Ok(())
}

/// 실행 멈추기: SIGINT, 3초 뒤에도 남아 있으면 SIGKILL. 멈출 게 없으면 false.
pub fn stop(run_id: &str) -> bool {
    let state = match RUNS.lock().unwrap().get(run_id) {
        Some(s) => s.clone(),
        None => return false,
    };
    state.stopped.store(true, Ordering::SeqCst);
    send_signal(state.pid, 2);
    let run_id = run_id.to_string();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_secs(3));
        let still = RUNS.lock().unwrap().get(&run_id).map_or(false, |s| Arc::ptr_eq(s, &state));
        if still {
            send_signal(state.pid, 9);
        }
    });
    true
}

/// 창이 닫힐 때 돌고 있는 claude 를 모두 멈춘다
pub fn stop_all() {
    let ids: Vec<String> = RUNS.lock().unwrap().keys().cloned().collect();
    for id in ids {
        stop(&id);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;

    fn fake() -> String {
        format!("{}/../scripts/fake-claude.js", env!("CARGO_MANIFEST_DIR"))
    }

    fn go(bin: &str, req: RunRequest) -> (Vec<Value>, Value) {
        let events = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let e2 = events.clone();
        run_with_bin(bin, &req, move |e| e2.lock().unwrap().push(e), move |x| tx.send(x).unwrap()).unwrap();
        let exit = rx.recv_timeout(Duration::from_secs(20)).unwrap();
        let ev = events.lock().unwrap().clone();
        (ev, exit)
    }

    fn req(id: &str, text: &str) -> RunRequest {
        RunRequest { run_id: id.into(), cwd: std::env::temp_dir().to_string_lossy().into(), text: text.into(), ..Default::default() }
    }

    fn init_args(ev: &[Value]) -> Vec<String> {
        let i = ev.iter().find(|e| e["subtype"] == "init").unwrap();
        i["args"].as_array().unwrap().iter().map(|v| v.as_str().unwrap().to_string()).collect()
    }

    fn base() -> Vec<String> {
        ["-p", "--output-format", "stream-json", "--verbose"].iter().map(|s| s.to_string()).collect()
    }

    #[test]
    fn resume_and_permission_and_stream() {
        let msg = "\"따옴표\" 와 $HOME 그리고 'it's'";
        let mut r = req("r1", msg);
        r.session_id = Some("abc-123".into());
        r.permission_mode = Some("acceptEdits".into());
        let (ev, exit) = go(&fake(), r);
        let mut want = base();
        want.extend(["--resume", "abc-123", "--permission-mode", "acceptEdits"].map(String::from));
        want.push(msg.into());
        assert_eq!(init_args(&ev), want);
        let init = ev.iter().find(|e| e["subtype"] == "init").unwrap();
        assert_eq!(init["cwd"].as_str().unwrap(), std::fs::canonicalize(std::env::temp_dir()).unwrap().to_str().unwrap());
        let a = ev.iter().find(|e| e["type"] == "assistant").unwrap();
        assert_eq!(a["message"]["content"][0]["text"], format!("받았어: {msg}"));
        assert!(ev.iter().any(|e| e["type"] == "result"), "줄바꿈 없이 끝난 마지막 줄도 이벤트");
        assert_eq!(exit["code"], 0);
        assert_eq!(exit["stopped"], false);
    }

    #[test]
    fn new_session_default_permission() {
        let mut r = req("r2", "안녕");
        r.permission_mode = Some("default".into());
        let (ev, _) = go(&fake(), r);
        let mut want = base();
        want.push("안녕".into());
        assert_eq!(init_args(&ev), want);
        assert_eq!(ev.iter().find(|e| e["type"] == "result").unwrap()["session_id"], "new-session-0001");
    }

    #[test]
    fn answer_mode() {
        let mut r = req("r4", "고쳐");
        r.session_id = Some("s".into());
        r.answer_mode = Some("result".into());
        let (ev, _) = go(&fake(), r);
        let mut want = base();
        want.extend(["--resume", "s", "--append-system-prompt"].map(String::from));
        want.push(answer_style("result").unwrap().into());
        want.push("고쳐".into());
        assert_eq!(init_args(&ev), want);
        let mut r = req("r5", "안녕");
        r.answer_mode = Some("loud".into());
        let (ev, _) = go(&fake(), r);
        assert!(!init_args(&ev).contains(&"--append-system-prompt".to_string()));
    }

    #[test]
    fn stop_run() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let (tx, rx) = mpsc::channel();
        let e2 = events.clone();
        run_with_bin(&fake(), &req("r3", "hang"), move |e| e2.lock().unwrap().push(e), move |x| tx.send(x).unwrap()).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(stop("r3"));
        let exit = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(exit["stopped"], true);
        assert!(!stop("r3"), "끝난 실행은 다시 멈출 게 없다");
    }

    #[test]
    fn missing_bin_exits_once() {
        let events = Arc::new(Mutex::new(Vec::new()));
        let n = Arc::new(Mutex::new(0));
        let (e2, n2) = (events.clone(), n.clone());
        run_with_bin("claude-does-not-exist", &req("m", "hi"), move |e| e2.lock().unwrap().push(e), move |_| *n2.lock().unwrap() += 1).unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(events.lock().unwrap().iter().any(|e| e["text"].as_str().unwrap_or("").contains("찾지 못했어요")));
        assert_eq!(*n.lock().unwrap(), 1);
    }

    #[test]
    fn bad_input() {
        let e = run_with_bin(&fake(), &req("x", "  "), |_| {}, |_| {}).unwrap_err();
        assert!(e.to_string().contains("비어"));
        let mut r = req("x", "hi");
        r.cwd = "/nope/nope".into();
        let e = run_with_bin(&fake(), &r, |_| {}, |_| {}).unwrap_err();
        assert!(e.to_string().contains("폴더가 없어요"));
    }
}
