//! `sidekicks-wake-helper`, the macOS root program launchd runs from a property list in
//! `/Library/LaunchDaemons`: it books and cancels the wakes from sleep the console user's service
//! asks for over its socket, and does nothing else. It includes its module and the socket's message
//! file by path rather than linking this crate's library, so a program running as root carries
//! only the power-event calls.
#![warn(dead_code_pub_in_binary)]
#![cfg_attr(
    target_os = "macos",
    expect(
        unsafe_code,
        reason = "the power-event calls (`IOPMSchedulePowerEvent`, \
                  `IOPMCancelScheduledPowerEvent`), the cast of the queue's listing \
                  (`IOPMCopyScheduledPowerEvents`) to its element types and the socket's peer \
                  read (`getpeereid`) are C interfaces"
    )
)]

#[cfg(target_os = "macos")]
#[path = "../wake_helper/message.rs"]
pub mod message;
#[cfg(target_os = "macos")]
#[path = "../macos/wake_helper/program.rs"]
pub mod program;

// The program's module names the message types at `crate::`, where the library's root has them too.
#[cfg(target_os = "macos")]
use message::{WakeRefusal, WakeReply, WakeRequest};

#[cfg(target_os = "macos")]
fn main() -> std::io::Result<()> {
    program::serve_wake_helper()
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
