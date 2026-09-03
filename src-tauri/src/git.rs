use crate::types::{GitDataEvent, GIT_RUN_MAX_BUFFER_BYTES};
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::io::Read;
use std::process::{Command, Stdio};
use std::thread;
use tauri::{AppHandle, Emitter};

#[cfg(windows)]
use std::os::windows::process::CommandExt;

#[cfg(windows)]
const CREATE_NO_WINDOW: u32 = 0x08000000;
use std::time::{Duration, Instant};

const RS: char = '\x1f';
const GIT_TIMEOUT: Duration = Duration::from_secs(300);
const GIT_DATA_EVENT: &str = "git:data";

type GitResult<T> = Result<T, Box<dyn Error + Send + Sync>>;

struct RunGitResult {
    exit_code: i32,
    stdout: String,
    stderr: String,
}

/// Optional live-output sink for a single git RPC run.
struct StreamTarget {
    app: AppHandle,
    run_id: String,
}

impl StreamTarget {
    fn emit(&self, data: &str) {
        if data.is_empty() {
            return;
        }
        let _ = self.app.emit(
            GIT_DATA_EVENT,
            GitDataEvent {
                run_id: self.run_id.clone(),
                data: data.to_string(),
            },
        );
    }
}

/// Drains a child-process stream while retaining at most the configured limit.
fn read_capped<R: Read + Send + 'static>(
    mut reader: R,
    stream: Option<StreamTarget>,
) -> thread::JoinHandle<String> {
    thread::spawn(move || {
        let mut out = Vec::new();
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    let chunk = &buf[..n];
                    let remaining = GIT_RUN_MAX_BUFFER_BYTES.saturating_sub(out.len());
                    if remaining > 0 {
                        out.extend_from_slice(&chunk[..n.min(remaining)]);
                    }
                    if let Some(ref target) = stream {
                        target.emit(&String::from_utf8_lossy(chunk));
                    }
                }
                Err(_) => break,
            }
        }
        String::from_utf8_lossy(&out).into_owned()
    })
}

/// Builds a non-interactive Git command with captured output.
fn git_command(cwd: &str, args: &[&str]) -> Command {
    let mut command = Command::new("git");
    command
        .args(args)
        .current_dir(cwd)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env("GIT_TERMINAL_PROMPT", "0")
        .env("GIT_PROGRESS_DELAY", "0")
        .env("GIT_DISCOVERY_ACROSS_FILESYSTEM", "1");
    #[cfg(windows)]
    command.creation_flags(CREATE_NO_WINDOW);
    command
}

/// Runs Git with bounded output and a fixed timeout.
fn run_git(cwd: &str, args: &[&str], stream: Option<&StreamTarget>) -> RunGitResult {
    let mut child = match git_command(cwd, args).spawn() {
        Ok(child) => child,
        Err(err) => {
            let exit_code = if err.kind() == std::io::ErrorKind::NotFound {
                127
            } else {
                1
            };
            let stderr = err.to_string();
            if let Some(target) = stream {
                target.emit(&stderr);
            }
            return RunGitResult {
                exit_code,
                stdout: String::new(),
                stderr,
            };
        }
    };

    let stdout_handle = child.stdout.take().map(|stdout| {
        read_capped(
            stdout,
            stream.map(|s| StreamTarget {
                app: s.app.clone(),
                run_id: s.run_id.clone(),
            }),
        )
    });
    let stderr_handle = child.stderr.take().map(|stderr| {
        read_capped(
            stderr,
            stream.map(|s| StreamTarget {
                app: s.app.clone(),
                run_id: s.run_id.clone(),
            }),
        )
    });
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
        if let Some(target) = stream {
            target.emit(&stderr);
        }
    }
    RunGitResult {
        exit_code,
        stdout,
        stderr,
    }
}

