//! 클로드 앱 화면을 따라 바꾸고, 앱 세션에 글을 보낸다. JS 쪽은 src/core/ClaudeApp.js (Electron 판은 바꾸기만).
//! - 바꾸기: claude://code/continue?session=local_<id> 를 연다. 클로드 앱은 -g 를 줘도 스스로 앞으로 나오니(10-04 실측)
//!   앞에 있던 앱(보통 마인드맵)을 다시 앞으로 돌린다.
//! - 보내기: 손쉬운 사용(AX). 앱에 AXManualAccessibility 를 켜면 웹 화면이 열린다.
//!   웹 영역 제목 "<세션 제목> - Claude Code" 로 그 세션이 보이는지 확인한 뒤에만,
//!   입력칸(AXTextArea '프롬프트')이 비어 있을 때만 글을 넣고 '보내기' 단추를 누른다.
//!   마인드맵에 손쉬운 사용 권한이 없으면 'no-permission' — 화면은 예전처럼 복사+앱 열기로 넘긴다.

use std::time::{Duration, Instant};

pub const BUNDLE_ID: &str = "com.anthropic.claudefordesktop";

/// 앱의 세션 id (local_…). 앱이 받는 모양과 같다: ^local_[A-Za-z0-9-]{1,64}$
pub fn valid_app_id(id: &str) -> bool {
    id.strip_prefix("local_").map_or(false, |r| (1..=64).contains(&r.len()) && r.chars().all(|c| c.is_ascii_alphanumeric() || c == '-'))
}

pub fn continue_url(app_id: &str) -> String {
    format!("claude://code/continue?session={app_id}")
}

/// 클로드 앱이 그 세션을 보여 줄 때의 웹 영역 제목
pub fn web_title(title: &str) -> String {
    format!("{title} - Claude Code")
}

/// 보내기가 멈춘 까닭 → 화면에 띄울 말
pub fn reason_text(reason: &str) -> &'static str {
    match reason {
        "typing" => "클로드 앱 입력칸에 쓰던 글이 있어서 보내지 않았어요",
        "busy" => "그 세션이 지금 일하는 중이라 보내지 않았어요",
        "not-shown" => "클로드 앱 화면을 그 세션으로 바꾸지 못했어요",
        "no-permission" => "마인드맵에 손쉬운 사용 권한이 없어요",
        "no-app" => "클로드 앱이 켜져 있지 않아요",
        "no-title" => "앱 세션 제목을 몰라서 확인할 수 없어요",
        "not-taken" => "입력칸이 글을 받지 않았어요",
        "not-sent" => "입력칸에 글은 넣었는데 보내기가 안 됐어요. 앱에서 Enter 를 눌러 주세요",
        _ => "보내지 못했어요",
    }
}

#[cfg(target_os = "macos")]
pub use mac::{focus, focus_back, send, shown_title};

#[cfg(not(target_os = "macos"))]
pub fn focus(_app_id: &str) -> bool {
    false
}
#[cfg(not(target_os = "macos"))]
pub fn send(_app_id: &str, _title: &str, _text: &str) -> Result<(), &'static str> {
    Err("no-app")
}
#[cfg(not(target_os = "macos"))]
pub fn shown_title() -> Option<String> {
    None
}

/// 기다리기: f 가 Some 을 주거나 시간이 다 될 때까지
fn wait_for<T>(limit: Duration, mut f: impl FnMut() -> Option<T>) -> Option<T> {
    let t0 = Instant::now();
    loop {
        if let Some(v) = f() {
            return Some(v);
        }
        if t0.elapsed() >= limit {
            return None;
        }
        std::thread::sleep(Duration::from_millis(60));
    }
}

#[cfg(target_os = "macos")]
mod mac {
    use super::*;
    use std::ffi::{c_char, c_void, CString};

    type CFTypeRef = *const c_void;
    type Id = *mut c_void;
    type Sel = *const c_void;
    const UTF8: u32 = 0x0800_0100;

