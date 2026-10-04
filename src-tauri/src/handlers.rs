//! main.js 의 ipcMain.on(...) 을 옮긴 곳. 채널 이름·답 모양은 main.js 와 같다 (화면은 그대로).
//! Electron 의 event.reply(ch, data) = ctx.emit(ch, data).

use crate::git_panel::GitPanel;
use crate::ipc::Ctx;
use crate::machine_sync::MachineSync;
use crate::memo_store::MemoStore;
use crate::session_indexer::{self as si, MetaPatch, SessionIndexer};
use crate::usage_meter::UsageMeter;
use crate::{app_dir, approvals, browser_bridge, claude_app, claude_runner, login_path};
use once_cell::sync::Lazy;
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

static INDEXER: Lazy<Mutex<SessionIndexer>> = Lazy::new(|| Mutex::new(SessionIndexer::new(si::Options::default())));
static SYNC: Lazy<MachineSync> = Lazy::new(|| MachineSync::new(Default::default()));
static MEMOS: Lazy<MemoStore> = Lazy::new(MemoStore::system);
static GIT: Lazy<GitPanel> = Lazy::new(GitPanel::new);
static USAGE: Lazy<UsageMeter> = Lazy::new(|| UsageMeter::new(Default::default()));

/// 이 앱 저장소 폴더 (브라우저 MCP 스크립트 자리). MINDMAP_DIR → 빌드한 곳
fn app_root() -> PathBuf {
    match std::env::var("MINDMAP_DIR") {
        Ok(d) if !d.is_empty() => PathBuf::from(d),
        _ => Path::new(env!("CARGO_MANIFEST_DIR")).parent().unwrap_or(Path::new("/")).to_path_buf(),
    }
}

/// { ...a, ...b } (객체만)
fn spread(a: Value, b: Value) -> Value {
    let mut m = match a {
        Value::Object(m) => m,
        _ => Map::new(),
    };
    if let Value::Object(b) = b {
        for (k, v) in b {
            m.insert(k, v);
        }
    }
    Value::Object(m)
}

