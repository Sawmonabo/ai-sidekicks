//! The daemon's program, at the top of the daemon's crates: the start, the jobs on its one
//! scheduler, every IPC handler on the local socket, the data acts, the service log, code
//! highlighting, observability, orchestration, the control-plane credential, Remote Control on this
//! machine, and the helper modes it starts by name. It sits over std, store, ipc, workspace,
//! policy, workflow, provider, shell, session, approval, queue, artifact and recovery.

pub(crate) mod bootstrap;
pub(crate) mod control_plane_credential;
pub mod daemon;
pub(crate) mod data_acts;
pub(crate) mod highlight;
pub(crate) mod ipc;
pub(crate) mod observability;
pub(crate) mod orchestration;
pub mod program;
pub(crate) mod remote;
