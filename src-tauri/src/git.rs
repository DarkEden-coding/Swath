use crate::types::GIT_RUN_MAX_BUFFER_BYTES;
use serde_json::{json, Value};
use std::error::Error;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use std::time::{Duration, Instant};

const RS: char = '\x1f';
const GIT_TIMEOUT: Duration = Duration::from_secs(300);

type GitResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

struct RunGitResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

fn read_capped<R: Read + Send + 'static>(mut reader: R) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let remaining = GIT_RUN_MAX_BUFFER_BYTES.saturating_sub(out.len());
                    if remaining > 0 {
                        out.extend_from_slice(&buf[..n.min(remaining)]);
                    }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    })
}

fn run_git(cwd: &str, args: &[&str]) -> RunGitResult {
    let mut child = match Command::new("git")
        .args(args)
        .current_dir(cwd)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
    {
        Ok(child) => child,
        Err(err) => {
            let exit_code = if err.kind() == std::io::ErrorKind::NotFound {
                127
            } else {
                1
            };
            return RunGitResult {
                exit_code,
                stdout: String::new(),
                stderr: err.to_string(),
            };
        }
    };

    let stdout_handle = child.stdout.take().map(read_capped);
    let stderr_handle = child.stderr.take().map(read_capped);
    let start = Instant::now();
    let mut timed_out = false;
    let exit_code = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status.code().unwrap_or(1),
            Ok(None) => {
                if start.elapsed() >= GIT_TIMEOUT {
                    timed_out = true;
                    let _ = child.kill();
                    break child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
                }
                thread::sleep(Duration::from_millis(25));
            }
            Err(_) => {
                let _ = child.kill();
                break child.wait().ok().and_then(|s| s.code()).unwrap_or(1);
            }
        }
    };

    let stdout = stdout_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    let mut stderr = stderr_handle
        .and_then(|h| h.join().ok())
        .unwrap_or_default();
    if timed_out && stderr.trim().is_empty() {
        stderr = "git command timed out".to_string();
    }
    RunGitResult {
        exit_code,
        stdout,
        stderr,
    }
}

fn run_json(cwd: &str, args: &[&str]) -> Value {
    let r = run_git(cwd.trim(), args);
    json!({ "exitCode": r.exit_code, "stdout": r.stdout, "stderr": r.stderr })
}

fn str_field<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    v.get(key)?.as_str()
}

fn paths_field(v: &Value) -> Option<Vec<String>> {
    v.get("paths")?
        .as_array()?
        .iter()
        .map(|x| x.as_str().map(ToOwned::to_owned))
        .collect()
}

fn split_null(stdout: &str) -> Vec<String> {
    stdout
        .split('\0')
        .filter(|p| !p.is_empty())
        .map(ToOwned::to_owned)
        .collect()
}

fn parse_name_status(stdout: &str) -> Vec<Value> {
    stdout
        .lines()
        .filter_map(|line| {
            let (raw, path_field) = line.split_once('\t')?;
            let path = path_field.rsplit('\t').next().unwrap_or(path_field);
            let status = raw.chars().next().unwrap_or('?').to_string();
            Some(json!({ "path": path, "status": status }))
        })
        .collect()
}

fn get_status(cwd: &str) -> Value {
    let wt = run_git(cwd, &["rev-parse", "--is-inside-work-tree"]);
    if wt.exit_code != 0 || wt.stdout.trim() != "true" {
        return json!({ "ok": false, "branch": null, "staged": [], "unstaged": [], "untracked": [], "error": if wt.stderr.trim().is_empty() { "Not a Git repository" } else { wt.stderr.trim() }, "stderr": wt.stderr });
    }
    let branch_r = run_git(cwd, &["branch", "--show-current"]);
    let branch = if branch_r.exit_code == 0 && !branch_r.stdout.trim().is_empty() {
        json!(branch_r.stdout.trim())
    } else {
        Value::Null
    };
    let unstaged_r = run_git(cwd, &["diff", "--name-status"]);
    let staged_r = run_git(cwd, &["diff", "--cached", "--name-status"]);
    let untracked_r = run_git(cwd, &["ls-files", "-z", "--others", "--exclude-standard"]);
    let stderr = [unstaged_r.stderr, staged_r.stderr, untracked_r.stderr]
        .into_iter()
        .filter(|s| !s.is_empty())
        .collect::<Vec<_>>()
        .join("\n");
    json!({ "ok": true, "branch": branch, "staged": parse_name_status(&staged_r.stdout), "unstaged": parse_name_status(&unstaged_r.stdout), "untracked": split_null(&untracked_r.stdout), "stderr": stderr })
}

