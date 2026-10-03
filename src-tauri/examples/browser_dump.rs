// 패리티 확인용: 같은 호출을 차례로 해서 가짜 osascript 가 받은 스크립트를 FAKE_OSA_LOG 에 남긴다.
use claude_mindmap_lib::browser_bridge::BrowserBridge;
fn main() {
    let fake = format!("{}/../scripts/fake-osascript.js", env!("CARGO_MANIFEST_DIR"));
    for name in ["chrome", "safari"] {
        let b = BrowserBridge::new(Some(name), Some(&fake)).unwrap();
        let _ = b.tabs();
        let _ = b.open("ex.com/a?q=\"x\"", true);
        let _ = b.open("https://ex.com", false);
        let _ = b.activate(2, 3);
        let _ = b.search("맥미니 램", "naver");
        let _ = b.eval("1+1");
        let _ = b.read(None, None);
        let _ = b.read(Some(500), Some(5));
        let _ = b.click("로그인 \"a\"");
        let _ = b.type_text("#q", "안녕 \"세상\"\n줄", true);
        let _ = b.type_text("#q", "x", false);
        let _ = b.navigate("reload");
    }
}
