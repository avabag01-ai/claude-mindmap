//! main.js 의 ipcMain.on(...) 을 옮긴 곳 (2단계에서 채운다).
use crate::ipc::Ctx;
use serde_json::{json, Value};

pub fn dispatch(ctx: &Ctx, channel: &str, _payload: Value) {
    ctx.emit("ipc:unknown", json!({ "channel": channel }));
}