fn run_json(cwd: &str, args: &[&str], stream: Option<&StreamTarget>) -> Value {
    let r = run_git(cwd.trim(), args, stream);
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

fn stream_from_request(app: &AppHandle, request: &Value) -> Option<StreamTarget> {
    let run_id = str_field(request, "runId")?.trim();
    if run_id.is_empty() {
        return None;
    }
    Some(StreamTarget {
        app: app.clone(),
        run_id: run_id.to_string(),
    })
}

/// Parses NUL-delimited porcelain v1 status into UI-facing collections.
fn parse_status_porcelain(stdout: &str) -> (Value, Vec<Value>, Vec<Value>, Vec<String>) {
    // `-z` makes paths literal and places a rename/copy's source in the next field;
    // the UI reports the destination path, so that source field is intentionally skipped.
    let mut branch = Value::Null;
    let mut staged = Vec::new();
    let mut unstaged = Vec::new();
    let mut untracked = Vec::new();
    let mut entries = stdout.split('\0').filter(|p| !p.is_empty()).peekable();
    while let Some(entry) = entries.next() {
        if let Some(head) = entry.strip_prefix("## ") {
            let name = head.split("...").next().unwrap_or(head).trim();
            if !name.is_empty() && name != "HEAD (no branch)" {
                branch = json!(name);
            }
            continue;
        }
        if entry.len() < 4 {
            continue;
        }
        let bytes = entry.as_bytes();
        let x = bytes[0] as char;
        let y = bytes[1] as char;
        let path = &entry[3..];
        if x == '?' && y == '?' {
            untracked.push(path.to_string());
            continue;
        }
        if matches!(x, 'R' | 'C') {
            let _ = entries.next();
        }
        if x != ' ' && x != '?' && x != '!' {
            staged.push(json!({ "path": path, "status": x.to_string() }));
        }
        if y != ' ' && y != '?' && y != '!' {
            unstaged.push(json!({ "path": path, "status": y.to_string() }));
        }
    }
    (branch, staged, unstaged, untracked)
}

fn get_status(cwd: &str) -> Value {
    let r = run_git(
        cwd,
        &[
            "-c",
            "core.quotepath=false",
            "status",
            "--porcelain=v1",
            "-z",
            "-b",
            "--untracked-files=all",
        ],
        None,
    );
    if r.exit_code != 0 {
        return json!({ "ok": false, "branch": null, "staged": [], "unstaged": [], "untracked": [], "error": if r.stderr.trim().is_empty() { "Not a Git repository" } else { r.stderr.trim() }, "stderr": r.stderr });
    }
    let (branch, staged, unstaged, untracked) = parse_status_porcelain(&r.stdout);
    json!({ "ok": true, "branch": branch, "staged": staged, "unstaged": unstaged, "untracked": untracked, "stderr": r.stderr })
}

fn discard_paths(cwd: &str, paths: &[String]) -> Value {
    if paths.is_empty() {
        return json!({ "exitCode": 0, "stdout": "", "stderr": "" });
    }
    let mut tracked = Vec::new();
    let mut untracked = Vec::new();
    for p in paths {
        if run_git(cwd, &["ls-files", "--error-unmatch", "--", p], None).exit_code == 0 {
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
        let r = run_git(cwd, &args, None);
        exit_code = r.exit_code;
        out.push(r.stdout);
        err.push(r.stderr);
    }
    if !tracked.is_empty() && exit_code == 0 {
        let mut args = vec!["restore", "--worktree", "--"];
        args.extend(tracked);
        let r = run_git(cwd, &args, None);
        exit_code = r.exit_code;
        out.push(r.stdout);
        err.push(r.stderr);
    }
    json!({ "exitCode": exit_code, "stdout": out.join("\n"), "stderr": err.into_iter().filter(|s| !s.is_empty()).collect::<Vec<_>>().join("\n") })
}

/// Finds branch refs whose tip tree already exists on the base branch under a different commit.
fn squash_merged_refs(cwd: &str, base: &str) -> Vec<String> {
    let base_log = run_git(cwd, &["log", base, "--format=%H%x1f%T"], None);
    let all_log = run_git(cwd, &["log", "--all", "--format=%H%x1f%T"], None);
    let refs = run_git(
        cwd,
        &[
            "for-each-ref",
            "--format=%(refname)%1f%(objectname)",
            "refs/heads",
            "refs/remotes",
        ],
        None,
    );
    if base_log.exit_code != 0 || all_log.exit_code != 0 || refs.exit_code != 0 {
        return Vec::new();
    }

    let parse_log = |output: &str| {
        output
            .lines()
            .filter_map(|line| line.split_once(RS))
            .map(|(hash, tree)| (hash.to_string(), tree.to_string()))
            .collect::<HashMap<_, _>>()
    };
    let base_commits = parse_log(&base_log.stdout);
    let base_trees: HashSet<&str> = base_commits.values().map(String::as_str).collect();
    let all_commits = parse_log(&all_log.stdout);

    refs.stdout
        .lines()
        .filter_map(|line| line.split_once(RS))
        .filter(|(_, hash)| {
            !base_commits.contains_key(*hash)
                && all_commits
                    .get(*hash)
                    .is_some_and(|tree| base_trees.contains(tree.as_str()))
        })
        .map(|(ref_name, _)| ref_name.to_string())
        .collect()
}

fn get_log(cwd: &str) -> Value {
    let wt = run_git(cwd, &["rev-parse", "--is-inside-work-tree"], None);
    if wt.exit_code != 0 || wt.stdout.trim() != "true" {
        return json!({ "ok": false, "commits": [], "error": if wt.stderr.trim().is_empty() { "Not a Git repository" } else { wt.stderr.trim() } });
    }
    if run_git(cwd, &["rev-parse", "-q", "--verify", "HEAD"], None).exit_code != 0 {
        return json!({ "ok": true, "commits": [] });
    }
    let remote_only: HashSet<String> = run_git(cwd, &["rev-list", "HEAD..@{upstream}"], None)
        .stdout
        .lines()
        .map(str::to_owned)
        .collect();
    let remote_head = run_git(
        cwd,
        &["symbolic-ref", "-q", "refs/remotes/origin/HEAD"],
        None,
    );
    let base = if remote_head.exit_code == 0 {
        remote_head.stdout.trim().to_string()
    } else if run_git(
        cwd,
        &["rev-parse", "-q", "--verify", "refs/heads/main"],
        None,
    )
    .exit_code
        == 0
    {
        "refs/heads/main".to_string()
    } else {
        "HEAD".to_string()
    };
    let excluded = squash_merged_refs(cwd, &base);
    let excludes: Vec<String> = excluded
        .iter()
        .map(|ref_name| format!("--exclude={ref_name}"))
        .collect();
    let fmt = format!("--pretty=format:%H{RS}%P{RS}%h{RS}%s{RS}%an{RS}%cr{RS}%D");
    let mut args = vec!["-c", "core.quotepath=false", "log"];
    args.extend(excludes.iter().map(String::as_str));
    args.extend([
        "--all",
        "--graph",
        "--color=never",
        "-n",
        "100",
        "--date=relative",
        &fmt,
    ]);
    let r = run_git(cwd, &args, None);
    if r.exit_code != 0 {
        return json!({ "ok": false, "commits": [], "error": if r.stderr.trim().is_empty() { "git log failed" } else { r.stderr.trim() }, "stderr": r.stderr });
    }
    let mut commits = Vec::new();
    for line in r.stdout.lines().filter(|l| !l.trim().is_empty()) {
        // Graph prefixes contain only decoration characters; the full 40-byte hash is
        // therefore the first hexadecimal run and anchors the record-separated fields.
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
        commits.push(json!({ "graph": graph, "hash": parts[0], "parents": parents, "short": parts[2], "subject": parts[3], "author": parts[4], "date": parts[5], "refs": parts[6], "remoteOnly": remote_only.contains(parts[0]) }));
    }
    json!({ "ok": true, "commits": commits })
}

fn list_branches(cwd: &str) -> Value {
    let r = run_git(cwd, &["branch", "-a", "--format=%(refname:short)"], None);
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

/// Dispatches a JSON Git request and returns its JSON response.
pub fn rpc(app: &AppHandle, request: Value) -> GitResult<Value> {
    let op = str_field(&request, "op").unwrap_or("");
    let cwd = str_field(&request, "cwd").unwrap_or("").trim();
    if cwd.is_empty() {
        return Ok(
            json!({ "ok": false, "error": "Invalid git request", "exitCode": 1, "stdout": "", "stderr": "Invalid git request" }),
        );
    }
    let stream = stream_from_request(app, &request);
    Ok(match op {
        "getStatus" => get_status(cwd),
        "stagePaths" => {
            let p = paths_field(&request).unwrap_or_default();
            if p.is_empty() {
                json!({ "exitCode": 0, "stdout": "", "stderr": "" })
            } else {
                let mut a = vec!["add", "--"];
                a.extend(p.iter().map(String::as_str));
                run_json(cwd, &a, None)
            }
        }
        "unstagePaths" => {
            let p = paths_field(&request).unwrap_or_default();
            if p.is_empty() {
                json!({ "exitCode": 0, "stdout": "", "stderr": "" })
            } else {
                let mut a = vec!["restore", "--staged", "--"];
                a.extend(p.iter().map(String::as_str));
                run_json(cwd, &a, None)
            }
        }
        "discardPaths" => discard_paths(cwd, &paths_field(&request).unwrap_or_default()),
        "commit" => {
            let msg = str_field(&request, "message").unwrap_or("").trim();
            if msg.is_empty() {
                json!({ "exitCode": 1, "stdout": "", "stderr": "Commit message is required" })
            } else {
                run_json(cwd, &["commit", "-m", msg], stream.as_ref())
            }
        }
        "pull" => run_json(cwd, &["pull", "--progress"], stream.as_ref()),
        "push" => run_json(cwd, &["push", "--progress"], stream.as_ref()),
        "fetch" => run_json(cwd, &["fetch", "--quiet"], None),
        "sync" => {
            if let Some(ref target) = stream {
                target.emit("$ git pull --progress\n");
            }
            let pull = run_git(cwd, &["pull", "--progress"], stream.as_ref());
            if pull.exit_code != 0 {
                json!({ "ok": false, "exitCode": pull.exit_code, "stdout": pull.stdout, "stderr": pull.stderr, "steps": ["pull"] })
            } else {
                if let Some(ref target) = stream {
                    target.emit("\n$ git push --progress\n");
                }
                let push = run_git(cwd, &["push", "--progress"], stream.as_ref());
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
            None,
        ),
        _ => json!({ "exitCode": 1, "stdout": "", "stderr": "Unknown git operation" }),
    })
}
