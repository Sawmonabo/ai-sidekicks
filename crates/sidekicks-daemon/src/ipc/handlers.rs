//! The method handlers that sit on the socket: the agent, approval, artifact, attention, driver,
//! highlight, machine, MCP, presence, project, provider account, question, repository, run,
//! session, terminal, transcript, workspace and worktree methods served here.

pub(crate) mod agent;
pub(crate) mod approval;
pub(crate) mod artifact;
pub(crate) mod attention;
pub(crate) mod driver;
pub(crate) mod highlight;
pub(crate) mod machine;
pub(crate) mod mcp;
pub(crate) mod presence;
pub(crate) mod project;
#[expect(dead_code, reason = "bound by the provider account table block")]
pub(crate) mod provider_account;
pub(crate) mod question;
pub(crate) mod repo;
pub(crate) mod run;
pub(crate) mod session;
pub(crate) mod terminal;
pub(crate) mod transcript;
pub(crate) mod workspace;
pub(crate) mod worktree;
