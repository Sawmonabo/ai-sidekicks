//! The live MCP notices every open `mcp.subscribe` feed reads: each kept as its key's newest value,
//! so a reader that falls behind ends on every key's newest notice and nothing queues.

use std::sync::{Arc, Mutex};

use sidekicks_contracts::mcp::event::McpSubscribeEmission;
use sidekicks_contracts::mcp::server::{
    McpServerBindingRef, McpServerConfigChangedNotice, McpServerConfigChangedType,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::registry::HandlerError;
use sidekicks_ipc::stream::latest_value::{KeyedLatestValueFeed, KeyedLatestValueOutlets};
use sidekicks_std::mutex_lock::lock;

use crate::binding::binding_arm;
use crate::binding::store::McpBindingKey;

/// Which notice a key holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum McpNoticeKind {
    /// `mcp.server.status.changed`.
    Status,
    /// `mcp.server.config.changed`.
    ConfigChanged,
}

/// What a notice came from: one leg of a session, the machine probe, or an edit to the binding.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum McpNoticeOrigin {
    /// A session's live leg; its end shares the key, so a reader that falls behind reads the end.
    Leg {
        /// The session.
        session_id: SessionId,
        /// The leg's runtime binding.
        binding_id: RuntimeBindingId,
    },
    /// The daemon's own machine probe.
    Probe,
    /// An edit to the binding.
    Edit,
}

/// What a notice replaces on the board: the newest notice of one kind, for one binding, from one
/// origin. Two same-named project bindings are two keys, and so are two legs of one binding, so no
/// notice replaces another's.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct McpNoticeKey {
    /// Which notice.
    pub(crate) kind: McpNoticeKind,
    /// The binding's whole identity, its folder and distribution included.
    pub(crate) binding: McpBindingKey,
    /// What the notice came from.
    pub(crate) origin: McpNoticeOrigin,
}

/// The detach a feed's place on the board runs when the feed drops.
pub type McpNoticeBoardDetach = Box<dyn FnOnce() + Send>;

/// A feed of the board's notices, each key's newest, from its follow on.
pub type McpNoticeFeed =
    KeyedLatestValueFeed<McpNoticeKey, McpSubscribeEmission, McpNoticeBoardDetach>;

/// The outlets of every open feed of MCP notices. The daemon builds one board and hands it to the
/// status tracker and to the subscribe handlers, each of whose feeds follows it and leaves it when
/// the feed drops.
#[derive(Default)]
pub struct McpNoticeBoard {
    outlets: Mutex<KeyedLatestValueOutlets<McpNoticeKey, McpSubscribeEmission>>,
}

impl McpNoticeBoard {
    /// Opens a feed that receives every notice sent from now on and leaves the board when it
    /// drops. Fails only as the feed's open fails.
    pub async fn follow(self: &Arc<Self>) -> Result<McpNoticeFeed, HandlerError> {
        let board = Arc::clone(self);
        KeyedLatestValueFeed::open(move |outlet| {
            let id = lock(&board.outlets).attach(outlet);
            let detach: McpNoticeBoardDetach = Box::new(move || lock(&board.outlets).detach(id));
            std::future::ready(Ok(detach))
        })
        .await
    }

    /// Sends `emission` under `key` to every attached feed, replacing the one still waiting there
    /// under that key.
    pub(crate) fn send(&self, key: &McpNoticeKey, emission: &McpSubscribeEmission) {
        lock(&self.outlets).send(key, emission);
    }

    /// Sends `mcp.server.config.changed` for `binding`, once an edit to it is committed; a later
    /// edit of the binding replaces the notice still waiting.
    pub(crate) fn send_config_changed(&self, binding: &McpServerBindingRef) {
        let notice_type = McpServerConfigChangedType::Value;
        let notice = binding_arm!(McpServerConfigChangedNotice, binding.clone(), {
            notice_type
        });
        let key = McpNoticeKey {
            kind: McpNoticeKind::ConfigChanged,
            binding: McpBindingKey::of(binding),
            origin: McpNoticeOrigin::Edit,
        };
        self.send(&key, &McpSubscribeEmission::ConfigChanged(notice));
    }
}

#[cfg(any(test, feature = "test-support"))]
impl McpNoticeBoard {
    /// Sends `notice` as the machine probe's status notice of `binding`, under the key the status
    /// tracker sends it by; for the tests of the crates that read the board.
    pub fn send_probe_notice(
        &self,
        binding: &McpServerBindingRef,
        notice: sidekicks_contracts::mcp::governance::McpServerStatusChangedNotice,
    ) {
        let key = McpNoticeKey {
            kind: McpNoticeKind::Status,
            binding: McpBindingKey::of(binding),
            origin: McpNoticeOrigin::Probe,
        };
        self.send(&key, &McpSubscribeEmission::StatusChanged(notice));
    }
}
