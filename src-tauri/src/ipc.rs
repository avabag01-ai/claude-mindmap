//! IPC 공통: 답 보내기. Tauri 없이도 테스트할 수 있게 emit 을 함수로 받는다.
//! Electron 의 event.reply(ch, data) / event.sender.send(ch, data) 둘 다 ctx.emit(ch, data) 로 옮긴다.

use serde_json::Value;
use std::sync::Arc;

pub type EmitFn = Arc<dyn Fn(&str, Value) + Send + Sync>;

#[derive(Clone)]
pub struct Ctx {
    emit: EmitFn,
}

impl Ctx {
    pub fn new(emit: EmitFn) -> Self {
        Ctx { emit }
    }
    pub fn emit(&self, channel: &str, data: Value) {
        (self.emit)(channel, data)
    }
}
