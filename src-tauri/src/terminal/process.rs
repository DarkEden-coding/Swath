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