    #[link(name = "ApplicationServices", kind = "framework")]
    extern "C" {
        fn AXIsProcessTrusted() -> u8;
        fn AXIsProcessTrustedWithOptions(options: CFTypeRef) -> u8;
        fn AXUIElementCreateApplication(pid: i32) -> CFTypeRef;
        fn AXUIElementCopyAttributeValue(e: CFTypeRef, attr: CFTypeRef, out: *mut CFTypeRef) -> i32;
        fn AXUIElementSetAttributeValue(e: CFTypeRef, attr: CFTypeRef, v: CFTypeRef) -> i32;
        fn AXUIElementPerformAction(e: CFTypeRef, action: CFTypeRef) -> i32;
        fn AXUIElementSetMessagingTimeout(e: CFTypeRef, secs: f32) -> i32;
        static kAXTrustedCheckOptionPrompt: CFTypeRef;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringCreateWithBytes(alloc: CFTypeRef, bytes: *const u8, len: isize, enc: u32, ext: u8) -> CFTypeRef;
        fn CFStringGetLength(s: CFTypeRef) -> isize;
        fn CFStringGetMaximumSizeForEncoding(len: isize, enc: u32) -> isize;
        fn CFStringGetCString(s: CFTypeRef, buf: *mut c_char, size: isize, enc: u32) -> u8;
        fn CFGetTypeID(v: CFTypeRef) -> usize;
        fn CFStringGetTypeID() -> usize;
        fn CFArrayGetTypeID() -> usize;
        fn CFBooleanGetTypeID() -> usize;
        fn CFBooleanGetValue(b: CFTypeRef) -> u8;
        fn CFArrayGetCount(a: CFTypeRef) -> isize;
        fn CFArrayGetValueAtIndex(a: CFTypeRef, i: isize) -> CFTypeRef;
        fn CFDictionaryCreate(alloc: CFTypeRef, keys: *const CFTypeRef, values: *const CFTypeRef, n: isize, kcb: *const c_void, vcb: *const c_void) -> CFTypeRef;
        fn CFRetain(v: CFTypeRef) -> CFTypeRef;
        fn CFRelease(v: CFTypeRef);
        static kCFBooleanTrue: CFTypeRef;
        static kCFTypeDictionaryKeyCallBacks: c_void;
        static kCFTypeDictionaryValueCallBacks: c_void;
    }

    #[link(name = "AppKit", kind = "framework")]
    extern "C" {}
    #[link(name = "objc")]
    extern "C" {
        fn objc_getClass(name: *const c_char) -> Id;
        fn sel_registerName(name: *const c_char) -> Sel;
        fn objc_msgSend();
    }

    /// 다 쓰면 놓는 CF 값
    struct Cf(CFTypeRef);
    impl Drop for Cf {
        fn drop(&mut self) {
            if !self.0.is_null() {
                unsafe { CFRelease(self.0) }
            }
        }
    }

    fn cfstr(s: &str) -> Cf {
        Cf(unsafe { CFStringCreateWithBytes(std::ptr::null(), s.as_ptr(), s.len() as isize, UTF8, 0) })
    }

    fn to_string(v: CFTypeRef) -> Option<String> {
        unsafe {
            if v.is_null() || CFGetTypeID(v) != CFStringGetTypeID() {
                return None;
            }
            let size = CFStringGetMaximumSizeForEncoding(CFStringGetLength(v), UTF8) + 1;
            let mut buf = vec![0 as c_char; size as usize];
            if CFStringGetCString(v, buf.as_mut_ptr(), size, UTF8) == 0 {
                return None;
            }
            Some(std::ffi::CStr::from_ptr(buf.as_ptr()).to_string_lossy().into_owned())
        }
    }

    fn get(e: &Cf, attr: &str) -> Option<Cf> {
        let mut out: CFTypeRef = std::ptr::null();
        let a = cfstr(attr);
        let r = unsafe { AXUIElementCopyAttributeValue(e.0, a.0, &mut out) };
        (r == 0 && !out.is_null()).then(|| Cf(out))
    }

    fn get_str(e: &Cf, attr: &str) -> String {
        get(e, attr).and_then(|v| to_string(v.0)).unwrap_or_default()
    }

    fn set(e: &Cf, attr: &str, v: CFTypeRef) -> bool {
        let a = cfstr(attr);
        unsafe { AXUIElementSetAttributeValue(e.0, a.0, v) == 0 }
    }

