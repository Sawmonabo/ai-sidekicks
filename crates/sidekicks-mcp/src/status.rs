//! MCP server status: each binding's status folded from the live legs that report it and the
//! machine probe's newest reading, the live notice each change sends on `mcp.subscribe`, and each
//! binding's first observation in this process, handed on to be recorded.

mod legs;
pub mod notices;

use std::sync::{Arc, Mutex};

use sidekicks_contracts::error::ERROR_MESSAGE_MAX_LEN;
use sidekicks_contracts::mcp::event::McpSubscribeEmission;
use sidekicks_contracts::mcp::governance::{
    McpServerStatusChangedNotice, McpServerStatusChangedType,
};
use sidekicks_contracts::mcp::server::inventory::McpServerLegStatus;
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerName, McpServerStatus};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::redaction::sanitize_failure_reason;
use sidekicks_ipc::stream::latest_value::KeyedLatestValueOutlet;
use sidekicks_provider::driver::mcp_server_status::{
    McpServerStatusEmission, McpServerStatusUpdate,
};
use sidekicks_std::mutex_lock::lock;

use self::legs::{ChangeOrigin, LegId, McpLegs, StatusChange};
use self::notices::{McpNoticeBoard, McpNoticeKey, McpNoticeKind, McpNoticeOrigin};
use crate::binding_store::McpBindingKey;

/// A binding's status as the inventory reads it.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the inventory reads each binding's status through it"
    )
)]
pub(crate) struct McpBindingStatusReading {
    /// The most severe status among the legs in the aggregate, else the machine probe's newest
    /// reading, else `unknown`.
    pub(crate) status: McpServerStatus,
    /// Each leg in the aggregate; a switched-off leg is not among them.
    pub(crate) legs: Vec<McpServerLegStatus>,
    /// When the newest leg in the aggregate, else the probe, observed it.
    pub(crate) observed_at: Option<WireInstant>,
}

/// The one keeper of every binding's MCP status. Its state sits behind one lock that is never held
/// across an await: each call applies its change and sends its notice synchronously, so a reader
/// of the board sees changes in the order they were applied.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the producer wiring, the session-close and driver-exit retires, the machine \
                  probe and the inventory call it"
    )
)]
pub(crate) struct McpServerStatusCore {
    legs: Mutex<McpLegs>,
    board: Arc<McpNoticeBoard>,
    first_observations: KeyedLatestValueOutlet<McpBindingKey, McpServerBindingRef>,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the producer wiring, the session-close and driver-exit retires, the machine \
                  probe and the inventory call it"
    )
)]
impl McpServerStatusCore {
    /// A core with no leg, sending its status notices on `board` and each binding's ref, once at
    /// its first observation in this process, through `first_observations`.
    pub(crate) fn new(
        board: Arc<McpNoticeBoard>,
        first_observations: KeyedLatestValueOutlet<McpBindingKey, McpServerBindingRef>,
    ) -> Self {
        Self {
            legs: Mutex::new(McpLegs::new()),
            board,
            first_observations,
        }
    }

    /// Opens a sink for the leg `binding_id` of `session_id`, the one its producer reports
    /// through; a leg may hold several.
    pub(crate) fn open_leg(
        self: &Arc<Self>,
        session_id: SessionId,
        binding_id: RuntimeBindingId,
    ) -> McpLegStatusSink {
        let leg = LegId {
            session_id,
            binding_id,
        };
        lock(&self.legs).open_sink(leg.clone());
        McpLegStatusSink {
            core: Arc::clone(self),
            leg,
        }
    }

    /// Applies one server's reading from a leg, `binding` being the effective binding the leg
    /// serves the server from. A reading for a retired leg changes nothing.
    pub(crate) fn observe(&self, binding: &McpServerBindingRef, update: McpServerStatusUpdate) {
        let observed_at = WireInstant::now();
        let mut legs = lock(&self.legs);
        let outcome = legs.observe(binding, update, observed_at);
        if let Some(first) = outcome.first_observation {
            self.first_observations
                .send(McpBindingKey::of(&first), first);
        }
        for change in outcome.changes {
            self.send(change);
        }
    }

