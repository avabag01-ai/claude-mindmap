// 검사용: index() 결과를 JSON 으로 찍는다 (JS 와 모양 비교).
// 실행: cargo run --example index_dump -- <claudeDir> <linksFile> <foldersFile> <nowMs>
use claude_mindmap_lib::session_indexer::{Options, SessionIndexer};
use std::sync::Arc;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let now: f64 = a[4].parse().unwrap();
    let mut ix = SessionIndexer::new(Options {
        claude_dir: Some(a[1].clone().into()),
        links_file: Some(a[2].clone().into()),
        folders_file: Some(a[3].clone().into()),
        now: Some(Arc::new(move || now)),
        ..Default::default()
    });
    let mut idx = ix.index().unwrap();
    claude_mindmap_lib::session_indexer::attach_git_real(&mut idx);
    println!("{}", serde_json::to_string_pretty(&idx).unwrap());
}