fn s<'a>(p: &'a Value, k: &str) -> Option<&'a str> {
    p.get(k).and_then(Value::as_str)
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub fn dispatch(ctx: &Ctx, channel: &str, p: Value) {
    match channel {
        // --- 세션 ---
        "sessions:index" => {
            let r = build_session_index().unwrap_or_else(|e| json!({ "success": false, "error": e.to_string() }));
            ctx.emit("sessions:index-result", r);
        }
        "sessions:transcript" => {
            let file = s(&p, "file").unwrap_or("").to_string();
            let since = p.get("sinceMtime").and_then(Value::as_f64).unwrap_or(0.0);
            let r = (|| -> anyhow::Result<Value> {
                let projects = INDEXER.lock().unwrap().claude_dir.join("projects");
                let resolved = std::fs::canonicalize(&file).unwrap_or_else(|_| PathBuf::from(&file));
                let projects = std::fs::canonicalize(&projects).unwrap_or(projects);
                if file.is_empty() || !resolved.starts_with(&projects) {
                    anyhow::bail!("세션 기록 파일이 아니에요");
                }
                if since > 0.0 && mtime_ms(&resolved) == since {
                    return Ok(json!({ "file": file, "unchanged": true }));
                }
                Ok(spread(json!({ "file": file }), serde_json::to_value(si::read_transcript(&resolved.to_string_lossy(), None)?)?))
            })()
            .unwrap_or_else(|e| json!({ "file": file, "error": e.to_string() }));
            ctx.emit("sessions:transcript-result", r);
        }
        "sessions:hub" => {
            let root = s(&p, "root").unwrap_or("").to_string();
            let topic = s(&p, "topic").map(str::to_string);
            let r = (|| -> anyhow::Result<Value> {
                if !INDEXER.lock().unwrap().has_root(&root) {
                    anyhow::bail!("세션 목록에 없는 폴더예요");
                }
                Ok(serde_json::to_value(si::read_hub(&root, topic.as_deref())?)?)
            })()
            .unwrap_or_else(|e| {
                let nf = e.to_string().starts_with("ENOENT") || e.downcast_ref::<std::io::Error>().map(|io| io.kind() == std::io::ErrorKind::NotFound).unwrap_or(false);
                let msg = if nf { "이 폴더에는 툰 허브(.toon/HUB.toon)가 없어요".to_string() } else { e.to_string() };
                json!({ "root": root, "topic": topic, "error": msg })
            });
            ctx.emit("sessions:hub-result", r);
        }
        "sessions:link" => {
            let r = INDEXER.lock().unwrap().set_parent(s(&p, "root").unwrap_or(""), s(&p, "id").unwrap_or(""), s(&p, "parentId"));
            ctx.emit("sessions:changed", match r {
                Ok(v) => spread(json!({ "ok": true, "action": if s(&p, "parentId").is_some() { "link" } else { "unlink" } }), v),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            });
        }
        "sessions:meta" => {
            let r = serde_json::from_value::<MetaPatch>(p.clone())
                .map_err(anyhow::Error::from)
                .and_then(|m| INDEXER.lock().unwrap().set_meta(s(&p, "root").unwrap_or(""), s(&p, "id").unwrap_or(""), &m));
            ctx.emit("sessions:changed", match r {
                Ok(v) => spread(json!({ "ok": true, "action": "meta", "quiet": true }), v),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            });
        }
        "sessions:copy" | "sessions:move" => {
            let is_move = channel == "sessions:move";
            let (root, id, to) = (s(&p, "root").unwrap_or(""), s(&p, "id").unwrap_or(""), s(&p, "toRoot").unwrap_or(""));
            let r = (|| -> anyhow::Result<Value> {
                let mut ix = INDEXER.lock().unwrap();
                if !ix.has_root(to) {
                    anyhow::bail!(if is_move { "세션 목록에 없는 폴더로는 옮기지 않아요" } else { "세션 목록에 없는 폴더로는 복사하지 않아요" });
                }
                let done = if is_move { ix.move_session(root, id, to)? } else { ix.copy_session(root, id, to)? };
                let new_id = done.get("id").and_then(Value::as_str).unwrap_or("").to_string();
                let mut linked = Value::Null;
                if let Some(parent) = s(&p, "parentId") {
                    ix.remember_session(to, &new_id); // 바로 붙일 수 있게 임시 등록
                    linked = ix.set_parent(to, &new_id, Some(parent))?.get("parentId").cloned().unwrap_or(Value::Null);
                }
                let action = if is_move { "move" } else { "copy" };
                Ok(spread(spread(json!({ "ok": true, "action": action }), done), json!({ "parentId": linked })))
            })()
            .unwrap_or_else(|e| json!({ "ok": false, "error": e.to_string() }));
            ctx.emit("sessions:changed", r);
        }
        "sessions:trash" => {
            let r = INDEXER.lock().unwrap().trash_session(s(&p, "root").unwrap_or(""), s(&p, "id").unwrap_or(""));
            ctx.emit("sessions:changed", match r {
                Ok(v) => spread(json!({ "ok": true, "action": "trash" }), v),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            });
        }
        "sessions:rename" => {
            let r = INDEXER.lock().unwrap().rename_session(s(&p, "root").unwrap_or(""), s(&p, "id").unwrap_or(""), s(&p, "title").unwrap_or(""));
            ctx.emit("sessions:changed", match r {
                Ok(v) => spread(json!({ "ok": true, "action": "rename" }), v),
                Err(e) => json!({ "ok": false, "error": e.to_string() }),
            });
        }
        "sessions:send" => {
            let run_id = s(&p, "runId").unwrap_or("").to_string();
            let req: Result<claude_runner::RunRequest, _> = serde_json::from_value(p.clone());
            let (c1, c2, r1, r2) = (ctx.clone(), ctx.clone(), run_id.clone(), run_id.clone());
            let started = req.map_err(anyhow::Error::from).and_then(|mut req| {
                // 물을 도구는 막지 않고 화면에 묻는다 (클로드 앱처럼)
                req.approve_script = Some(app_root().join("scripts").join("mindmap-approve-mcp.js").to_string_lossy().into_owned());
                // 클로드 앱에도 보이게: 새 세션은 첫 session_id 가 오는 순간, 답이 끝날 때마다 한 번 더 (claude://resume)
                let shown = std::sync::Arc::new(Mutex::new(req.session_id.clone().filter(|s| !s.is_empty())));
                let (sh1, sh2) = (shown.clone(), shown.clone());
                claude_runner::run(
                    &req,
                    move |ev| {
                        if let Some(id) = ev["session_id"].as_str() {
                            let mut cur = sh1.lock().unwrap();
                            if cur.is_none() {
                                *cur = Some(id.to_string());
                                claude_app::show_in_app(id);
                            }
                        }
                        c1.emit("sessions:run-event", json!({ "runId": r1, "event": ev }))
                    },
                    move |x| {
                        if let Some(id) = sh2.lock().unwrap().clone() {
                            claude_app::show_in_app(&id);
                        }
                        c2.emit("sessions:run-exit", spread(json!({ "runId": r2 }), x))
                    },
                )
            });
            if let Err(e) = started {
                ctx.emit("sessions:run-exit", json!({ "runId": run_id, "code": null, "stopped": false, "error": e.to_string() }));
            }
        }
        // --- 코드 보기: 세션 목록에 있는 폴더 안 글자 파일만 ---
        "read-file" => {
            let path = s(&p, "path").unwrap_or("").to_string();
            let roots: Vec<String> = INDEXER.lock().unwrap().last_roots.iter().cloned().collect();
            ctx.emit("read-file-result", read_code_file(&path, &roots).unwrap_or_else(|e| json!({ "path": path, "error": e.to_string() })));
        }
        // --- 허용 묻기 (scripts/mindmap-approve-mcp.js) ---
        "approval:list" => ctx.emit("approval:list-result", json!({ "items": approvals::list_in(&approvals::dir()) })),
        "approval:answer" => {
            let r = approvals::answer_in(
                &approvals::dir(),
                s(&p, "id").unwrap_or(""),
                p.get("allow").and_then(Value::as_bool).unwrap_or(false),
                p.get("always").and_then(Value::as_bool).unwrap_or(false),
            );
            ctx.emit("approval:answer-result", r.unwrap_or_else(|e| json!({ "error": e.to_string() })));
        }
        "sessions:stop" => {
            claude_runner::stop(s(&p, "runId").unwrap_or(""));
        }
        "sessions:pick-folder" => {
            let mut path = pick_folder();
            if let Some(dir) = path.clone() {
                match INDEXER.lock().unwrap().add_folder(&dir) {
                    Ok(root) => path = Some(root),
                    Err(e) => eprintln!("add folder: {e}"),
                }
            }
            ctx.emit("sessions:pick-folder-result", json!({ "path": path }));
        }

        // --- 파인더 (폴더 목록만) ---
        "fs:list" => ctx.emit("fs:list-result", fs_list(s(&p, "dir"), p.get("showHidden").and_then(Value::as_bool).unwrap_or(false))),

        // --- 메모 ---
        "memos:list" | "memos:save" | "memos:delete" => {
            let r = match channel {
                "memos:save" => MEMOS.save(&p).map(|v| json!({ "saved": v })),
                "memos:delete" => MEMOS.remove(s(&p, "id").unwrap_or("")).map(|v| json!({ "deleted": v })),
                _ => Ok(json!({})),
            };
            let out = match r {
                Ok(v) => spread(spread(json!({ "ok": true }), v), MEMOS.list()),
                Err(e) => spread(json!({ "ok": false, "error": e.to_string() }), MEMOS.list()),
            };
            ctx.emit("memos:result", out);
        }
        "memos:reveal" => {
            let id = s(&p, "id").unwrap_or("");
            let purpose = p.get("purpose").cloned().unwrap_or(Value::Null);
            ctx.emit("memos:reveal-result", match MEMOS.reveal(id) {
                Ok(v) => spread(json!({ "ok": true, "purpose": purpose }), v),
                Err(e) => json!({ "ok": false, "id": id, "purpose": purpose, "error": e.to_string() }),
            });
        }

        // --- GitHub 탭 ---
        "git:info" => git_reply(ctx, "git:info-result", json!({ "cwd": p.get("cwd") }), GIT.info(s(&p, "cwd").unwrap_or(""))),
        "git:diff" => git_reply(ctx, "git:diff-result", json!({ "root": p.get("root"), "file": p.get("file") }), GIT.diff(s(&p, "root").unwrap_or(""), s(&p, "file"))),
        "git:action" => git_reply(ctx, "git:action-result", json!({ "root": p.get("root"), "action": p.get("action") }), GIT.action(s(&p, "root").unwrap_or(""), &p)),
        "gh:list" => git_reply(ctx, "gh:list-result", json!({ "root": p.get("root"), "what": p.get("what") }), GIT.gh_list(s(&p, "root").unwrap_or(""), s(&p, "what").unwrap_or(""))),
        "gh:repos" => git_reply(ctx, "gh:repos-result", json!({}), crate::github_map::repos(&GIT, &p["roots"].as_array().into_iter().flatten().filter_map(|v| v.as_str().map(str::to_string)).collect::<Vec<_>>())),
        "gh:repo-detail" => git_reply(ctx, "gh:repo-detail-result", json!({ "slug": p.get("slug") }), crate::github_map::detail(&GIT, s(&p, "slug").unwrap_or(""))),
        "claude-app:new" => {
            let ok = claude_app::new_in_app(s(&p, "folder").unwrap_or(""), s(&p, "prompt").unwrap_or(""));
            ctx.emit("claude-app:new-result", json!({ "ok": ok }));
        }
        "open-external" => {
            if let Some(url) = s(&p, "url").filter(|u| u.starts_with("http://") || u.starts_with("https://")) {
                let _ = std::process::Command::new("/usr/bin/open").arg(url).spawn();
            }
        }

        // --- 사용량 ---
        "usage:read" => ctx.emit("usage:result", USAGE.read()),

        // --- 브라우저 ---
        "browser:get" => {
            let mcp = run_quiet("claude", &["mcp", "get", "mindmap-browser"]).0 == 0;
            ctx.emit("browser:settings", spread(read_browser_settings(), json!({ "mcp": mcp, "platform": "darwin" })));
        }
        "browser:set" => {
            let cur = read_browser_settings();
            let browser = s(&p, "browser").filter(|b| browser_bridge::browser_by_name(b).is_some()).or(s(&cur, "browser")).unwrap_or("chrome").to_string();
            let engine = match s(&p, "engine") {
                Some("naver") => "naver",
                Some("google") => "google",
                _ => s(&cur, "engine").unwrap_or("google"),
            }
            .to_string();
            let settings = json!({ "browser": browser, "engine": engine });
            let f = app_dir::settings_file("browser.json");
            if let Some(d) = f.parent() {
                let _ = std::fs::create_dir_all(d);
            }
            let _ = std::fs::write(&f, serde_json::to_string_pretty(&settings).unwrap_or_default());
            ctx.emit("browser:settings", spread(settings, json!({ "saved": true })));
        }
        "browser:do" => {
            let op = s(&p, "op").unwrap_or("").to_string();
            let args = p.get("args").cloned().unwrap_or(json!({}));
            let settings = read_browser_settings();
            let r = (|| -> anyhow::Result<Value> {
                let b = browser_bridge::BrowserBridge::new(s(&settings, "browser"), None)?;
                Ok(match op.as_str() {
                    "tabs" => serde_json::to_value(b.tabs()?)?,
                    "open" => b.open(s(&args, "url").unwrap_or(""), args.get("newTab").and_then(Value::as_bool) != Some(false))?,
                    "search" => b.search(s(&args, "query").unwrap_or(""), s(&args, "engine").or(s(&settings, "engine")).unwrap_or("google"))?,
                    "activate" => b.activate(args.get("window").and_then(Value::as_i64).unwrap_or(0), args.get("tab").and_then(Value::as_i64).unwrap_or(0))?,
                    "read" => b.read(Some(20000), None)?,
                    "navigate" => b.navigate(s(&args, "action").unwrap_or(""))?,
                    _ => anyhow::bail!("모르는 작업이에요"),
                })
            })();
            ctx.emit("browser:result", match r {
                Ok(data) => json!({ "ok": true, "op": op, "data": data }),
                Err(e) => json!({ "ok": false, "op": op, "error": e.to_string() }),
            });
        }
        "browser:register" => {
            let script = app_root().join("scripts").join("mindmap-browser-mcp.js").to_string_lossy().into_owned();
            let node = login_path::resolve("node");
            let _ = run_quiet("claude", &["mcp", "remove", "--scope", "user", "mindmap-browser"]);
            let _ = run_quiet("claude", &["mcp", "remove", "--scope", "user", "flowcode-browser"]); // 예전 이름
            let (code, out) = if node.contains('/') {
                run_quiet("claude", &["mcp", "add", "--scope", "user", "mindmap-browser", "--", &node, &script])
            } else {
                (1, "node 를 찾지 못했어요".to_string())
            };
            ctx.emit("browser:register-result", if code == 0 {
                json!({ "ok": true, "out": out })
            } else {
                json!({ "ok": false, "error": if code == 127 { "claude 를 찾지 못했어요".to_string() } else { out } })
            });
        }
        _ => eprintln!("모르는 채널: {channel}"),
    }
}

