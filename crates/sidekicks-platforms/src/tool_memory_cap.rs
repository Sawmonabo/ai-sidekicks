//! Whether this system lets the service hold the tool processes to `Memory cap for tool
//! processes`.

/// Whether the service can enforce the tool processes' memory cap here: no on macOS, which offers
/// no per-process memory limit a user process can set, and no on Linux and Windows until their
/// command wrapper runs each command under the system's own limit.
pub const TOOL_MEMORY_CAP_ENFORCEABLE: bool = false;
