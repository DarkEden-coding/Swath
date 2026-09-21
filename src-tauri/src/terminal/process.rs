/// Terminates a process tree where the platform exposes a native system command.
pub(crate) fn kill_process_tree(pid: u32) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        // portable-pty starts each PTY child with `setsid`, making its PID the process-group
        // leader.  Signalling the group reaches shells, wrappers, and grandchildren; `pkill -P`
        // only reaches direct children and leaves dev servers below a shell alive.
        let group = format!("-{pid}");
        let group_signalled = process_group_leader(pid)
            && std::process::Command::new("kill")
                .args(["-TERM", "--", &group])
                .status()
                .map(|status| status.success())
                .unwrap_or(false);

        // Pi processes and callers outside portable-pty may not own a process group.  Fall back
        // to a recursive, deepest-first walk in that case rather than reverting to one level.
        if !group_signalled {
            let mut descendants = Vec::new();
            collect_descendants(pid, &mut descendants);
            for child in descendants {
                signal_process(child);
            }
        }
        signal_process(pid);
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
    }
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn signal_process(pid: u32) {
    let _ = std::process::Command::new("kill")
        .args(["-TERM", &pid.to_string()])
        .status();
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn process_group_leader(pid: u32) -> bool {
    std::process::Command::new("ps")
        .args(["-o", "pgid=", "-p", &pid.to_string()])
        .output()
        .map(|output| {
            output.status.success()
                && String::from_utf8_lossy(&output.stdout)
                    .trim()
                    .parse::<u32>()
                    .ok()
                    == Some(pid)
        })
        .unwrap_or(false)
}

#[cfg(any(target_os = "macos", target_os = "linux"))]
fn collect_descendants(pid: u32, descendants: &mut Vec<u32>) {
    let pid_text = pid.to_string();
    let Ok(output) = std::process::Command::new("pgrep")
        .args(["-P", &pid_text])
        .output()
    else {
        return;
    };
    if !output.status.success() {
        return;
    }
    for child in String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| line.trim().parse::<u32>().ok())
    {
        collect_descendants(child, descendants);
        descendants.push(child);
    }
}

/// Reports whether the shell process currently has a child process.
pub(super) fn has_child_processes(pid: u32) -> bool {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let pid_text = pid.to_string();
        if let Ok(output) = std::process::Command::new("pgrep")
            .args(["-P", &pid_text])
            .output()
        {
            if output.status.success() && !String::from_utf8_lossy(&output.stdout).trim().is_empty()
            {
                return true;
            }
        }
        if let Ok(output) = std::process::Command::new("ps")
            .args(["-A", "-o", "ppid="])
            .output()
        {
            return String::from_utf8_lossy(&output.stdout)
                .lines()
                .any(|line| line.trim() == pid_text);
        }
        false
    }
    #[cfg(target_os = "windows")]
    {
        let query = format!("Get-CimInstance Win32_Process | Where-Object {{$_.ParentProcessId -eq {pid}}} | Select-Object -First 1 -ExpandProperty ProcessId");
        std::process::Command::new("powershell.exe")
            .args(["-NoProfile", "-Command", &query])
            .output()
            .map(|output| {
                output.status.success()
                    && !String::from_utf8_lossy(&output.stdout).trim().is_empty()
            })
            .unwrap_or(false)
    }
    #[cfg(not(any(target_os = "macos", target_os = "linux", target_os = "windows")))]
    {
        false
    }
}
