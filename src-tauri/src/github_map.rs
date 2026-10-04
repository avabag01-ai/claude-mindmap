//! GitHub 마인드맵 데이터: 내 저장소 목록, 저장소 하나의 열린 PR · 최근 브랜치. JS 쪽은 src/core/GitHubMap.js.
//! - gh api(REST)로만 읽는다 (GraphQL 쓰지 않음). gh 실행·오류 문구는 git_panel 것을 같이 쓴다.
//! - 로컬 폴더(세션 폴더)의 origin 을 읽어 "저장소 ↔ 로컬 폴더"를 이어 준다.
//! - 읽기만 한다. 푸시·브랜치 지우기 같은 일은 하지 않는다.
//! 돌려주는 모양:
//!   repos  → { account, repos: [{ name, fullName, url, pushedAt, language, private, fork, archived, defaultBranch, description }], local: { 폴더: "주인/이름" } }
//!   detail → { slug, prs: [GitPanel::pr_from_rest], branches: [{ name, date, isDefault }], branchCount }

use crate::git_panel::GitPanel;
use anyhow::{anyhow, Result};
use once_cell::sync::Lazy;
use regex::Regex;
use serde_json::{json, Map, Value};
use std::path::Path;

static SLUG_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"^[\w.-]+/[\w.-]+$").unwrap());

/// 최근 브랜치: 날짜를 읽어 볼 브랜치 수, 보여 줄 수
const BRANCH_PROBE: usize = 20;
const BRANCH_SHOW: usize = 8;

fn home() -> String {
    crate::app_dir::home().to_string_lossy().into_owned()
}

fn repo_of(r: &Value) -> Value {
    json!({
        "name": r["name"], "fullName": r["full_name"], "url": r["html_url"], "pushedAt": r["pushed_at"],
        "language": r["language"], "private": r["private"].as_bool().unwrap_or(false), "fork": r["fork"].as_bool().unwrap_or(false),
        "archived": r["archived"].as_bool().unwrap_or(false), "defaultBranch": r["default_branch"], "description": r["description"]
    })
}

/// 내 저장소 전부 (100개씩 쪽을 넘기며) + 로컬 폴더의 origin
pub fn repos(git: &GitPanel, roots: &[String]) -> Result<Value> {
    let cwd = home();
    let user = git.gh_json(&cwd, "user", "{}")?;
    let mut list = Vec::new();
    for page in 1..=10 {
        let v = git.gh_json(&cwd, &format!("user/repos?per_page=100&affiliation=owner&sort=pushed&page={page}"), "[]")?;
        let arr = v.as_array().cloned().unwrap_or_default();
        let n = arr.len();
        list.extend(arr.iter().map(repo_of));
        if n < 100 {
            break;
        }
    }
    Ok(json!({ "account": user["login"], "repos": list, "local": local_slugs(git, roots) }))
}

/// 폴더 → "주인/이름" (origin 이 github.com 인 것만)
pub fn local_slugs(git: &GitPanel, roots: &[String]) -> Value {
    let mut m = Map::new();
    for root in roots {
        if root.is_empty() || m.contains_key(root) || !Path::new(root).is_dir() {
            continue;
        }
        let remote = git.git(root, &["remote", "get-url", "origin"]).unwrap_or_default();
        if let Some(web) = GitPanel::web_url(remote.trim()) {
            m.insert(root.clone(), json!(web.replace("https://github.com/", "")));
        }
    }
    Value::Object(m)
}