/// main.js buildSessionIndex: index → attachGit → publish → readOthers → merge (공유 폴더 오류여도 목록은 보임)
fn build_session_index() -> anyhow::Result<Value> {
    let mut ix = INDEXER.lock().unwrap().index()?;
    si::attach_git_real(&mut ix);
    let mut index = serde_json::to_value(ix)?;
    let machine = SYNC.name();
    if let Value::Object(m) = &mut index {
        m.insert("machine".into(), json!(machine));
    }
    let _ = SYNC.publish(&index);
    let others = SYNC.read_others();
    let merged = MachineSync::merge(&index, &others, now_ms());
    // 클로드 앱 사이드바 구조(그룹·제목·보관) — 왼쪽 목록 "클로드 앱" 보기용, 읽기만
    Ok(spread(merged, json!({ "machine": machine, "syncDir": SYNC.dir(), "claudeApp": claude_app::read() })))
}

const CODE_MAX: u64 = 512 * 1024;

/// 코드 보기: 세션 폴더 안 파일만, 글자 파일만, 512KB 까지
fn read_code_file(path: &str, roots: &[String]) -> anyhow::Result<Value> {
    use std::io::Read;
    let real = std::fs::canonicalize(path).map_err(|_| anyhow::anyhow!("파일이 없어요 (지워졌거나 옮겨졌어요)"))?;
    let inside = roots.iter().any(|r| std::fs::canonicalize(r).map(|r| real.starts_with(&r)).unwrap_or(false));
    if !inside {
        anyhow::bail!("세션 폴더 밖 파일은 열지 않아요");
    }
    let meta = std::fs::metadata(&real)?;
    if !meta.is_file() {
        anyhow::bail!("파일이 아니에요");
    }
    let mut buf = Vec::new();
    std::fs::File::open(&real)?.take(CODE_MAX).read_to_end(&mut buf)?;
    if buf.contains(&0) {
        anyhow::bail!("글자 파일이 아니에요");
    }
    Ok(json!({ "path": path, "text": String::from_utf8_lossy(&buf), "size": meta.len(), "truncated": meta.len() > CODE_MAX }))
}

