//! The method handlers that sit on the socket: a handler's driver found from its run or session,
//! and the approval, artifact, command, highlight, question, repository, run, session, terminal
//! and transcript methods served here.

pub(crate) mod approval;
pub(crate) mod artifact;
pub(crate) mod command;
pub(crate) mod driver;
pub(crate) mod highlight;
pub(crate) mod question;
pub(crate) mod repo;
pub(crate) mod run;
pub(crate) mod session;
pub(crate) mod terminal;
pub(crate) mod transcript;