    fn press(e: &Cf) -> bool {
        let a = cfstr("AXPress");
        unsafe { AXUIElementPerformAction(e.0, a.0) == 0 }
    }

    fn children(e: &Cf) -> Vec<Cf> {
        let Some(arr) = get(e, "AXChildren") else { return vec![] };
        unsafe {
            if CFGetTypeID(arr.0) != CFArrayGetTypeID() {
                return vec![];
            }
            (0..CFArrayGetCount(arr.0)).map(|i| Cf(CFRetain(CFArrayGetValueAtIndex(arr.0, i)))).collect()
        }
    }

    /// 깊이 우선으로 처음 맞는 것 (웹 화면이 커져도 멈추지 않게 노드 수 제한)
    fn find(root: &Cf, pred: &dyn Fn(&Cf) -> bool) -> Option<Cf> {
        let mut stack = vec![(Cf(unsafe { CFRetain(root.0) }), 0usize)];
        let mut seen = 0;
        while let Some((e, d)) = stack.pop() {
            seen += 1;
            if seen > 20_000 {
                return None;
            }
            if pred(&e) {
                return Some(e);
            }
            if d < 80 {
                let mut kids = children(&e);
                kids.reverse();
                stack.extend(kids.into_iter().map(|k| (k, d + 1)));
            }
        }
        None
    }

    fn role_is(e: &Cf, role: &str) -> bool {
        get_str(e, "AXRole") == role
    }

    fn desc_in(e: &Cf, names: &[&str]) -> bool {
        let d = get_str(e, "AXDescription");
        names.iter().any(|n| *n == d)
    }

    // --- objc: 앞에 있는 앱 / 앱 앞으로 / 클로드 앱 pid ---
    unsafe fn cls(name: &str) -> Id {
        let c = CString::new(name).unwrap();
        objc_getClass(c.as_ptr())
    }
    unsafe fn sel(name: &str) -> Sel {
        let c = CString::new(name).unwrap();
        sel_registerName(c.as_ptr())
    }
    unsafe fn msg0(obj: Id, s: &str) -> Id {
        let f: extern "C" fn(Id, Sel) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
        if obj.is_null() { std::ptr::null_mut() } else { f(obj, sel(s)) }
    }

    fn pid_of(app: Id) -> i32 {
        if app.is_null() {
            return -1;
        }
        unsafe {
            let f: extern "C" fn(Id, Sel) -> i32 = std::mem::transmute(objc_msgSend as *const c_void);
            f(app, sel("processIdentifier"))
        }
    }

    /// 그 앱이 지금 앞에 있는지 (AX 로 읽는다 — NSWorkspace 값은 실행 고리가 없는 스레드에서 안 바뀐다, 10-04 실측)
    fn is_front(pid: i32) -> bool {
        let app = Cf(unsafe { AXUIElementCreateApplication(pid) });
        get(&app, "AXFrontmost").map_or(false, |v| unsafe { CFGetTypeID(v.0) == CFBooleanGetTypeID() && CFBooleanGetValue(v.0) != 0 })
    }

    /// 앞으로 돌리기: AX 로 그 앱의 AXFrontmost 를 켠다 (System Events 'set frontmost' 와 같은 길).
    /// macOS 14+ 는 NSRunningApplication.activate 를 뒤에 있는 앱이 부르면 무시한다 (10-04 실측)
    fn activate(pid: i32) {
        let app = Cf(unsafe { AXUIElementCreateApplication(pid) });
        if set(&app, "AXFrontmost", unsafe { kCFBooleanTrue }) {
            return;
        }
        unsafe {
            let by_pid: extern "C" fn(Id, Sel, i32) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
            let app = by_pid(cls("NSRunningApplication"), sel("runningApplicationWithProcessIdentifier:"), pid);
            if app.is_null() {
                return;
            }
            // NSApplicationActivateIgnoringOtherApps = 2
            let act: extern "C" fn(Id, Sel, usize) -> u8 = std::mem::transmute(objc_msgSend as *const c_void);
            act(app, sel("activateWithOptions:"), 2);
        }
    }

