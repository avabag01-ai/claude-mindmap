//! src/core/MemoStore.js 를 옮긴 것. 세션 허브 메모 저장소 (~/.claude-mindmap/memos.json, 권한 600).
//! 종류: memo · code · secret. 비밀 메모 본문은 암호화해서 저장한다.
//!
//! Electron safeStorage(맥)와 같은 방식이라 예전 앱이 쓴 파일을 그대로 읽는다:
//! 키체인 비밀번호 -> PBKDF2-HMAC-SHA1(salt "saltysalt", 1003회, 16바이트) -> AES-128-CBC,
//! IV 는 공백(0x20) 16개, PKCS7, 암호문 앞에 "v10".
//! 키는 KeyProvider 로 받는다 (테스트는 가짜, 실제는 키체인에서 읽기만 하고 새로 만들지 않는다).

use crate::app_dir;
use aes::cipher::{block_padding::Pkcs7, BlockDecryptMut, BlockEncryptMut, KeyIvInit};
use anyhow::{anyhow, Result};
use base64::{engine::general_purpose::STANDARD as B64, Engine};
use once_cell::sync::OnceCell;
use serde_json::{json, Map, Value};
use std::path::PathBuf;
use std::sync::Arc;

type Enc = cbc::Encryptor<aes::Aes128>;
type Dec = cbc::Decryptor<aes::Aes128>;

/// 맥 키체인 항목 이름 (Electron 앱 이름 "클로드 마인드맵" 기준)
pub const KEYCHAIN_SERVICE: &str = "클로드 마인드맵 Safe Storage";
pub const KEYCHAIN_ACCOUNT: &str = "클로드 마인드맵 Key";

/// 암호 키의 바탕이 되는 비밀번호를 돌려준다 (없으면 None = 이 컴퓨터에서 암호화 못 함)
pub trait KeyProvider: Send + Sync {
    fn password(&self) -> Option<Vec<u8>>;
}

impl<F: Fn() -> Option<Vec<u8>> + Send + Sync> KeyProvider for F {
    fn password(&self) -> Option<Vec<u8>> {
        self()
    }
}

/// 진짜 키체인: security 명령으로 읽기만 한다 (없으면 None, 새로 만들지 않음). 결과는 기억해 둔다.
pub struct KeychainKey {
    cached: OnceCell<Option<Vec<u8>>>,
}

impl KeychainKey {
    pub fn new() -> Self {
        KeychainKey { cached: OnceCell::new() }
    }
}

impl Default for KeychainKey {
    fn default() -> Self {
        Self::new()
    }
}

impl KeyProvider for KeychainKey {
    fn password(&self) -> Option<Vec<u8>> {
        self.cached
            .get_or_init(|| {
                let out = std::process::Command::new("/usr/bin/security")
                    .args(["find-generic-password", "-w", "-s", KEYCHAIN_SERVICE, "-a", KEYCHAIN_ACCOUNT])
                    .stdin(std::process::Stdio::null())
                    .stderr(std::process::Stdio::null())
                    .output()
                    .ok()?;
                if !out.status.success() {
                    return None;
                }
                let mut v = out.stdout;
                while matches!(v.last(), Some(b'\n') | Some(b'\r')) {
                    v.pop();
                }
                if v.is_empty() {
                    None
                } else {
                    Some(v)
                }
            })
            .clone()
    }
}

fn derive_key(password: &[u8]) -> [u8; 16] {
    let mut key = [0u8; 16];
    pbkdf2::pbkdf2_hmac::<sha1::Sha1>(password, b"saltysalt", 1003, &mut key);
    key
}

/// "v10" + AES-128-CBC 암호문
pub fn encrypt_string(password: &[u8], text: &str) -> Vec<u8> {
    let ct = Enc::new(&derive_key(password).into(), &[0x20u8; 16].into()).encrypt_padded_vec_mut::<Pkcs7>(text.as_bytes());
    let mut out = b"v10".to_vec();
    out.extend(ct);
    out
}

pub fn decrypt_string(password: &[u8], data: &[u8]) -> Result<String> {
    let body = data.strip_prefix(b"v10").ok_or_else(|| anyhow!("암호문 형식이 올바르지 않아요"))?;
    let pt = Dec::new(&derive_key(password).into(), &[0x20u8; 16].into())
        .decrypt_padded_vec_mut::<Pkcs7>(body)
        .map_err(|_| anyhow!("비밀 메모를 풀지 못했어요 (키가 달라요)"))?;
    String::from_utf8(pt).map_err(|_| anyhow!("비밀 메모를 풀지 못했어요"))
}

fn err(s: &str) -> anyhow::Error {
    anyhow!(s.to_string())
}

fn utf16_len(s: &str) -> usize {
    s.encode_utf16().count()
}

