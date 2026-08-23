#![cfg_attr(
    all(target_os = "windows", not(debug_assertions)),
    windows_subsystem = "windows"
)]

fn main() {
    #[cfg(target_os = "linux")]
    apply_linux_webkit_graphics_workaround();
    swath_lib::run();
}

/// WebKitGTK's DMABUF renderer crashes on NVIDIA + Wayland with GDK error 71.
#[cfg(target_os = "linux")]
fn apply_linux_webkit_graphics_workaround() {
    if std::env::var_os("WEBKIT_DISABLE_DMABUF_RENDERER").is_some() {
        return;
    }
    if !has_nvidia_gpu() {
        return;
    }
    std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
}

#[cfg(target_os = "linux")]
fn has_nvidia_gpu() -> bool {
    const NVIDIA_PCI_VENDOR: &str = "0x10de";
    let Ok(entries) = std::fs::read_dir("/sys/class/drm") else {
        return false;
    };
    entries.filter_map(Result::ok).any(|entry| {
        std::fs::read_to_string(entry.path().join("device/vendor"))
            .is_ok_and(|vendor| vendor.trim().eq_ignore_ascii_case(NVIDIA_PCI_VENDOR))
    })
}