/// 저장소 하나: 열린 PR, 최근 브랜치 (브랜치 날짜는 앞 20개만 나눠 읽고 최근 8개)
pub fn detail(git: &GitPanel, slug: &str) -> Result<Value> {
    if !SLUG_RE.is_match(slug) || slug.contains("..") {
        return Err(anyhow!("저장소 이름이 올바르지 않아요"));
    }
    let cwd = home();
    let info = git.gh_json(&cwd, &format!("repos/{slug}"), "{}")?;
    let default = info["default_branch"].as_str().unwrap_or("").to_string();
    let prs = git.gh_json(&cwd, &format!("repos/{slug}/pulls?state=open&per_page=30"), "[]")?;
    let prs: Vec<Value> = prs.as_array().into_iter().flatten().map(GitPanel::pr_from_rest).collect();
    let branches = git.gh_json(&cwd, &format!("repos/{slug}/branches?per_page=100"), "[]")?;
    let all: Vec<(String, String)> = branches
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|b| Some((b["name"].as_str()?.to_string(), b["commit"]["sha"].as_str().unwrap_or("").to_string())))
        .collect();
    // 기본 브랜치를 먼저 넣고 나머지는 앞에서부터 (날짜는 브랜치마다 한 번씩 읽어야 해서 개수를 줄인다)
    let mut probe: Vec<&(String, String)> = all.iter().filter(|b| b.0 == default).collect();
    probe.extend(all.iter().filter(|b| b.0 != default).take(BRANCH_PROBE - probe.len()));
    let dates: Vec<String> = std::thread::scope(|sc| {
        let hs: Vec<_> = probe
            .iter()
            .map(|(_, sha)| {
                let cwd = cwd.clone();
                sc.spawn(move || {
                    if sha.is_empty() {
                        return String::new();
                    }
                    git.gh_json(&cwd, &format!("repos/{slug}/commits/{sha}"), "{}").ok().and_then(|c| c["commit"]["committer"]["date"].as_str().map(str::to_string)).unwrap_or_default()
                })
            })
            .collect();
        hs.into_iter().map(|h| h.join().unwrap_or_default()).collect()
    });
    let mut list: Vec<(String, String)> = probe.iter().map(|b| b.0.clone()).zip(dates).collect();
    list.sort_by(|a, b| b.1.cmp(&a.1));
    let list: Vec<Value> = list.into_iter().take(BRANCH_SHOW).map(|(name, date)| json!({ "name": name, "date": date, "isDefault": name == default })).collect();
    Ok(json!({ "slug": slug, "prs": prs, "branches": list, "branchCount": all.len() }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::os::unix::fs::PermissionsExt;
    use std::process::Command;

    #[test]
    fn repos_and_detail_with_fake_gh() {
        let tmp = tempfile::tempdir().unwrap();
        let t = tmp.path();
        let fake = t.join("fake-gh.sh");
        fs::write(
            &fake,
            r#"#!/bin/sh
case "$2" in
  user) echo '{"login":"me"}';;
  user/repos*page=1) echo '[{"name":"a","full_name":"me/a","html_url":"https://github.com/me/a","pushed_at":"2026-10-01T00:00:00Z","language":"Rust","private":true,"fork":false,"archived":false,"default_branch":"main","description":"d"}]';;
  repos/me/a) echo '{"default_branch":"main"}';;
  repos/me/a/pulls*) echo '[{"number":3,"title":"p","draft":false,"head":{"ref":"feat"},"html_url":"u","user":{"login":"me"},"updated_at":"x"}]';;
  repos/me/a/branches*) echo '[{"name":"old","commit":{"sha":"s1"}},{"name":"main","commit":{"sha":"s2"}},{"name":"feat","commit":{"sha":"s3"}}]';;
  repos/me/a/commits/s1) echo '{"commit":{"committer":{"date":"2026-01-01T00:00:00Z"}}}';;
  repos/me/a/commits/s2) echo '{"commit":{"committer":{"date":"2026-09-01T00:00:00Z"}}}';;
  repos/me/a/commits/s3) echo '{"commit":{"committer":{"date":"2026-10-01T00:00:00Z"}}}';;
  *) echo "gh: not logged in, run: gh auth login" >&2; exit 1;;
esac
"#,
        )
        .unwrap();
        fs::set_permissions(&fake, fs::Permissions::from_mode(0o755)).unwrap();
        let gp = GitPanel::with_gh_bin(fake.to_str().unwrap());

        // 로컬 폴더: origin 이 GitHub 인 것만 이어진다
        let repo = t.join("clone");
        fs::create_dir(&repo).unwrap();
        let g = |args: &[&str]| assert!(Command::new("git").args(args).current_dir(&repo).status().unwrap().success());
        g(&["init", "-q"]);
        g(&["remote", "add", "origin", "git@github.com:me/a.git"]);
        let plain = t.join("plain");
        fs::create_dir(&plain).unwrap();
        let roots = vec![repo.to_string_lossy().into_owned(), plain.to_string_lossy().into_owned(), "/없는/폴더".into()];

        let r = repos(&gp, &roots).unwrap();
        assert_eq!(r["account"], "me");
        assert_eq!(r["repos"][0]["fullName"], "me/a");
        assert_eq!(r["repos"][0]["private"], true);
        assert_eq!(r["local"], json!({ repo.to_string_lossy(): "me/a" }));

        let d = detail(&gp, "me/a").unwrap();
        assert_eq!(d["prs"][0]["headRefName"], "feat");
        assert_eq!(d["branchCount"], 3);
        // 최근 것부터, 기본 브랜치 표시
        assert_eq!(d["branches"], json!([
            { "name": "feat", "date": "2026-10-01T00:00:00Z", "isDefault": false },
            { "name": "main", "date": "2026-09-01T00:00:00Z", "isDefault": true },
            { "name": "old", "date": "2026-01-01T00:00:00Z", "isDefault": false }
        ]));
        assert!(detail(&gp, "../x").is_err());
        assert!(detail(&gp, "me/b").unwrap_err().to_string().contains("gh 로그인이 필요해요"));
    }
}
