// 패리티 확인용: 요청 JSON 을 받아 claude_runner 로 실행하고 이벤트·종료를 한 줄씩 찍는다.
// 실행: cargo run --example run_claude -- '{"cwd":"/tmp","text":"hi"}'   (MINDMAP_CLAUDE_BIN 으로 가짜 claude)
use claude_mindmap_lib::claude_runner::{run, RunRequest};
use serde_json::json;
use std::sync::mpsc;

fn main() {
    let raw = std::env::args().nth(1).expect("요청 JSON 이 필요해요");
    let req: RunRequest = serde_json::from_str(&raw).expect("요청 JSON 이 틀렸어요");
    let (tx, rx) = mpsc::channel();
    run(&req, |e| println!("{}", json!({ "event": e })), move |x| tx.send(x).unwrap()).expect("실행 실패");
    let exit = rx.recv().unwrap();
    println!("{}", json!({ "exit": exit }));
}
