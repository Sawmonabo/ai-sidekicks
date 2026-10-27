//! What a short control-only Claude Code process reports: the model catalog and context window a
//! catalog read takes, and the command replies, reply-reserve reads and context reads a session's
//! creation-time read takes. Each reply is relayed as Claude Code sent it, and the module that
//! derives a figure from it reads only the members it needs.

use std::path::PathBuf;

use serde_json::value::RawValue;

/// Where a control-only process reading a session's figures starts: the session's own folder,
/// environment and model, so the project's and the person's own styles are among those it lists
/// and its context reads describe that model, at the session's endpoint.
#[derive(Clone, Debug)]
pub(crate) struct ClaudeSessionFolderReadRequest {
    /// The process's whole environment.
    pub(crate) spawn_environment: Vec<(String, String)>,
    /// The session's working folder, absolute.
    pub(crate) working_directory: PathBuf,
    /// The model the figures are read for, passed as `--model`.
    pub(crate) model: String,
}

/// What one control-only process reported about the models: its `initialize` reply, whose
/// `models` is the catalog, and its `get_context_usage` reply for the model it ran on, where it
/// answered one.
#[derive(Debug)]
pub(crate) struct ClaudeModelCatalogReading {
    /// The `initialize` reply.
    pub(crate) initialize: Option<Box<RawValue>>,
    /// The `get_context_usage` reply.
    pub(crate) context_usage: Option<Box<RawValue>>,
}

/// One `get_context_usage` reply a control-only process gave with no window key set; `usage` is
/// `None` where Claude Code refused the move to the model or the read.
#[derive(Debug)]
pub(crate) struct ClaudeModelContextRead {
    /// The model the process was started on or moved to; `None` for the account's default.
    pub(crate) requested_model: Option<String>,
    /// The reply.
    pub(crate) usage: Option<Box<RawValue>>,
}

/// What one command typed with no argument printed in a control-only process.
#[derive(Debug)]
pub(crate) struct ClaudeLocalCommandReply {
    /// Whether that process's `initialize` reply lists the command.
    pub(crate) is_listed: bool,
    /// The text of the command's `result`, where it carried one.
    pub(crate) text: Option<String>,
    /// The outcome Claude Code stamped on its reply (`unavailable_headless`, `unknown`, …), as
    /// sent, where it stamped one.
    pub(crate) outcome: Option<String>,
}

/// The two `get_context_usage` replies a reply reserve is derived from, as Claude Code sent them:
/// the first with only the window key set, the second with the maximum-output key added; or the
/// request Claude Code refused on the way, with its words.
#[derive(Debug)]
pub(crate) enum ClaudeReplyReserveReads {
    /// Both reads were answered.
    Read {
        /// The reply with only the window key set.
        window_only: Option<Box<RawValue>>,
        /// The reply with the maximum-output key added.
        with_maximum_output: Option<Box<RawValue>>,
    },
    /// Claude Code refused a request on the way.
    Refused {
        /// Its words.
        detail: String,
    },
}

/// What the control-only process a session's creation runs reported: what `/output-style` and
/// `/advisor` printed typed with no argument, with the style names its `initialize` reply gave,
/// the two context reads the reply reserve comes from, and the context reads of its own model and
/// of each catalog model it was not told to skip.
#[derive(Debug)]
pub(crate) struct ClaudeCreationFiguresReading {
    /// The style names the `initialize` reply gave.
    pub(crate) output_style_names: Vec<String>,
    /// What `/output-style` printed.
    pub(crate) output_style: ClaudeLocalCommandReply,
    /// What `/advisor` printed.
    pub(crate) advisor: ClaudeLocalCommandReply,
    /// The reply reserve's two reads.
    pub(crate) reply_reserve_reads: ClaudeReplyReserveReads,
    /// The context reads.
    pub(crate) context_reads: Vec<ClaudeModelContextRead>,
}
