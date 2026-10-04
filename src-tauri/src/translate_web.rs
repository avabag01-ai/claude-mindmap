//! 가운데 웹 화면(center_web.rs) 한국어 번역 — 크롬 번역이 쓰는 Google 번역(translate.googleapis.com, gtx)에 묻는다.
//! 1) 페이지에서 글 조각(텍스트 노드)을 모은다 — 코드 칸·커밋 번호·경로처럼 보이는 것은 뺀다 (COLLECT_JS)
//! 2) 이미 번역한 것은 기억(CACHE)에서 바로, 나머지는 묶음으로 나눠 동시에 Google 에 묻고 오는 대로 바꿔 넣는다
//! 3) "원문" 이면 바꿔 넣은 조각을 원래 글로 되돌린다
//! 진행은 화면에 center-web:translate { label, state: working|done|error, n, error? } 로 알린다.
//! 페이지에서 받는 것은 글 조각뿐이고, 바꿔 넣는 글은 JSON 으로 넣는다 (스크립트로 끼어들 수 없음).

use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{mpsc, Mutex};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager, Webview};

use crate::login_path;

static CACHE: Mutex<Option<HashMap<String, String>>> = Mutex::new(None);
/// 짧은 메뉴 낱말은 앞뒤 글이 없어 Google 이 엉뚱하게 옮긴다 (Feed → "밥을 먹이다"). GitHub 에서 흔한 것은 정해 둔 말로.
/// 여기 있는 글 조각은 Google 에 묻지 않는다 (정확히 같은 글자만).
const GLOSSARY: &[(&str, &str)] = &[
    ("Home", "홈"), ("Feed", "피드"), ("Dashboard", "대시보드"), ("Explore", "탐색"), ("Notifications", "알림"),
    ("Code", "코드"), ("Issues", "이슈"), ("Issue", "이슈"), ("Pull requests", "풀 리퀘스트"), ("Pull request", "풀 리퀘스트"),
    ("Actions", "액션"), ("Projects", "프로젝트"), ("Wiki", "위키"), ("Security", "보안"), ("Insights", "인사이트"),
    ("Settings", "설정"), ("Overview", "개요"), ("Repositories", "저장소"), ("Repository", "저장소"), ("Packages", "패키지"),
    ("Stars", "별표"), ("Star", "별표"), ("Starred", "별표함"), ("Unstar", "별표 빼기"), ("Fork", "포크"), ("Forks", "포크"),
    ("Watch", "지켜보기"), ("Unwatch", "그만 보기"), ("Watching", "지켜보는 중"),
    ("Commits", "커밋"), ("commits", "커밋"), ("Commit", "커밋"), ("Branches", "브랜치"), ("Branch", "브랜치"), ("branches", "브랜치"),
    ("Tags", "태그"), ("tags", "태그"), ("Releases", "릴리스"), ("Contributors", "기여자"), ("Languages", "언어"), ("About", "소개"),
    ("Readme", "README"), ("Activity", "활동"), ("Public", "공개"), ("Private", "비공개"), ("Open", "열림"), ("Closed", "닫힘"),
    ("Merged", "병합됨"), ("Draft", "초안"), ("Files changed", "바뀐 파일"), ("Conversation", "대화"), ("Checks", "검사"),
    ("Sign in", "로그인"), ("Sign up", "가입"), ("Sign out", "로그아웃"), ("Search", "검색"), ("Filters", "필터"),
    ("Top repositories", "자주 쓰는 저장소"), ("Recent activity", "최근 활동"), ("Go to file", "파일로 가기"), ("Add file", "파일 추가"),
    ("New", "새로 만들기"), ("New repository", "새 저장소"), ("New issue", "새 이슈"), ("Edit", "고치기"), ("Delete", "지우기"),
    ("Labels", "라벨"), ("Milestones", "마일스톤"), ("Assignees", "담당자"), ("Reviewers", "리뷰어"), ("Discussions", "토론"),
    ("Copilot", "Copilot"), ("Gists", "Gist"), ("Your profile", "내 프로필"), ("Your repositories", "내 저장소"),
];
const CHUNK_ITEMS: usize = 80;
const CHUNK_CHARS: usize = 3500;
const PARALLEL: usize = 4;