    /// Retires the leg `binding_id` of `session_id`, at its session's close or its driver's exit:
    /// its servers leave the aggregate, each touched binding sends `sessionEnded`, and what the leg
    /// reports later is ignored.
    pub(crate) fn retire_leg(&self, session_id: SessionId, binding_id: RuntimeBindingId) {
        let leg = LegId {
            session_id,
            binding_id,
        };
        let mut legs = lock(&self.legs);
        for change in legs.retire(&leg) {
            self.send(change);
        }
    }

    /// Stores the machine probe's newest reading of `binding`, which stands for the binding while
    /// no live leg holds a status; a `machineProbe` notice goes out when the aggregate changed.
    pub(crate) fn record_probe(
        &self,
        binding: &McpServerBindingRef,
        status: McpServerStatus,
        failure_text: Option<String>,
    ) {
        let observed_at = WireInstant::now();
        let mut legs = lock(&self.legs);
        if let Some(change) = legs.record_probe(binding, status, failure_text, observed_at) {
            self.send(change);
        }
    }

    /// The status of the binding `binding` keys.
    pub(crate) fn reading(&self, binding: &McpBindingKey) -> McpBindingStatusReading {
        lock(&self.legs).reading(binding)
    }

    /// How many legs are remembered, retired ones included.
    #[cfg(test)]
    fn leg_count(&self) -> usize {
        lock(&self.legs).leg_count()
    }

    /// Sends `change` as its status notice; called under the state lock, so notices leave in the
    /// order their changes were applied. The failure reason is the deciding source's text,
    /// sanitized, and only on a `failed` status.
    fn send(&self, change: StatusChange) {
        let StatusChange {
            binding_key,
            binding,
            origin,
            previous_status,
            status,
            failure_text,
        } = change;
        let (provider, server_name) = provider_and_server_name(&binding);
        let scope = binding_key.scope;
        let failure_reason = failure_text
            .filter(|_| status == McpServerStatus::Failed)
            .map(|text| sanitize_failure_reason(&text, ERROR_MESSAGE_MAX_LEN));
        let notice_type = McpServerStatusChangedType::Value;
        let (notice, notice_origin) = match origin {
            ChangeOrigin::SessionFeed(leg) => (
                McpServerStatusChangedNotice::SessionFeed {
                    notice_type,
                    provider,
                    scope,
                    server_name,
                    previous_status,
                    status,
                    failure_reason,
                    session_id: leg.session_id,
                    binding_id: leg.binding_id.clone(),
                },
                McpNoticeOrigin::Leg {
                    session_id: leg.session_id,
                    binding_id: leg.binding_id,
                },
            ),
            ChangeOrigin::SessionEnded(leg) => (
                McpServerStatusChangedNotice::SessionEnded {
                    notice_type,
                    provider,
                    scope,
                    server_name,
                    previous_status,
                    status,
                    failure_reason,
                    session_id: leg.session_id,
                    binding_id: leg.binding_id.clone(),
                },
                McpNoticeOrigin::Leg {
                    session_id: leg.session_id,
                    binding_id: leg.binding_id,
                },
            ),
            ChangeOrigin::MachineProbe => (
                McpServerStatusChangedNotice::MachineProbe {
                    notice_type,
                    provider,
                    scope,
                    server_name,
                    previous_status,
                    status,
                    failure_reason,
                    session_id: None,
                    binding_id: None,
                },
                McpNoticeOrigin::Probe,
            ),
        };
        let key = McpNoticeKey {
            kind: McpNoticeKind::Status,
            binding: binding_key,
            origin: notice_origin,
        };
        self.board
            .send(&key, &McpSubscribeEmission::StatusChanged(notice));
    }
}

/// What one leg's producer reports through. A retired leg is remembered while any of its sinks is
/// open, so a late reading is ignored, and forgotten when its last sink drops, so memory stays
/// bounded by the legs that can still report.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the producer each leg is spawned with reports through it"
    )
)]
pub(crate) struct McpLegStatusSink {
    core: Arc<McpServerStatusCore>,
    leg: LegId,
}

impl McpLegStatusSink {
    /// Applies a driver's emission for this leg, `binding` being the effective binding the leg
    /// serves the server from.
    #[expect(
        dead_code,
        reason = "the producer each leg is spawned with reports through it"
    )]
    pub(crate) fn observe(&self, binding: &McpServerBindingRef, emission: McpServerStatusEmission) {
        self.core.observe(
            binding,
            McpServerStatusUpdate::new(self.leg.session_id, self.leg.binding_id.clone(), emission),
        );
    }
}

