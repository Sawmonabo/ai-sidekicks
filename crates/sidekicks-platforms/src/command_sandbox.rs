//! Whether the system offers the kernel sandbox a provider's commands run under.

/// Whether the running system offers the kernel sandbox a provider's commands run under: macOS
/// (Seatbelt) and Linux (namespaces) do, Windows does not. The WSL server answers for its
/// distribution, since it is a Linux build.
pub const fn has_command_sandbox() -> bool {
    cfg!(any(target_os = "macos", target_os = "linux"))
}
