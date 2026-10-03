// 핸들러 하나를 불러 답을 JSON 한 줄씩 찍는다: cargo run --example dispatch_dump -- <channel> '<payload json>'
use claude_mindmap_lib::{handlers, ipc::Ctx};
use std::sync::Arc;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let payload = serde_json::from_str(a.get(2).map(String::as_str).unwrap_or("null")).unwrap();
    let ctx = Ctx::new(Arc::new(|ch: &str, d: serde_json::Value| println!("{}", serde_json::json!({ "channel": ch, "data": d }))));
    handlers::dispatch(&ctx, &a[1], payload);
}