impl Drop for McpLegStatusSink {
    fn drop(&mut self) {
        lock(&self.core.legs).close_sink(&self.leg);
    }
}

/// The provider and the server's name `binding` names.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status core sends a notice per change")
)]
fn provider_and_server_name(binding: &McpServerBindingRef) -> (ProviderId, McpServerName) {
    match binding {
        McpServerBindingRef::User {
            provider,
            server_name,
        }
        | McpServerBindingRef::Project {
            provider,
            server_name,
            ..
        }
        | McpServerBindingRef::Local {
            provider,
            server_name,
            ..
        }
        | McpServerBindingRef::Plugin {
            provider,
            server_name,
            ..
        }
        | McpServerBindingRef::Connector {
            provider,
            server_name,
            ..
        }
        | McpServerBindingRef::Managed {
            provider,
            server_name,
        } => (provider.clone(), server_name.clone()),
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use futures::FutureExt as _;
    use rstest::rstest;
    use sidekicks_contracts::mcp::server::McpServerStatus::{
        Connected, Failed, NeedsAuth, Starting, Unknown,
    };
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_ipc::stream::feed::{CreditGate, Feed as _};
    use sidekicks_ipc::stream::latest_value::KeyedLatestValueFeed;
    use sidekicks_provider::driver::mcp_server_status::McpServerReading;

    use super::*;

    /// One call on the core, legs named by their runtime binding id.
    enum Step {
        /// Opens one more sink for the leg.
        Open(&'static str),
        /// The leg reports the server, with the provider's error text.
        Observe(&'static str, McpServerReading, Option<&'static str>),
        /// Retires the leg.
        Retire(&'static str),
        /// Drops the leg's newest open sink.
        DropSink(&'static str),
        /// The machine probe reads the server.
        Probe(McpServerStatus),
    }

    fn observe(leg: &'static str, status: McpServerStatus) -> Step {
        Step::Observe(leg, McpServerReading::Observed(status), None)
    }

    fn switch_off(leg: &'static str) -> Step {
        Step::Observe(leg, McpServerReading::SwitchedOff, None)
    }

    /// What a notice says, its leg named by its runtime binding id.
    #[derive(Debug, PartialEq, Eq)]
    enum Origin {
        Feed(String),
        Ended(String),
        Probe,
    }

    #[derive(Debug, PartialEq, Eq)]
    struct Notice {
        origin: Origin,
        previous_status: McpServerStatus,
        status: McpServerStatus,
        failure_reason: Option<String>,
    }

    fn feed(leg: &str, previous_status: McpServerStatus, status: McpServerStatus) -> Notice {
        Notice {
            origin: Origin::Feed(leg.to_owned()),
            previous_status,
            status,
            failure_reason: None,
        }
    }

    fn ended(leg: &str, previous_status: McpServerStatus, status: McpServerStatus) -> Notice {
        Notice {
            origin: Origin::Ended(leg.to_owned()),
            previous_status,
            status,
            failure_reason: None,
        }
    }

    fn probe(previous_status: McpServerStatus, status: McpServerStatus) -> Notice {
        Notice {
            origin: Origin::Probe,
            previous_status,
            status,
            failure_reason: None,
        }
    }

    fn read_notice(notice: McpServerStatusChangedNotice) -> Notice {
        let (origin, previous_status, status, failure_reason) = match notice {
            McpServerStatusChangedNotice::SessionFeed {
                binding_id,
                previous_status,
                status,
                failure_reason,
                ..
            } => (
                Origin::Feed(binding_id.as_str().to_owned()),
                previous_status,
                status,
                failure_reason,
            ),
            McpServerStatusChangedNotice::SessionEnded {
                binding_id,
                previous_status,
                status,
                failure_reason,
                ..
            } => (
                Origin::Ended(binding_id.as_str().to_owned()),
                previous_status,
                status,
                failure_reason,
            ),
            McpServerStatusChangedNotice::MachineProbe {
                previous_status,
                status,
                failure_reason,
                ..
            } => (Origin::Probe, previous_status, status, failure_reason),
        };
        Notice {
            origin,
            previous_status,
            status,
            failure_reason,
        }
    }

    // Each case's comment names the mistake it catches.
    #[rstest]
    // A notice per observation: the unchanged re-observation would send one.
    #[case::a_first_observation_and_a_change_notify_and_a_repeat_does_not(
        vec![Step::Open("leg-a"), observe("leg-a", Connected), observe("leg-a", Connected),
             observe("leg-a", Failed)],
        vec![feed("leg-a", Unknown, Connected), feed("leg-a", Connected, Failed)],
        Failed, 1, 1,
    )]
    // A reordered severity: `starting` over `unknown` keeps `starting` at the second leg, and
    // `needsAuth` over `failed` keeps `needsAuth` at the fourth.
    #[case::the_most_severe_leg_holds_the_aggregate(
        vec![Step::Open("leg-a"), Step::Open("leg-b"), Step::Open("leg-c"), Step::Open("leg-d"),
             observe("leg-a", Starting), observe("leg-b", Unknown), observe("leg-c", NeedsAuth),
             observe("leg-d", Failed)],
        vec![feed("leg-a", Unknown, Starting), feed("leg-b", Starting, Unknown),
             feed("leg-c", Unknown, NeedsAuth), feed("leg-d", NeedsAuth, Failed)],
        Failed, 4, 4,
    )]
    // A skipped retire: the closed session's failed leg would still hold the aggregate.
    #[case::a_retired_leg_leaves_the_aggregate_with_a_session_ended_notice(
        vec![Step::Open("leg-a"), Step::Open("leg-b"), observe("leg-a", Failed),
             observe("leg-b", Connected), Step::Retire("leg-a")],
        vec![feed("leg-a", Unknown, Failed), feed("leg-b", Failed, Failed),
             ended("leg-a", Failed, Connected)],
        Connected, 1, 2,
    )]
    // A late observation accepted after the retire would send a notice and read `failed`.
    #[case::a_late_observation_after_the_retire_is_ignored(
        vec![Step::Open("leg-a"), observe("leg-a", Connected), Step::Retire("leg-a"),
             observe("leg-a", Failed)],
        vec![feed("leg-a", Unknown, Connected), ended("leg-a", Connected, Unknown)],
        Unknown, 0, 1,
    )]
    // `SwitchedOff` held in the aggregate: the switched-off failed leg would keep it `failed`.
    #[case::a_switched_off_leg_leaves_the_aggregate_until_it_reports_again(
        vec![Step::Open("leg-a"), Step::Open("leg-b"), observe("leg-a", Failed),
             observe("leg-b", Connected), switch_off("leg-a"), observe("leg-a", Failed),
             switch_off("leg-b")],
        vec![feed("leg-a", Unknown, Failed), feed("leg-b", Failed, Failed),
             feed("leg-a", Failed, Connected), feed("leg-a", Connected, Failed)],
        Failed, 1, 2,
    )]
    // A probe reading used beside a live leg would send a `needsAuth` probe notice.
    #[case::a_probe_reading_stands_only_while_no_live_leg_holds_a_status(
        vec![Step::Probe(Failed), Step::Open("leg-a"), observe("leg-a", Connected),
             Step::Probe(NeedsAuth), Step::Retire("leg-a")],
        vec![probe(Unknown, Failed), feed("leg-a", Failed, Connected),
             ended("leg-a", Connected, NeedsAuth)],
        NeedsAuth, 0, 1,
    )]
    // The retired mark kept after the last sink dropped would leave the leg in the map; dropped
    // at the first sink, a late observation would be accepted.
    #[case::a_retired_leg_is_remembered_until_its_last_sink_drops(
        vec![Step::Open("leg-a"), Step::Open("leg-a"), Step::Retire("leg-a"),
             observe("leg-a", Connected), Step::DropSink("leg-a"), observe("leg-a", Connected),
             Step::DropSink("leg-a")],
        vec![],
        Unknown, 0, 0,
    )]
    // A retire after every sink dropped would otherwise remember the leg for good.
    #[case::a_retire_after_the_sinks_dropped_forgets_the_leg_at_once(
        vec![Step::Open("leg-a"), observe("leg-a", Connected), Step::DropSink("leg-a"),
             Step::Retire("leg-a")],
        vec![feed("leg-a", Unknown, Connected), ended("leg-a", Connected, Unknown)],
        Unknown, 0, 0,
    )]
    // The raw text would put the path on the wire; a reason on a status not `failed` is dropped.
    #[case::a_failure_reason_leaves_redacted_and_only_on_failed(
        vec![Step::Open("leg-a"),
             Step::Observe("leg-a", McpServerReading::Observed(Failed),
                           Some("spawn /Users/someone/servers/docs failed")),
             Step::Observe("leg-a", McpServerReading::Observed(Connected),
                           Some("/Users/someone/servers/docs"))],
        vec![Notice { failure_reason: Some("spawn <redacted-path> failed".to_owned()),
                      ..feed("leg-a", Unknown, Failed) },
             feed("leg-a", Failed, Connected)],
        Connected, 1, 1,
    )]
    #[tokio::test]
    async fn the_core_folds_each_leg_and_notifies_each_change(
        #[case] steps: Vec<Step>,
        #[case] expected_notices: Vec<Notice>,
        #[case] expected_status: McpServerStatus,
        #[case] expected_reading_legs: usize,
        #[case] expected_remembered_legs: usize,
    ) {
        let binding = McpServerBindingRef::User {
            provider: ProviderId::new("provider-a".to_owned()).expect("a provider id"),
            server_name: McpServerName::new("docs".to_owned()).expect("a server name"),
        };
        let board = Arc::new(McpNoticeBoard::default());
        let subscriber_board = Arc::clone(&board);
        let mut subscriber = KeyedLatestValueFeed::open(move |outlet| {
            let id = subscriber_board.attach(outlet);
            std::future::ready(Ok(move || subscriber_board.detach(id)))
        })
        .await
        .expect("the board's follow succeeds");
        let mut first_observations = None;
        let _first_observation_feed = KeyedLatestValueFeed::open(|outlet| {
            first_observations = Some(outlet);
            std::future::ready(Ok(|| {}))
        })
        .await
        .expect("the follow succeeds");
        let core = Arc::new(McpServerStatusCore::new(
            Arc::clone(&board),
            first_observations.expect("the follow kept the outlet"),
        ));
        let gate = CreditGate::with_credit(1);

        let mut sessions: HashMap<&str, SessionId> = HashMap::new();
        let mut sinks: HashMap<&str, Vec<McpLegStatusSink>> = HashMap::new();
        let mut notices = Vec::new();
        for step in steps {
            let mut leg_of = |name: &'static str| {
                let session_id = *sessions.entry(name).or_insert_with(|| {
                    SessionId::try_from(mint_uuid_v7()).expect("a minted UUID is a session id")
                });
                let binding_id = RuntimeBindingId::new(name.to_owned()).expect("a binding id");
                (session_id, binding_id)
            };
            match step {
                Step::Open(name) => {
                    let (session_id, binding_id) = leg_of(name);
                    sinks
                        .entry(name)
                        .or_default()
                        .push(core.open_leg(session_id, binding_id));
                }
                Step::Observe(name, reading, failure_text) => {
                    let (session_id, binding_id) = leg_of(name);
                    core.observe(
                        &binding,
                        McpServerStatusUpdate {
                            session_id,
                            binding_id,
                            server_name: McpServerName::new("docs".to_owned())
                                .expect("a server name"),
                            reading,
                            failure_text: failure_text.map(str::to_owned),
                        },
                    );
                }
                Step::Retire(name) => {
                    let (session_id, binding_id) = leg_of(name);
                    core.retire_leg(session_id, binding_id);
                }
                Step::DropSink(name) => {
                    let sink = sinks
                        .get_mut(name)
                        .and_then(Vec::pop)
                        .expect("the case opened a sink");
                    drop(sink);
                }
                Step::Probe(status) => core.record_probe(&binding, status, None),
            }
            // Read after each step, so each notice is seen before a later one under its key
            // replaces it.
            while let Some(read) = subscriber.next(&gate).now_or_never() {
                let Some(emission) = read.expect("the board never fails") else {
                    break;
                };
                let notice = match emission {
                    McpSubscribeEmission::StatusChanged(notice) => Some(notice),
                    McpSubscribeEmission::ConfigChanged(_)
                    | McpSubscribeEmission::GovernanceEvent(_) => None,
                }
                .expect("the core sends only status notices");
                notices.push(read_notice(notice));
            }
        }

        assert_eq!(notices, expected_notices);
        let reading = core.reading(&McpBindingKey::of(&binding));
        assert_eq!(reading.status, expected_status);
        assert_eq!(reading.legs.len(), expected_reading_legs);
        // Only a binding nothing has observed reads with no instant.
        assert_eq!(
            reading.observed_at.is_none(),
            expected_status == Unknown && expected_reading_legs == 0
        );
        assert_eq!(core.leg_count(), expected_remembered_legs);
    }
}
