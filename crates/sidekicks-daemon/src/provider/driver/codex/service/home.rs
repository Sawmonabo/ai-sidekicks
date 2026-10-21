//! The Codex home one service runs on, and the three kinds of service the daemon keeps there: one
//! it starts as its own child, the lasting one on the person's own Codex folder that terminals
//! join, and one already there that is not the daemon's, which it only joins.

use std::path::PathBuf;

use sidekicks_contracts::provider::account::record::ProviderAccountId;

/// What a Codex home is to the daemon.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's Codex home resolver names each home's kind"
    )
)]
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexHomeKind {
    /// A home the app manages for one of its accounts.
    Account,
    /// The person's own Codex folder; whether terminals started there reach the daemon's service
    /// is the person's switch.
    PersonalFolder {
        /// Whether `Reach Codex sessions started in a terminal` is on.
        is_terminal_reach_on: bool,
    },
}

/// The Codex home one service runs on.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CodexServiceHome {
    /// The home, absolute.
    pub(crate) codex_home: PathBuf,
    /// The account the home belongs to, or `None` for the person's own Codex folder.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// What the home is to the daemon.
    pub(crate) kind: CodexHomeKind,
}

/// Which kind of service a supervisor holds, which decides how it starts, how its end is read and
/// who may stop it. A session's recovery and a conversation's purge read it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexServiceKind {
    /// The daemon's own child, which ends with the daemon and carries no hook switch: on an
    /// account home, and on the person's own folder while terminal reach is off, then on a socket
    /// of its own so no terminal joins it (an inference: off means no terminal joins anything of
    /// the daemon's).
    Account,
    /// The lasting service on the person's own Codex folder that terminals join: started by the
    /// daemon in a session of its own with the daemon's two hooks, kept in its record, outliving a
    /// daemon restart.
    Terminal,
    /// A service on the person's own Codex folder that is not the daemon's: Codex's own managed
    /// daemon while it is in use, or a lasting service answering on the socket whose record this
    /// daemon cannot pin (an inference: a live service the daemon cannot pin is never signaled).
    /// The daemon only connects to it and never stops it.
    Joined,
}

impl CodexServiceKind {
    /// Whether the daemon started the process and so reads its exit as a crash and restarts it.
    pub(crate) const fn is_daemons_own(self) -> bool {
        match self {
            Self::Account | Self::Terminal => true,
            Self::Joined => false,
        }
    }
}