fn now_ms() -> i64 {
    std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as i64).unwrap_or(0)
}

pub struct MemoStore {
    file: PathBuf,
    key: Option<Arc<dyn KeyProvider>>,
}

impl MemoStore {
    /// 실제 설정 폴더 + 실제 키체인
    pub fn system() -> Self {
        Self::new(app_dir::settings_file("memos.json"), Some(Arc::new(KeychainKey::new())))
    }

    pub fn new(file: PathBuf, key: Option<Arc<dyn KeyProvider>>) -> Self {
        MemoStore { file, key }
    }

    fn password(&self) -> Option<Vec<u8>> {
        self.key.as_ref().and_then(|k| k.password())
    }

    pub fn can_encrypt(&self) -> bool {
        self.password().is_some()
    }

    fn read(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|s| serde_json::from_str::<Value>(&s).ok())
            .and_then(|d| d.get("memos").and_then(Value::as_array).cloned())
            .unwrap_or_default()
    }

    fn write(&self, memos: &[Value]) -> Result<()> {
        use std::io::Write;
        use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
        if let Some(dir) = self.file.parent() {
            std::fs::create_dir_all(dir)?;
        }
        let mut tmp = self.file.clone().into_os_string();
        tmp.push(".tmp");
        let tmp = PathBuf::from(tmp);
        let text = serde_json::to_string_pretty(&json!({ "version": 1, "memos": memos }))?;
        let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp)?;
        f.write_all(text.as_bytes())?;
        drop(f);
        std::fs::rename(&tmp, &self.file)?;
        let _ = std::fs::set_permissions(&self.file, std::fs::Permissions::from_mode(0o600));
        Ok(())
    }

    /// 화면용 목록: 비밀 메모는 본문 없이
    pub fn list(&self) -> Value {
        let mut memos = self.read();
        memos.sort_by(|a, b| {
            let (x, y) = (a.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0), b.get("updatedAt").and_then(Value::as_f64).unwrap_or(0.0));
            y.partial_cmp(&x).unwrap_or(std::cmp::Ordering::Equal)
        });
        let items: Vec<Value> = memos
            .iter()
            .map(|m| {
                let mut o = Map::new();
                for k in ["id", "title", "kind", "updatedAt"] {
                    o.insert(k.into(), m.get(k).cloned().unwrap_or(Value::Null));
                }
                if m.get("kind").and_then(Value::as_str) == Some("secret") {
                    o.insert("encrypted".into(), json!(m.get("enc").and_then(Value::as_bool).unwrap_or(false)));
                    o.insert("length".into(), m.get("length").filter(|l| l.as_f64().map(|f| f != 0.0).unwrap_or(false)).cloned().unwrap_or(json!(0)));
                } else if let Some(b) = m.get("body") {
                    o.insert("body".into(), b.clone());
                }
                Value::Object(o)
            })
            .collect();
        json!({ "canEncrypt": self.can_encrypt(), "memos": items })
    }

    /// 새 메모 또는 고치기. 비밀 메모를 고칠 때 body 가 null 이면 본문은 그대로 둔다
    pub fn save(&self, req: &Value) -> Result<Value> {
        let kind = req.get("kind").and_then(Value::as_str).unwrap_or("");
        if !["memo", "code", "secret"].contains(&kind) {
            return Err(err("메모 종류가 올바르지 않아요"));
        }
        let title = match req.get("title") {
            Some(Value::String(s)) => s.trim().to_string(),
            Some(Value::Null) | None | Some(Value::Bool(false)) => String::new(),
            Some(v) => v.to_string().trim().to_string(),
        };
        if title.is_empty() {
            return Err(err("제목을 써 주세요"));
        }
        if utf16_len(&title) > 200 {
            return Err(err("제목이 너무 길어요"));
        }
        let body: Option<String> = match req.get("body") {
            None | Some(Value::Null) => None,
            Some(Value::String(s)) => Some(s.clone()),
            Some(v) => Some(v.to_string()),
        };
        if let Some(b) = &body {
            if utf16_len(b) > 200000 {
                return Err(err("본문이 너무 길어요"));
            }
        }

        let mut memos = self.read();
        let now = now_ms();
        let id = req.get("id").and_then(Value::as_str).filter(|s| !s.is_empty());
        let idx = match id {
            Some(i) => Some(memos.iter().position(|x| x.get("id").and_then(Value::as_str) == Some(i)).ok_or_else(|| err("없는 메모예요"))?),
            None => None,
        };
        let idx = match idx {
            Some(i) => i,
            None => {
                memos.push(json!({ "id": uuid::Uuid::new_v4().to_string(), "createdAt": now }));
                memos.len() - 1
            }
        };
        let mut m: Map<String, Value> = memos[idx].as_object().cloned().unwrap_or_default();
        let was_secret = m.get("kind").and_then(Value::as_str) == Some("secret");
        m.insert("title".into(), json!(title));
        m.insert("kind".into(), json!(kind));
        m.insert("updatedAt".into(), json!(now));
        let old_body = m.get("body").and_then(Value::as_str).unwrap_or("").to_string();

        if kind == "secret" {
            if body.is_none() && was_secret {
                // 본문 그대로
            } else {
                let text = body.clone().unwrap_or(old_body);
                m.remove("body");
                m.insert("length".into(), json!(utf16_len(&text)));
                match self.password() {
                    Some(pw) => {
                        m.insert("enc".into(), json!(true));
                        m.insert("data".into(), json!(B64.encode(encrypt_string(&pw, &text))));
                    }
                    None => {
                        m.insert("enc".into(), json!(false));
                        m.insert("data".into(), json!(B64.encode(text.as_bytes())));
                    }
                }
            }
        } else {
            let text = match body {
                None if was_secret => self.secret_text(&m)?,
                None => old_body,
                Some(b) => b,
            };
            m.remove("enc");
            m.remove("data");
            m.remove("length");
            m.insert("body".into(), json!(text));
        }
        let id_out = m.get("id").cloned().unwrap_or(Value::Null);
        memos[idx] = Value::Object(m);
        self.write(&memos)?;
        Ok(json!({ "id": id_out }))
    }

    pub fn remove(&self, id: &str) -> Result<Value> {
        let memos = self.read();
        let next: Vec<Value> = memos.iter().filter(|m| m.get("id").and_then(Value::as_str) != Some(id)).cloned().collect();
        if next.len() == memos.len() {
            return Err(err("없는 메모예요"));
        }
        self.write(&next)?;
        Ok(json!({ "id": id }))
    }

    /// 비밀 메모 본문 꺼내기 (보기·복사·입력창에 넣기 할 때만)
    pub fn reveal(&self, id: &str) -> Result<Value> {
        let memos = self.read();
        let m = memos.iter().find(|x| x.get("id").and_then(Value::as_str) == Some(id)).ok_or_else(|| err("없는 메모예요"))?;
        let body = if m.get("kind").and_then(Value::as_str) == Some("secret") {
            json!(self.secret_text(m.as_object().unwrap())?)
        } else {
            m.get("body").cloned().unwrap_or(Value::Null)
        };
        Ok(json!({ "id": id, "body": body }))
    }

    fn secret_text(&self, m: &Map<String, Value>) -> Result<String> {
        let data = match m.get("data").and_then(Value::as_str) {
            Some(d) if !d.is_empty() => d,
            _ => return Ok(String::new()),
        };
        let buf = B64.decode(data).map_err(|_| err("비밀 메모 데이터가 깨졌어요"))?;
        if m.get("enc").and_then(Value::as_bool).unwrap_or(false) {
            let pw = self.password().ok_or_else(|| err("이 컴퓨터에서는 이 비밀 메모를 풀 수 없어요"))?;
            return decrypt_string(&pw, &buf);
        }
        Ok(String::from_utf8_lossy(&buf).into_owned())
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn fake_key() -> Option<Arc<dyn KeyProvider>> {
        Some(Arc::new(|| Some(b"fake-keychain-password".to_vec())))
    }

    fn find<'a>(l: &'a Value, id: &Value) -> &'a Value {
        l["memos"].as_array().unwrap().iter().find(|m| &m["id"] == id).unwrap()
    }

    fn msg(r: Result<Value>) -> String {
        r.expect_err("오류가 나야 함").to_string()
    }

    #[test]
    fn memo_flow() {
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("memos.json");
        let store = MemoStore::new(file.clone(), fake_key());
        let a = store.save(&json!({"title": "서버 주소", "kind": "memo", "body": "https://example.local:8080"})).unwrap();
        let c = store.save(&json!({"title": "반복문", "kind": "code", "body": "for f in *.mid; do echo $f; done"})).unwrap();
        let k = store.save(&json!({"title": "API 키", "kind": "secret", "body": "sk-test-1234"})).unwrap();

        let mut l = store.list();
        assert_eq!(l["canEncrypt"], json!(true));
        assert_eq!(l["memos"].as_array().unwrap().len(), 3);
        let ks = find(&l, &k["id"]);
        assert!(ks.get("body").is_none(), "목록에는 비밀 본문이 없다");
        assert_eq!(ks["encrypted"], json!(true));
        assert_eq!(ks["length"], json!(12));
        assert_eq!(find(&l, &c["id"])["body"], json!("for f in *.mid; do echo $f; done"));
        let raw = std::fs::read_to_string(&file).unwrap();
        assert!(!raw.contains("sk-test-1234"), "파일에 비밀이 평문으로 남지 않는다");
        assert_eq!(std::fs::metadata(&file).unwrap().permissions().mode() & 0o777, 0o600, "파일 권한 600");
        assert_eq!(store.reveal(k["id"].as_str().unwrap()).unwrap()["body"], json!("sk-test-1234"));

        // 비밀 메모 제목만 고치면 본문은 그대로
        store.save(&json!({"id": k["id"], "title": "OpenAI 키", "kind": "secret", "body": null})).unwrap();
        assert_eq!(store.reveal(k["id"].as_str().unwrap()).unwrap()["body"], json!("sk-test-1234"));
        l = store.list();
        assert_eq!(find(&l, &k["id"])["title"], json!("OpenAI 키"));
        // 일반 -> 비밀 -> 일반
        store.save(&json!({"id": a["id"], "title": "서버 주소", "kind": "secret", "body": null})).unwrap();
        assert_eq!(store.reveal(a["id"].as_str().unwrap()).unwrap()["body"], json!("https://example.local:8080"));
        store.save(&json!({"id": a["id"], "title": "서버 주소", "kind": "memo", "body": null})).unwrap();
        l = store.list();
        assert_eq!(find(&l, &a["id"])["body"], json!("https://example.local:8080"));
        assert!(find(&l, &a["id"]).get("encrypted").is_none());

        // 잘못된 입력
        assert!(msg(store.save(&json!({"title": "", "kind": "memo", "body": "x"}))).contains("제목"));
        assert!(msg(store.save(&json!({"title": "x", "kind": "nope", "body": "x"}))).contains("종류"));
        assert!(msg(store.save(&json!({"id": "nope", "title": "x", "kind": "memo", "body": "x"}))).contains("없는 메모"));

        // 지우기
        store.remove(c["id"].as_str().unwrap()).unwrap();
        assert_eq!(store.list()["memos"].as_array().unwrap().len(), 2);
        assert!(msg(store.remove(c["id"].as_str().unwrap())).contains("없는 메모"));

        // 암호화를 못 하는 컴퓨터: 평문(base64)으로 두고 encrypted:false 로 알린다
        let plain = MemoStore::new(tmp.path().join("plain.json"), None);
        let p = plain.save(&json!({"title": "비번", "kind": "secret", "body": "pw"})).unwrap();
        assert_eq!(plain.list()["canEncrypt"], json!(false));
        assert_eq!(plain.list()["memos"][0]["encrypted"], json!(false));
        assert_eq!(plain.reveal(p["id"].as_str().unwrap()).unwrap()["body"], json!("pw"));
        // 키가 없는 provider (키체인 항목 없음) 도 같다
        let nokey = MemoStore::new(file.clone(), Some(Arc::new(|| None)));
        // 암호화된 메모를 암호화 못 하는 곳에서 열면 막는다
        assert!(msg(nokey.reveal(k["id"].as_str().unwrap())).contains("풀 수 없어요"));
    }

    #[test]
    fn decrypts_electron_v10_blob() {
        // node: pbkdf2Sync('testpw','saltysalt',1003,16,'sha1') + aes-128-cbc, iv 공백 16개, 앞에 'v10'
        let blob = B64.decode("djEwBtOGTIk/pzoVIF4xOM2qqebh81p/W3oCEP7JYtLDMYU=").unwrap();
        assert_eq!(decrypt_string(b"testpw", &blob).unwrap(), "hello 비밀 sk-123");
        assert!(decrypt_string(b"wrong", &blob).map(|s| s != "hello 비밀 sk-123").unwrap_or(true));
        // 우리 쪽 암호화도 같은 바이트가 나온다
        assert_eq!(encrypt_string(b"testpw", "hello 비밀 sk-123"), blob);
        assert!(decrypt_string(b"testpw", b"xyz").is_err());
    }

    #[test]
    fn reads_electron_written_file() {
        // 예전 앱이 쓴 모양(enc:true + data=base64(v10..))을 새 저장소가 풀어 준다
        let tmp = tempfile::tempdir().unwrap();
        let file = tmp.path().join("memos.json");
        std::fs::write(
            &file,
            r#"{"version":1,"memos":[{"id":"x1","createdAt":1,"title":"키","kind":"secret","updatedAt":2,"length":17,"enc":true,"data":"djEwBtOGTIk/pzoVIF4xOM2qqebh81p/W3oCEP7JYtLDMYU="}]}"#,
        )
        .unwrap();
        let store = MemoStore::new(file, Some(Arc::new(|| Some(b"testpw".to_vec()))));
        assert_eq!(store.reveal("x1").unwrap()["body"], json!("hello 비밀 sk-123"));
        assert_eq!(store.list()["memos"][0]["length"], json!(17));
    }
}