/// 글 조각 모으기. 코드·입력칸·영어 글자가 없는 것·식별자처럼 보이는 것(경로, 해시, 이름-이름)은 뺀다
const COLLECT_JS: &str = r#"(function(){
var SKIP='pre,code,kbd,samp,tt,textarea,input,select,script,style,noscript,svg,math,[contenteditable=true],[translate=no],.notranslate,.blob-code,.blob-code-inner,.react-code-text,.react-code-lines,.react-file-line,.highlight,.diff-table,.js-file-line,.commit-sha,.sha,.branch-name,relative-time,.mm-no-tr';
var st=window.__mmTr={nodes:[]}; var out=[], seen={};
var w=document.createTreeWalker(document.body,NodeFilter.SHOW_TEXT,{acceptNode:function(n){
  var t=n.nodeValue; if(!t||!/[A-Za-z]{2,}/.test(t)) return 2;
  var p=n.parentElement; if(!p||p.closest(SKIP)) return 2;
  var s=t.trim(); if(s.length>3000) return 2;
  if(/^[\w.\-\/@#:+~]+$/.test(s) && /[\/._@#:~]|[a-z]-[a-z]|\d/.test(s)) return 2;
  return 1;}});
var n; while((n=w.nextNode())){ st.nodes.push(n); var s=n.nodeValue.trim(); if(!seen[s]){seen[s]=1; out.push(s);} }
return out;})()"#;

fn apply_js(dict: &HashMap<String, String>) -> String {
    let d = serde_json::to_string(dict).unwrap_or_else(|_| "{}".into());
    format!(r#"(function(d){{var st=window.__mmTr; if(!st) return 0; var c=0;
st.nodes.forEach(function(n){{ if(n.__mmOrig!==undefined||!n.isConnected) return; var raw=n.nodeValue, t=raw.trim(), k=d[t];
  if(k&&k!==t){{ n.__mmOrig=raw; n.nodeValue=raw.replace(t,k); c++; }} }});
document.documentElement.setAttribute('data-mm-tr','ko'); return c;}})({d})"#)
}

const RESTORE_JS: &str = r#"(function(){var st=window.__mmTr, c=0; if(st) st.nodes.forEach(function(n){ if(n.__mmOrig!==undefined){ n.nodeValue=n.__mmOrig; delete n.__mmOrig; c++; } });
document.documentElement.removeAttribute('data-mm-tr'); return c;})()"#;

/// 기억의 첫 내용 = 정해 둔 말
pub fn glossary() -> HashMap<String, String> {
    GLOSSARY.iter().map(|(a, b)| (a.to_string(), b.to_string())).collect()
}

/// 웹 화면에서 스크립트를 돌리고 값(JSON) 받기
fn eval_value(v: &Webview, js: &str) -> Result<Value, String> {
    let (tx, rx) = mpsc::channel();
    v.eval_with_callback(js.to_string(), move |r| { let _ = tx.send(r); }).map_err(|e| e.to_string())?;
    let r = rx.recv_timeout(Duration::from_secs(20)).map_err(|_| "페이지에서 답이 없어요".to_string())?;
    serde_json::from_str(&r).map_err(|_| "페이지 답을 못 읽었어요".to_string())
}

/// 묶음 나누기: 개수·글자 수 한도
pub fn chunks(items: &[String]) -> Vec<Vec<String>> {
    let mut out: Vec<Vec<String>> = vec![];
    let mut cur: Vec<String> = vec![];
    let mut chars = 0;
    for s in items {
        if !cur.is_empty() && (cur.len() >= CHUNK_ITEMS || chars + s.len() > CHUNK_CHARS) {
            out.push(std::mem::take(&mut cur));
            chars = 0;
        }
        chars += s.len();
        cur.push(s.clone());
    }
    if !cur.is_empty() { out.push(cur); }
    out
}

/// Google 답 [[번역, 언어], …] 또는 [번역, …] → 번역들 (개수가 다르면 Err)
pub fn parse_google(body: &str, want: usize) -> Result<Vec<String>, String> {
    let v: Value = serde_json::from_str(body).map_err(|_| "번역 답을 못 읽었어요".to_string())?;
    let arr = match &v {
        Value::Array(a) => a.clone(),
        Value::String(_) => vec![v.clone()],
        _ => return Err("번역 답이 이상해요".into()),
    };
    // 한 개만 물으면 ["번역","en"] 처럼 올 수 있다
    let arr = if want == 1 && arr.len() == 2 && arr.iter().all(Value::is_string) { vec![arr[0].clone()] } else { arr };
    let out: Vec<String> = arr.iter().map(|x| match x {
        Value::Array(p) => p.first().and_then(Value::as_str).unwrap_or("").to_string(),
        Value::String(s) => s.clone(),
        _ => String::new(),
    }).collect();
    if out.len() != want { return Err(format!("번역 개수가 달라요 ({} / {want})", out.len())); }
    Ok(out)
}

fn google(items: &[String]) -> Result<Vec<String>, String> {
    let mut cmd = login_path::command("curl");
    cmd.args(["-sS", "--max-time", "20", "-X", "POST", "https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&tl=ko"]);
    for s in items { cmd.arg("--data-urlencode").arg(format!("q={s}")); }
    let out = cmd.output().map_err(|e| format!("curl: {e}"))?;
    if !out.status.success() { return Err(String::from_utf8_lossy(&out.stderr).trim().to_string()); }
    parse_google(&String::from_utf8_lossy(&out.stdout), items.len())
}

