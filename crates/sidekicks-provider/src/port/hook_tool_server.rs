//! The tools on the daemon's hooks entry, which a provider calls for the hook rows the daemon gave
//! its conversation and its model never sees. The driver that composed the rows lists the tools
//! and answers each call; the shared tool server only carries the call to it.

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use tokio_util::sync::CancellationToken;

/// One tool on the hooks entry, as its listing shows it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct HookTool {
    /// The tool's name, which the hook row names.
    pub name: &'static str,
    /// What the tool answers, for the listing.
    pub description: &'static str,
}

/// One call the provider made for a hook row: the tool, its arguments as the provider filled them
/// from the row's template, and the call's `_meta`, empty when it carries none.
#[derive(Clone, Debug)]
pub struct HookToolCall {
    /// The tool called.
    pub tool_name: String,
    /// The call's `arguments` object.
    pub arguments: Map<String, Value>,
    /// The call's `_meta` object.
    pub meta: Map<String, Value>,
}

/// How a hook tool call is answered.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum HookToolAnswer {
    /// The text the provider reads as the hook's output; empty for no decision.
    Answered(String),
    /// The call was canceled before an answer, so none is sent.
    Canceled,
    /// The entry has no tool of the call's name.
    NoSuchTool,
}

/// The tools of one spawn's hooks entry and their answers.
pub trait HookToolServer: Send + Sync {
    /// The tools the entry lists.
    fn tools(&self) -> &'static [HookTool];

    /// Answers `call`. `token` is the call's own, canceled once its caller stopped waiting, and a
    /// call held past it answers [`HookToolAnswer::Canceled`].
    fn answer<'a>(
        &'a self,
        call: HookToolCall,
        token: &'a CancellationToken,
    ) -> BoxFuture<'a, HookToolAnswer>;
}