fn git_reply(ctx: &Ctx, channel: &str, base: Value, r: anyhow::Result<Value>) {
    ctx.emit(channel, match r {
        Ok(v) => spread(spread(json!({ "ok": true }), base), v),
        Err(e) => spread(spread(json!({ "ok": false }), base), json!({ "error": e.to_string() })),
    });
}

fn read_browser_settings() -> Value {
    let base = json!({ "browser": "chrome", "engine": "google" });
    match std::fs::read_to_string(app_dir::settings_file("browser.json")).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()) {
        Some(v) => spread(base, v),
        None => base,
    }
}

/// 로그인 PATH 로 실행, 30초 제한. (코드, stdout+stderr), 못 띄우면 127
fn run_quiet(bin: &str, args: &[&str]) -> (i32, String) {
    use std::process::Stdio;
    let child = match login_path::command(bin).args(args).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::piped()).spawn() {
        Ok(c) => c,
        Err(_) => return (127, String::new()),
    };
    let pid = child.id();
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let _ = tx.send(child.wait_with_output());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(30)) {
        Ok(Ok(o)) => {
            let out = format!("{}{}", String::from_utf8_lossy(&o.stdout), String::from_utf8_lossy(&o.stderr)).trim().to_string();
            (o.status.code().unwrap_or(1), out)
        }
        Ok(Err(_)) => (127, String::new()),
        Err(_) => {
            let _ = std::process::Command::new("/bin/kill").arg(pid.to_string()).status();
            (1, "시간이 너무 걸려요".into())
        }
    }
}