fn emit(app: &AppHandle, label: &str, state: &str, n: usize, error: Option<String>) {
    let _ = app.emit("center-web:translate", json!({ "label": label, "state": state, "n": n, "error": error }));
}

fn translate(app: &AppHandle, label: &str) -> Result<usize, String> {
    let v = app.get_webview(label).ok_or("웹 화면이 아직 없어요")?;
    let items: Vec<String> = serde_json::from_value(eval_value(&v, COLLECT_JS)?).unwrap_or_default();
    // 기억에 있는 것부터 바로
    let (known, todo): (HashMap<String, String>, Vec<String>) = {
        let mut g = CACHE.lock().unwrap_or_else(|e| e.into_inner());
        let c = g.get_or_insert_with(glossary);
        let known = items.iter().filter_map(|s| c.get(s).map(|k| (s.clone(), k.clone()))).collect();
        (known, items.iter().filter(|s| !c.contains_key(*s)).cloned().collect())
    };
    let mut done = 0;
    if !known.is_empty() { done += eval_value(&v, &apply_js(&known))?.as_u64().unwrap_or(0) as usize; }
    // 나머지: 묶음을 PARALLEL 개씩 동시에
    let (tx, rx) = mpsc::channel::<Result<HashMap<String, String>, String>>();
    let jobs = chunks(&todo);
    let total = jobs.len();
    let queue = std::sync::Arc::new(Mutex::new(jobs));
    for _ in 0..PARALLEL.min(total) {
        let (q, tx) = (queue.clone(), tx.clone());
        std::thread::spawn(move || loop {
            let Some(job) = q.lock().unwrap().pop() else { break };
            let r = google(&job).map(|ks| job.into_iter().zip(ks).collect::<HashMap<_, _>>());
            if tx.send(r).is_err() { break; }
        });
    }
    drop(tx);
    let mut last_err = None;
    for r in rx {
        match r {
            Ok(dict) => {
                CACHE.lock().unwrap_or_else(|e| e.into_inner()).get_or_insert_with(glossary).extend(dict.clone());
                done += eval_value(&v, &apply_js(&dict)).ok().and_then(|x| x.as_u64()).unwrap_or(0) as usize;
                emit(app, label, "working", done, None);
            }
            Err(e) => last_err = Some(e),
        }
    }
    match last_err {
        Some(e) if done == 0 => Err(e),
        _ => Ok(done),
    }
}

/// on = true 면 한국어로, false 면 원문으로. 바로 돌아오고 진행은 center-web:translate 로
#[tauri::command]
pub async fn web_translate(app: AppHandle, label: String, on: bool) -> Result<(), String> {
    if !["github", "web"].contains(&label.as_str()) { return Err(format!("모르는 웹 화면: {label}")); }
    std::thread::spawn(move || {
        if !on {
            let r = app.get_webview(&label).ok_or("웹 화면이 아직 없어요".to_string()).and_then(|v| eval_value(&v, RESTORE_JS));
            return match r { Ok(_) => emit(&app, &label, "off", 0, None), Err(e) => emit(&app, &label, "error", 0, Some(e)) };
        }
        emit(&app, &label, "working", 0, None);
        match translate(&app, &label) {
            Ok(n) => emit(&app, &label, "done", n, None),
            Err(e) => emit(&app, &label, "error", 0, Some(e)),
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn google_answers() {
        assert_eq!(parse_google(r#"[["풀 요청","en"],["파일로 이동","en"]]"#, 2).unwrap(), vec!["풀 요청", "파일로 이동"]);
        assert_eq!(parse_google(r#"["코드","en"]"#, 1).unwrap(), vec!["코드"]);
        assert_eq!(parse_google(r#"["코드"]"#, 1).unwrap(), vec!["코드"]);
        assert!(parse_google(r#"[["하나","en"]]"#, 2).is_err());
        assert!(parse_google("<html>", 1).is_err());
    }

    #[test]
    fn menu_words_fixed() {
        let g = glossary();
        assert_eq!(g["Feed"], "피드");
        assert_eq!(g["Home"], "홈");
        assert_eq!(g["Pull requests"], "풀 리퀘스트");
    }

    #[test]
    fn chunking() {
        let many: Vec<String> = (0..200).map(|i| format!("text {i}")).collect();
        let c = chunks(&many);
        assert_eq!(c.len(), 3);
        assert_eq!(c.iter().map(Vec::len).sum::<usize>(), 200);
        let long = vec!["a".repeat(3000), "b".repeat(3000)];
        assert_eq!(chunks(&long).len(), 2);
        assert!(chunks(&[]).is_empty());
    }

    #[test]
    fn apply_script_is_json() {
        let mut d = HashMap::new();
        d.insert("Code".to_string(), "코드 '\"</script>".to_string());
        let js = apply_js(&d);
        assert!(js.contains(r#""Code":"코드 '\"</script>""#));
    }
}
