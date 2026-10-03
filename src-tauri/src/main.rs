// 릴리스에서 맥 터미널 창을 따로 띄우지 않는다
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    claude_mindmap_lib::run()
}