    fn claude_pid() -> Option<i32> {
        unsafe {
            let ns = cls("NSString");
            let from: extern "C" fn(Id, Sel, *const c_char) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
            let bid = CString::new(BUNDLE_ID).unwrap();
            let s = from(ns, sel("stringWithUTF8String:"), bid.as_ptr());
            let list: extern "C" fn(Id, Sel, Id) -> Id = std::mem::transmute(objc_msgSend as *const c_void);
            let apps = list(cls("NSRunningApplication"), sel("runningApplicationsWithBundleIdentifier:"), s);
            let pid = pid_of(msg0(apps, "firstObject"));
            (pid > 0).then_some(pid)
        }
    }

    fn trusted(prompt: bool) -> bool {
        unsafe {
            if AXIsProcessTrusted() != 0 {
                return true;
            }
            if prompt {
                // 시스템이 '손쉬운 사용' 설정으로 가는 창을 띄운다 (켜는 건 사용자가)
                let keys = [kAXTrustedCheckOptionPrompt];
                let vals = [kCFBooleanTrue];
                let d = Cf(CFDictionaryCreate(std::ptr::null(), keys.as_ptr(), vals.as_ptr(), 1, &kCFTypeDictionaryKeyCallBacks as *const _ as _, &kCFTypeDictionaryValueCallBacks as *const _ as _));
                AXIsProcessTrustedWithOptions(d.0);
            }
            false
        }
    }

    fn app_element(pid: i32) -> Cf {
        let app = Cf(unsafe { AXUIElementCreateApplication(pid) });
        unsafe { AXUIElementSetMessagingTimeout(app.0, 1.0) };
        set(&app, "AXManualAccessibility", unsafe { kCFBooleanTrue });
        app
    }

    fn web_area(app: &Cf, want: Option<&str>) -> Option<Cf> {
        find(app, &|e| {
            role_is(e, "AXWebArea") && {
                let t = get_str(e, "AXTitle");
                match want {
                    Some(w) => t == w,
                    None => t.ends_with(" - Claude Code"),
                }
            }
        })
    }

    /// 지금 클로드 앱이 보여 주는 세션 제목 (권한 없거나 앱이 없으면 None)
    pub fn shown_title() -> Option<String> {
        if !trusted(false) {
            return None;
        }
        let app = app_element(claude_pid()?);
        let t = get_str(&web_area(&app, None)?, "AXTitle");
        t.strip_suffix(" - Claude Code").map(str::to_string)
    }

