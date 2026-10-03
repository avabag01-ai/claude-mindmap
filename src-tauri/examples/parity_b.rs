//! JS 와 출력 비교용: merge / publish / usage / usage-real
use claude_mindmap_lib::machine_sync::{MachineSync, MachineSyncOptions};
use claude_mindmap_lib::usage_meter::{UsageMeter, UsageMeterOptions};
use std::sync::Arc;

fn main() {
    let a: Vec<String> = std::env::args().collect();
    let rd = |p: &str| serde_json::from_str::<serde_json::Value>(&std::fs::read_to_string(p).unwrap()).unwrap();
    match a[1].as_str() {
        // merge <index> <others.json(배열)> <now>
        "merge" => {
            let others = rd(&a[3]);
            println!("{}", MachineSync::merge(&rd(&a[2]), others.as_array().unwrap(), a[4].parse().unwrap()));
        }
        // publish <index> <dir> <name> <now> → 쓴 파일 내용
        "publish" => {
            let now: i64 = a[5].parse().unwrap();
            let m = MachineSync::new(MachineSyncOptions { name: Some(a[4].clone()), dir: Some(Some(a[3].clone())), now: Some(Arc::new(move || now)), ..Default::default() });
            let r = m.publish(&rd(&a[2]));
            println!("{}", std::fs::read_to_string(r["file"].as_str().unwrap()).unwrap());
        }
        // usage <now>  (MINDMAP_USAGE_FILE 사용)
        "usage" => {
            let now: i64 = a[2].parse().unwrap();
            println!("{}", UsageMeter::new(UsageMeterOptions { now: Some(Arc::new(move || now)), ..Default::default() }).read());
        }
        // usage-real: 진짜 키체인 + 진짜 엔드포인트 (읽기만)
        _ => println!("{}", UsageMeter::new(Default::default()).read()),
    }
}