fn discard_paths(cwd: &str, paths: &[String]) -> Value {
    if paths.is_empty() {
        return json!({ "exitCode": 0, "stdout": "", "stderr": "" });
    }
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for p in paths {
        if run_git(cwd, &["ls-files", "--error-unmatch", "--", p]).exit_code == 0 {
            tracked.push(p.as_str());
        } else {
            untracked.push(p.as_str());
        }
    }
    let mut exit_code = 0;
    let mut out = Vec::new();
    let mut err = Vec::new();
    if !untracked.is_empty() {
        let mut args = vec!["clean", "-f", "-q", "--"];
        args.extend(untracked);
        let r = run_git(cwd, &args);
        exit_code = r.exit_code;
        out.push(r.stdout);
        err.push(r.stderr);
    }
    if !tracked.is_empty() && exit_code == 0 {
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(tracked);
        let r = run_git(cwd, &args);
        exit_code = r.exit_code;
        out.push(r.stdout);
        err.push(r.stderr);
    }
    json!({ "exitCode": exit_code, "stdout": out.join("\n"), "stderr": err.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n") })
}

fn get_log(cwd: &str) -> Value {
    let wt = run_git(cwd, &["rev-parse", "--is-inside-work-tree"]);
    if wt.exit_code != 0 || wt.stdout.trim() != "true" {
        return json!({ "ok": false, "commits": [], "error": if wt.stderr.trim().is_empty() { "Not a Git repository" } else { wt.stderr.trim() } });
    }
    if run_git(cwd, &["rev-parse", "-q", "--verify", "HEAD"]).exit_code != 0 {
        return json!({ "ok": true, "commits": [] });
    }
    let fmt = format!("--pretty=format:%H{RS}%P{RS}%h{RS}%s{RS}%an{RS}%cr{RS}%D");
    let r = run_git(
        cwd,
        &[
            "-c",
            "core.quotepath=false",
            "log",
            "--all",
            "--graph",
            "--color=never",
            "-n",
            "100",
            "--date=relative",
            &fmt,
        ],
    );
    if r.exit_code != 0 {
        return json!({ "ok": false, "commits": [], "error": if r.stderr.trim().is_empty() { "git log failed" } else { r.stderr.trim() }, "stderr": r.stderr });
    }
    let mut commits = Vec::new();
    for line in r.stdout.lines().filter(|l| !l.trim().is_empty()) {
        let idx = match line.find(|c: char| c.is_ascii_hexdigit()) {
            Some(i) => i,
            None => continue,
        };
        let graph = line[..idx].trim_end();
        let parts: Vec<&str> = line[idx..].split(RS).collect();
        if parts.len() < 7 || parts[0].len() < 40 {
            continue;
        }
        let parents: Vec<&str> = parts[1]
            .split_whitespace()
            .filter(|p| p.len() == 40 && p.chars().all(|c| c.is_ascii_hexdigit()))
            .collect();
        commits.push(json!({ "graph": graph, "hash": parts[0], "parents": parents, "short": parts[2], "subject": parts[3], "author": parts[4], "date": parts[5], "refs": parts[6] }));
    }
    json!({ "ok": true, "commits": commits })
}

fn list_branches(cwd: &str) -> Value {
    let r = run_git(cwd, &["branch", "-a", "--format=%(refname:short)"]);
    if r.exit_code != 0 {
        return json!({ "ok": false, "branches": [], "error": if r.stderr.trim().is_empty() { "Unable to list branches" } else { r.stderr.trim() } });
    }
    let mut branches: Vec<String> = r
        .stdout
        .lines()
        .map(str::trim)
        .filter(|b| !b.is_empty() && *b != "HEAD")
        .map(ToOwned::to_owned)
        .collect();
    branches.sort_by_key(|s| s.to_lowercase());
    branches.dedup();
    json!({ "ok": true, "branches": branches })
}

pub fn rpc(request: Value) -> GitResult<Value> {
    let op = str_field(&request, "op").unwrap_or("");
    let cwd = str_field(&request, "cwd").unwrap_or("").trim();
    if cwd.is_empty() {
        return Ok(
            json!({ "ok": false, "error": "Invalid git request", "exitCode": 1, "stdout": "", "stderr": "Invalid git request" }),
        );
    }
    Ok(match op {
        "getStatus" => get_status(cwd),
        "stagePaths" => {
            let p = paths_field(&request).unwrap_or_default();
            if p.is_empty() {
                json!({ "exitCode": 0, "stdout": "", "stderr": "" })
            } else {
                let mut a = vec!["add", "--"];
                a.extend(p.iter().map(String::as_str));
                run_json(cwd, &a)
            }
        }
        "unstagePaths" => {
            let p = paths_field(&request).unwrap_or_default();
            if p.is_empty() {
                json!({ "exitCode": 0, "stdout": "", "stderr": "" })
            } else {
                let mut a = vec!["restore", "--staged", "--"];
                a.extend(p.iter().map(String::as_str));
                run_json(cwd, &a)
            }
        }
        "discardPaths" => discard_paths(cwd, &paths_field(&request).unwrap_or_default()),
        "commit" => {
            let msg = str_field(&request, "message").unwrap_or("").trim();
            if msg.is_empty() {
                json!({ "exitCode": 1, "stdout": "", "stderr": "Commit message is required" })
            } else {
                run_json(cwd, &["commit", "-m", msg])
            }
        }
        "pull" => run_json(cwd, &["pull"]),
        "push" => run_json(cwd, &["push"]),
        "sync" => {
            let pull = run_git(cwd, &["pull"]);
            if pull.exit_code != 0 {
                json!({ "ok": false, "exitCode": pull.exit_code, "stdout": pull.stdout, "stderr": pull.stderr, "steps": ["pull"] })
            } else {
                let push = run_git(cwd, &["push"]);
                let stdout = format!("{}\n---\n{}", pull.stdout, push.stdout);
                let stderr = [pull.stderr, push.stderr]
                    .into_iter()
                    .filter(|s| !s.is_empty())
                    .collect::<Vec<_>>()
                    .join("\n");
                json!({ "ok": push.exit_code == 0, "exitCode": push.exit_code, "stdout": stdout, "stderr": stderr, "steps": ["pull", "push"] })
            }
        }
        "getLog" => get_log(cwd),
        "listBranches" => list_branches(cwd),
        "checkoutBranch" => run_json(
            cwd,
            &["switch", str_field(&request, "branch").unwrap_or("").trim()],
        ),
        _ => json!({ "exitCode": 1, "stdout": "", "stderr": "Unknown git operation" }),
    })
}