    /// 링크를 열고, 클로드 앱이 앞으로 나오면 restore(없으면 앞에 있던 마인드맵)를 다시 앞으로
    fn open_continue(app_id: &str, restore: Option<i32>) -> bool {
        let me = std::process::id() as i32;
        let back = restore.or_else(|| is_front(me).then_some(me));
        let ok = std::process::Command::new("open").args(["-g", &continue_url(app_id)]).status().map_or(false, |s| s.success());
        if let (true, Some(back), Some(claude)) = (ok, back, claude_pid()) {
            // 클로드 앱이 앞으로 나오면 되돌리고, 잠깐 더 지켜본다 (창을 띄우며 한 번 더 앞으로 올 수 있음)
            let t0 = Instant::now();
            let mut came = false;
            while t0.elapsed() < Duration::from_millis(2500) {
                if is_front(claude) {
                    came = true;
                    activate(back);
                } else if came && t0.elapsed() > Duration::from_millis(1200) {
                    break;
                }
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        ok
    }

    /// 마인드맵에서 고른 앱 세션으로 클로드 앱 화면을 바꾼다. 이미 그 세션이면 링크를 열지 않는다
    pub fn focus(app_id: &str) -> bool {
        focus_back(app_id, None)
    }

    /// restore = 다시 앞으로 돌릴 앱 (없으면 마인드맵이 앞에 있었을 때만 마인드맵)
    pub fn focus_back(app_id: &str, restore: Option<i32>) -> bool {
        if !valid_app_id(app_id) {
            return false;
        }
        if let (Some(now), Some(t)) = (shown_title(), crate::claude_app::app_title(app_id)) {
            if now == t {
                return true;
            }
        }
        open_continue(app_id, restore)
    }

    /// 앱 세션에 글을 보낸다. Err = 멈춘 까닭 (reason_text)
    pub fn send(app_id: &str, title: &str, text: &str) -> Result<(), &'static str> {
        if !valid_app_id(app_id) {
            return Err("not-shown");
        }
        if title.trim().is_empty() {
            return Err("no-title");
        }
        if !trusted(true) {
            return Err("no-permission");
        }
        let pid = claude_pid().ok_or("no-app")?;
        let app = app_element(pid);
        let want = web_title(title);
        if web_area(&app, Some(&want)).is_none() {
            open_continue(app_id, None);
        }
        let web = wait_for(Duration::from_secs(5), || web_area(&app, Some(&want))).ok_or("not-shown")?;
        let input = wait_for(Duration::from_secs(2), || find(&web, &|e| role_is(e, "AXTextArea") && desc_in(e, &["프롬프트", "Prompt"]))).ok_or("not-shown")?;
        // 세션을 막 바꿨으면 입력칸 값이 따라 바뀔 틈을 준다
        std::thread::sleep(Duration::from_millis(300));
        if !get_str(&input, "AXValue").trim().is_empty() {
            return Err("typing");
        }
        let send_btn = || find(&web, &|e| role_is(e, "AXButton") && desc_in(e, &["보내기", "Send"]));
        if send_btn().is_none() {
            return Err("busy");
        }
        // 입력칸은 ProseMirror 편집기: 값 넣기는 받지만 읽는 값은 잠깐 뒤에 바뀐다 (10-04 실측). 줄바꿈 모양은 달라질 수 있어 공백은 빼고 비교
        let v = cfstr(text);
        set(&input, "AXValue", v.0);
        let flat = |t: &str| t.split_whitespace().collect::<String>();
        let want_flat = flat(text);
        wait_for(Duration::from_millis(1500), || (flat(&get_str(&input, "AXValue")) == want_flat).then_some(())).ok_or("not-taken")?;
        std::thread::sleep(Duration::from_millis(250));
        let btn = send_btn().ok_or("not-sent")?;
        if !press(&btn) {
            return Err("not-sent");
        }
        wait_for(Duration::from_secs(3), || get_str(&input, "AXValue").trim().is_empty().then_some(())).ok_or("not-sent")
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_and_links() {
        assert!(valid_app_id("local_2e91c399-dee8-4b64-a6ec-432227673d92"));
        assert!(!valid_app_id("local_"));
        assert!(!valid_app_id("2e91c399"));
        assert!(!valid_app_id("local_a&b"));
        assert!(!valid_app_id(&format!("local_{}", "a".repeat(65))));
        assert_eq!(continue_url("local_ab"), "claude://code/continue?session=local_ab");
        assert_eq!(web_title("시험"), "시험 - Claude Code");
        assert!(reason_text("typing").contains("쓰던 글"));
    }

    /// 진짜 클로드 앱에 보낸다: MM_AX_APP_ID=local_… MM_AX_TITLE=… MM_AX_TEXT=… cargo test --lib live_send -- --ignored --nocapture
    #[test]
    #[ignore]
    fn live_send() {
        let id = std::env::var("MM_AX_APP_ID").unwrap();
        let title = std::env::var("MM_AX_TITLE").unwrap_or_else(|_| crate::claude_app::app_title(&id).unwrap_or_default());
        let text = std::env::var("MM_AX_TEXT").unwrap();
        println!("before: {:?}", shown_title());
        println!("send: {:?}", send(&id, &title, &text));
        println!("after: {:?}", shown_title());
    }

    /// MM_AX_APP_ID=local_… MM_AX_RESTORE_PID=<마인드맵 pid> cargo test --lib live_focus -- --ignored --nocapture
    #[cfg(target_os = "macos")]
    #[test]
    #[ignore]
    fn live_focus() {
        let id = std::env::var("MM_AX_APP_ID").unwrap();
        let back = std::env::var("MM_AX_RESTORE_PID").ok().and_then(|p| p.parse().ok());
        println!("focus: {}", focus_back(&id, back));
        std::thread::sleep(Duration::from_secs(1));
        println!("shown: {:?}", shown_title());
    }
}
