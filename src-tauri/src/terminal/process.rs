/// Terminates a process tree where the platform exposes a native system command.
pub(crate) fn kill_process_tree(pid: u32) {
    #[cfg(any(target_os = "macos", target_os = "linux"))]
    {
        let pid = pid.to_string();
        let _ = std::process::Command::new("pkill")
            .args(["-TERM", "-P", &pid])
            .status();
        let _ = std::process::Command::new("kill")
            .args(["-TERM", &pid])
            .status();
    }
    #[cfg(target_os = "windows")]
    {
        let _ = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
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
