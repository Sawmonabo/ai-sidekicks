//! The live MCP notices every open `mcp.subscribe` feed reads: each kept as its key's newest value,
//! so a reader that falls behind ends on every key's newest notice and nothing queues.

use std::sync::Mutex;

use sidekicks_contracts::mcp::event::McpSubscribeEmission;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::stream::latest_value::{
    KeyedLatestValueOutlet, KeyedLatestValueOutlets, LatestValueOutletId,
};
use sidekicks_std::mutex_lock::lock;

use crate::binding_store::McpBindingKey;

/// Which notice a key holds.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub(crate) enum McpNoticeKind {
    /// `mcp.server.status.changed`.
    #[cfg_attr(
        not(any(test, feature = "test-support")),
        expect(
            dead_code,
            reason = "the status tracker sends its status notices under it"
        )
    )]
    Status,
    /// `mcp.server.config.changed`.
    #[expect(
        dead_code,
        reason = "the binding edits send their config-changed notices through it"
    )]
    ConfigChanged,
}

/// What a notice came from: one leg of a session, the machine probe, or an edit to the binding.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub(crate) enum McpNoticeOrigin {
    /// A session's live leg; its end shares the key, so a reader that falls behind reads the end.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the status tracker sends each leg's notices under it"
        )
    )]
    Leg {
        /// The session.
        session_id: SessionId,
        /// The leg's runtime binding.
        binding_id: RuntimeBindingId,
    },
    /// The daemon's own machine probe.
    #[cfg_attr(
        not(any(test, feature = "test-support")),
        expect(
            dead_code,
            reason = "the status tracker sends the probe's notices under it"
        )
    )]
    Probe,
    /// An edit to the binding.
    #[expect(
        dead_code,
        reason = "the binding edits send their config-changed notices through it"
    )]
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

/// The outlets of every open `mcp.subscribe` feed. The daemon builds one board and hands it to the
/// status tracker and to the subscribe handler, which attaches each feed's outlet and detaches it
/// when the feed drops.
#[derive(Default)]
pub struct McpNoticeBoard {
    outlets: Mutex<KeyedLatestValueOutlets<McpNoticeKey, McpSubscribeEmission>>,
}

impl McpNoticeBoard {
    /// Keeps a feed's outlet, which receives every notice sent from now on, and answers the id its
    /// detach removes it by.
    pub fn attach(
        &self,
        outlet: KeyedLatestValueOutlet<McpNoticeKey, McpSubscribeEmission>,
    ) -> LatestValueOutletId {
        lock(&self.outlets).attach(outlet)
    }

    /// Drops the outlet `id` names; an id already removed changes nothing.
    pub fn detach(&self, id: LatestValueOutletId) {
        lock(&self.outlets).detach(id);
    }

    /// Sends `emission` under `key` to every attached feed, replacing the one still waiting there
    /// under that key.
    #[cfg_attr(
        not(any(test, feature = "test-support")),
        expect(dead_code, reason = "the status tracker sends its notices through it")
    )]
    pub(crate) fn send(&self, key: &McpNoticeKey, emission: &McpSubscribeEmission) {
        lock(&self.outlets).send(key, emission);
    }
}

#[cfg(any(test, feature = "test-support"))]
impl McpNoticeBoard {
    /// Sends `notice` as the machine probe's status notice of `binding`, under the key the status
    /// core sends it by; for the tests of the crates that read the board.
    pub fn send_probe_notice(
        &self,
        binding: &sidekicks_contracts::mcp::server::McpServerBindingRef,
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
