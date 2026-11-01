//! `sidekicks-wake-helper`, the macOS root program launchd runs from a property list in
//! `/Library/LaunchDaemons`: it books and cancels the wakes from sleep the console user's service
//! asks for over its socket, and does nothing else. It includes its one module by path rather than
//! linking this crate's library, so a program running as root carries only the power-event calls.
#![warn(dead_code_pub_in_binary)]
#![cfg_attr(
    target_os = "macos",
    expect(
        unsafe_code,
        reason = "the power-event calls (`IOPMSchedulePowerEvent`, \
                  `IOPMCancelScheduledPowerEvent`) and the socket's peer read (`getpeereid`) are \
                  C interfaces"
    )
)]

#[cfg(target_os = "macos")]
#[path = "../macos/wake_helper.rs"]
pub mod wake_helper;

#[cfg(target_os = "macos")]
fn main() -> std::io::Result<()> {
    wake_helper::serve_wake_helper()
}

// Linux books its wakes through a systemd timer and Windows needs no helper, so the program has
// nothing to run there.
#[cfg(not(target_os = "macos"))]
fn main() -> std::io::Result<()> {
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "the wake helper runs only on macOS",
    ))
}
