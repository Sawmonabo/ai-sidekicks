//! The daemon's program, at the top of the daemon's crates: the start, the jobs on its one
//! scheduler, every IPC handler on the local socket, the agent tools' handlers, the data acts, the
//! service log, code highlighting, the planning transcript a hand-off writes, observability,
//! orchestration, the control-plane credential, Remote Control on this machine, the helper modes it
//! starts by name, the redial a provider's hook makes to a daemon that is away, and the price list
//! seed the build vendored. It sits over std, store, ipc, workspace, policy, workflow, provider,
//! shell, session, approval, queue, artifact and recovery.

#[expect(
    dead_code,
    reason = "the agent tool server's executor, which calls each tool's handler"
)]
pub(crate) mod agent_tools;
pub(crate) mod bootstrap;
pub(crate) mod control_plane_credential;
pub mod daemon;
pub(crate) mod data_acts;
pub(crate) mod hand_over;
pub(crate) mod highlight;
pub(crate) mod ipc;
pub(crate) mod observability;
pub(crate) mod orchestration;
pub(crate) mod plan_verdict;
pub(crate) mod price_list_seed;
pub mod program;
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the hook provider mode, which dials the daemon through it"
    )
)]
pub(crate) mod provider_hook_redial;
pub(crate) mod remote;
