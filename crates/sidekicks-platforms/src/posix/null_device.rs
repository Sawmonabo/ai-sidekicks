//! The null device on macOS and Linux.

/// The path of the system's null device, which reads as empty and discards every write.
pub const NULL_DEVICE_PATH: &str = "/dev/null";