/// 폴더 고르기 (취소 = None)
fn pick_folder() -> Option<String> {
    let out = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", "POSIX path of (choose folder with prompt \"폴더 고르기 (새 폴더도 만들 수 있어요)\")"])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let p = String::from_utf8_lossy(&out.stdout).trim().trim_end_matches('/').to_string();
    if p.is_empty() {
        None
    } else {
        Some(p)
    }
}

fn mtime_ms(p: &Path) -> f64 {
    std::fs::metadata(p)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|d| d.as_secs_f64() * 1000.0)
        .unwrap_or(0.0)
}

fn fs_list(dir: Option<&str>, show_hidden: bool) -> Value {
    let home = app_dir::home().to_string_lossy().into_owned();
    let target = PathBuf::from(dir.filter(|d| !d.is_empty()).unwrap_or(&home));
    let target_s = target.to_string_lossy().into_owned();
    let rd = match std::fs::read_dir(&target) {
        Ok(r) => r,
        Err(e) => {
            let msg = if e.kind() == std::io::ErrorKind::PermissionDenied { "이 폴더를 열 권한이 없어요".to_string() } else { e.to_string() };
            return json!({ "dir": target_s, "home": home, "error": msg });
        }
    };
    let mut items: Vec<Value> = rd
        .filter_map(Result::ok)
        .filter(|d| show_hidden || !d.file_name().to_string_lossy().starts_with('.'))
        .take(3000)
        .map(|d| {
            let full = d.path();
            let st = std::fs::metadata(&full).ok();
            let is_dir = st.as_ref().map(|m| m.is_dir()).unwrap_or_else(|| d.file_type().map(|t| t.is_dir()).unwrap_or(false));
            json!({
                "name": d.file_name().to_string_lossy(),
                "path": full.to_string_lossy(),
                "isDir": is_dir,
                "size": st.as_ref().map(|m| m.len()).unwrap_or(0),
                "mtime": mtime_ms(&full),
            })
        })
        .collect();
    items.sort_by(|a, b| {
        let (ad, bd) = (a["isDir"].as_bool().unwrap_or(false), b["isDir"].as_bool().unwrap_or(false));
        bd.cmp(&ad).then_with(|| a["name"].as_str().unwrap_or("").cmp(b["name"].as_str().unwrap_or("")))
    });
    let parent = target.parent().map(|p| p.to_string_lossy().into_owned());
    json!({ "dir": target_s, "parent": parent, "home": home, "entries": items })
}
