//! JS GitPanel 과 같은 출력인지 비교용: parity <info|prs> <경로>
use claude_mindmap_lib::git_panel::GitPanel;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let gp = GitPanel::new();
    let r = match a[1].as_str() {
        "info" => gp.info(&a[2]),
        what => gp.gh_list(&a[2], what),
    };
    match r {
        Ok(v) => println!("{}", serde_json::to_string(&v).unwrap()),
        Err(e) => println!("{}", serde_json::json!({"error": e.to_string()})),
    }
}
