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
use sidekicks_contracts::mcp::server::{McpServerBindingRef, McpServerStatus};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_ipc::redaction::sanitize_failure_reason;
use sidekicks_ipc::stream::latest_value::KeyedLatestValueOutlet;
use sidekicks_provider::driver::mcp_server_status::{
    McpServerStatusEmission, McpServerStatusUpdate,
};
use sidekicks_std::mutex_lock::lock;

use self::legs::{ChangeOrigin, LegId, McpLegs, ObservationOutcome, StatusChange};
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
pub(crate) struct McpServerStatusTracker {
    legs: Mutex<McpLegs>,
    board: Arc<McpNoticeBoard>,
    /// Each binding a leg reports a status of or the probe reads, for the drain to record; the
    /// drain keeps which bindings it has recorded, so one whose write failed is tried again at its
    /// next reading.
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
impl McpServerStatusTracker {
    /// A tracker with no leg, sending its status notices on `board` and the ref of each binding a
    /// leg reports a status of or the probe reads through `first_observations`, whose drain
    /// records it.
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
            tracker: Arc::clone(self),
            leg,
        }
    }

    /// Applies one server's reading from a leg, `binding` being the effective binding the leg
    /// serves the server from. A reading for a retired leg changes nothing.
    fn observe(&self, binding: &McpServerBindingRef, update: McpServerStatusUpdate) {
        let observed_at = WireInstant::now();
        let mut legs = lock(&self.legs);
        let outcome = legs.observe(binding, update, observed_at);
        self.apply(outcome);
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
    /// no live leg holds a status; a `machineProbe` notice goes out when the probe's own reading
    /// changed, and the binding goes to the drain as a leg's reading does.
    pub(crate) fn record_probe(
        &self,
        binding: &McpServerBindingRef,
        status: McpServerStatus,
        failure_text: Option<String>,
    ) {
        let observed_at = WireInstant::now();
        let mut legs = lock(&self.legs);
        let outcome = legs.record_probe(binding, status, failure_text, observed_at);
        self.apply(outcome);
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

    /// Hands the reading's binding to the drain and sends its changes; called under the state
    /// lock, so notices leave in the order their changes were applied.
    fn apply(&self, outcome: ObservationOutcome) {
        if let Some(binding) = outcome.observed_binding {
            self.first_observations
                .send(McpBindingKey::of(&binding), binding);
        }
        for change in outcome.changes {
            self.send(change);
        }
    }

    /// Sends `change` as its status notice; called under the state lock, so notices leave in the
    /// order their changes were applied. The failure reason is the deciding source's text,
    /// sanitized, and only on a `failed` status.
    fn send(&self, change: StatusChange) {
        let StatusChange {
            binding_key,
            origin,
            previous_status,
            status,
            failure_text,
        } = change;
        let provider = binding_key.provider.clone();
        let server_name = binding_key.server_name.clone();
        let scope = binding_key.scope;
        let server_binding_id = binding_key.server_binding_id();
        let failure_reason = failure_text
            .filter(|_| status == McpServerStatus::Failed)
            .map(|text| sanitize_failure_reason(&text, ERROR_MESSAGE_MAX_LEN));
        let notice_type = McpServerStatusChangedType::Value;
        let (notice, notice_origin) = match origin {
            ChangeOrigin::SessionFeed { leg, observed_at } => (
                McpServerStatusChangedNotice::SessionFeed {
                    notice_type,
                    provider,
                    scope,
                    server_name,
                    server_binding_id,
                    previous_status,
                    status,
                    failure_reason,
                    session_id: leg.session_id,
                    binding_id: leg.binding_id.clone(),
                    observed_at,
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
                    server_binding_id,
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
                    server_binding_id,
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
    tracker: Arc<McpServerStatusTracker>,
    leg: LegId,
}

impl McpLegStatusSink {
    /// Applies a driver's emission for this leg, `binding` being the effective binding the leg
    /// serves the server from.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the producer each leg is spawned with reports through it"
        )
    )]
    pub(crate) fn observe(&self, binding: &McpServerBindingRef, emission: McpServerStatusEmission) {
        self.tracker.observe(
            binding,
            McpServerStatusUpdate::new(self.leg.session_id, self.leg.binding_id.clone(), emission),
        );
    }
}

impl Drop for McpLegStatusSink {
    fn drop(&mut self) {
        lock(&self.tracker.legs).close_sink(&self.leg);
    }
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use futures::FutureExt as _;
    use rstest::rstest;
    use sidekicks_contracts::mcp::server::McpBindingScope::{self, Managed, User};
    use sidekicks_contracts::mcp::server::McpServerStatus::{
        Connected, Failed, NeedsAuth, Starting, Unknown,
    };
    use sidekicks_contracts::mcp::server::{McpServerBindingId, McpServerName};
    use sidekicks_contracts::provider::id::ProviderId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_ipc::stream::feed::{CreditGate, Feed};
    use sidekicks_ipc::stream::latest_value::KeyedLatestValueFeed;
    use sidekicks_provider::driver::mcp_server_status::McpServerReading;

    use super::*;

    /// One call on the tracker, legs named by their runtime binding id.
    enum Step {
        /// Opens one more sink for the leg.
        Open(&'static str),
        /// The leg reports the server from the binding of that scope, through its newest sink,
        /// with the provider's error text.
        Observe(
            &'static str,
            McpBindingScope,
            McpServerReading,
            Option<&'static str>,
        ),
        /// Retires the leg.
        Retire(&'static str),
        /// Drops the leg's newest open sink.
        DropSink(&'static str),
        /// The machine probe reads the server from the `user` binding.
        Probe(McpServerStatus),
    }

    fn observe(leg: &'static str, status: McpServerStatus) -> Step {
        Step::Observe(leg, User, McpServerReading::Observed(status), None)
    }

    fn switch_off(leg: &'static str) -> Step {
        Step::Observe(leg, User, McpServerReading::SwitchedOff, None)
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
        scope: McpBindingScope,
        origin: Origin,
        previous_status: McpServerStatus,
        status: McpServerStatus,
        failure_reason: Option<String>,
    }

    fn notice(origin: Origin, previous_status: McpServerStatus, status: McpServerStatus) -> Notice {
        Notice {
            scope: User,
            origin,
            previous_status,
            status,
            failure_reason: None,
        }
    }

    fn feed(leg: &str, previous_status: McpServerStatus, status: McpServerStatus) -> Notice {
        notice(Origin::Feed(leg.to_owned()), previous_status, status)
    }

    fn ended(leg: &str, previous_status: McpServerStatus, status: McpServerStatus) -> Notice {
        notice(Origin::Ended(leg.to_owned()), previous_status, status)
    }

    fn probe(previous_status: McpServerStatus, status: McpServerStatus) -> Notice {
        notice(Origin::Probe, previous_status, status)
    }

    fn read_notice(notice: McpServerStatusChangedNotice) -> Notice {
        let (scope, origin, previous_status, status, failure_reason) = match notice {
            McpServerStatusChangedNotice::SessionFeed {
                scope,
                binding_id,
                previous_status,
                status,
                failure_reason,
                ..
            } => (
                scope,
                Origin::Feed(binding_id.as_str().to_owned()),
                previous_status,
                status,
                failure_reason,
            ),
            McpServerStatusChangedNotice::SessionEnded {
                scope,
                binding_id,
                previous_status,
                status,
                failure_reason,
                ..
            } => (
                scope,
                Origin::Ended(binding_id.as_str().to_owned()),
                previous_status,
                status,
                failure_reason,
            ),
            McpServerStatusChangedNotice::MachineProbe {
                scope,
                previous_status,
                status,
                failure_reason,
                ..
            } => (
                scope,
                Origin::Probe,
                previous_status,
                status,
                failure_reason,
            ),
        };
        Notice {
            scope,
            origin,
            previous_status,
            status,
            failure_reason,
        }
    }

    /// A tracker over a fresh board, with a feed reading the board's notices and the feed its
    /// first observations go to, which is kept open so the tracker can hand bindings to it.
    async fn tracker_and_subscriber() -> (
        Arc<McpServerStatusTracker>,
        impl Feed<Emission = McpSubscribeEmission>,
        impl Feed<Emission = McpServerBindingRef>,
    ) {
        let board = Arc::new(McpNoticeBoard::default());
        let subscriber_board = Arc::clone(&board);
        let subscriber = KeyedLatestValueFeed::open(move |outlet| {
            let id = subscriber_board.attach(outlet);
            std::future::ready(Ok(move || subscriber_board.detach(id)))
        })
        .await
        .expect("the board's follow succeeds");
        let mut first_observations = None;
        let first_observation_feed = KeyedLatestValueFeed::open(|outlet| {
            first_observations = Some(outlet);
            std::future::ready(Ok(|| {}))
        })
        .await
        .expect("the follow succeeds");
        let tracker = Arc::new(McpServerStatusTracker::new(
            board,
            first_observations.expect("the follow kept the outlet"),
        ));
        (tracker, subscriber, first_observation_feed)
    }

    /// The status notices waiting on `subscriber`, in the order it reads them.
    fn waiting_notices(
        subscriber: &mut impl Feed<Emission = McpSubscribeEmission>,
    ) -> Vec<McpServerStatusChangedNotice> {
        let gate = CreditGate::with_credit(1);
        let mut notices = Vec::new();
        while let Some(read) = subscriber.next(&gate).now_or_never() {
            let Some(emission) = read.expect("the board never fails") else {
                break;
            };
            let notice = match emission {
                McpSubscribeEmission::StatusChanged(notice) => Some(notice),
                McpSubscribeEmission::ConfigChanged(_)
                | McpSubscribeEmission::GovernanceEvent(_) => None,
            }
            .expect("the tracker sends only status notices");
            notices.push(notice);
        }
        notices
    }

    /// Two project bindings sharing a provider, scope and name in two roots: each notice carries
    /// its own binding's id, so a page places it on that binding's row. Killed by the id hashed
    /// from the provider, scope and name alone.
    #[tokio::test]
    async fn a_notice_carries_the_id_of_its_own_binding() {
        let (tracker, mut subscriber, _first_observation_feed) = tracker_and_subscriber().await;
        let bindings = ["/work/one", "/work/two"].map(|root| {
            serde_json::from_value::<McpServerBindingRef>(serde_json::json!({
                "provider": "provider-a",
                "scope": "project",
                "scopeRef": root,
                "serverName": "github",
            }))
            .expect("the test writes a binding ref")
        });

        tracker.record_probe(&bindings[0], Failed, None);
        tracker.record_probe(&bindings[1], Connected, None);

        let ids: Vec<McpServerBindingId> = waiting_notices(&mut subscriber)
            .into_iter()
            .map(|notice| match notice {
                McpServerStatusChangedNotice::MachineProbe {
                    server_binding_id, ..
                } => server_binding_id,
                McpServerStatusChangedNotice::SessionFeed { .. }
                | McpServerStatusChangedNotice::SessionEnded { .. } => {
                    panic!("the probe sends only probe notices")
                }
            })
            .collect();
        let expected: Vec<McpServerBindingId> = bindings
            .iter()
            .map(|binding| McpBindingKey::of(binding).server_binding_id())
            .collect();
        assert_eq!(ids, expected);
        assert_ne!(ids[0], ids[1]);
    }

    // Each case's comment names the mistake it catches. A `sessionFeed` notice carries its leg's
    // own statuses; a `sessionEnded` one the binding's aggregate before and after the leg left.
    #[rstest]
    // A notice per observation: the unchanged re-observation would send one.
    #[case::a_first_observation_and_a_change_notify_and_a_repeat_does_not(
        vec![Step::Open("leg-a"), observe("leg-a", Connected), observe("leg-a", Connected),
             observe("leg-a", Failed)],
        vec![feed("leg-a", Unknown, Connected), feed("leg-a", Connected, Failed)],
        Failed, 1, 1,
    )]
    // A reordered severity: `needsAuth` over `failed` would read `needsAuth` before the first
    // retire, and `starting` over `unknown` would read `starting` after the second.
    #[case::the_most_severe_leg_holds_the_aggregate(
        vec![Step::Open("leg-a"), Step::Open("leg-b"), Step::Open("leg-c"), Step::Open("leg-d"),
             observe("leg-a", Starting), observe("leg-b", Unknown), observe("leg-c", NeedsAuth),
             observe("leg-d", Failed), Step::Retire("leg-d"), Step::Retire("leg-c")],
        vec![feed("leg-a", Unknown, Starting), feed("leg-b", Unknown, Unknown),
             feed("leg-c", Unknown, NeedsAuth), feed("leg-d", Unknown, Failed),
             ended("leg-d", Failed, NeedsAuth), ended("leg-c", NeedsAuth, Unknown)],
        Unknown, 2, 4,
    )]
    // A skipped retire: the closed session's failed leg would still hold the aggregate.
    #[case::a_retired_leg_leaves_the_aggregate_with_a_session_ended_notice(
        vec![Step::Open("leg-a"), Step::Open("leg-b"), observe("leg-a", Failed),
             observe("leg-b", Connected), Step::Retire("leg-a")],
        vec![feed("leg-a", Unknown, Failed), feed("leg-b", Unknown, Connected),
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
    // `SwitchedOff` held in the aggregate: the switched-off failed leg would keep it `failed` when
    // the other leg ends. With nothing sent at the switch-off, a page would keep the leg's line
    // beside the live leg. The rejoin left silent: the leg's same status again would send nothing,
    // so a page that dropped its line at the switch-off would not get it back. A leg already out
    // of the aggregate taken out again: a repeated switch-off, or a retire while switched off,
    // would send a second `sessionEnded`.
    #[case::a_switched_off_leg_leaves_the_aggregate_with_a_session_ended_notice(
        vec![Step::Open("leg-a"), Step::Open("leg-b"), observe("leg-a", Failed),
             observe("leg-b", Connected), switch_off("leg-a"), switch_off("leg-a"),
             Step::Retire("leg-b"), observe("leg-a", Failed), switch_off("leg-a"),
             Step::Retire("leg-a")],
        vec![feed("leg-a", Unknown, Failed), feed("leg-b", Unknown, Connected),
             ended("leg-a", Failed, Connected), ended("leg-b", Connected, Unknown),
             feed("leg-a", Unknown, Failed), ended("leg-a", Failed, Unknown)],
        Unknown, 0, 2,
    )]
    // A probe reading used beside a live leg would make the aggregate `needsAuth` before the
    // retire.
    #[case::a_probe_reading_stands_only_while_no_live_leg_holds_a_status(
        vec![Step::Probe(Failed), Step::Open("leg-a"), observe("leg-a", Connected),
             Step::Probe(NeedsAuth), Step::Retire("leg-a")],
        vec![probe(Unknown, Failed), feed("leg-a", Unknown, Connected), probe(Failed, NeedsAuth),
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
             Step::Observe("leg-a", User, McpServerReading::Observed(Failed),
                           Some("spawn /Users/someone/servers/docs failed")),
             Step::Observe("leg-a", User, McpServerReading::Observed(Connected),
                           Some("/Users/someone/servers/docs"))],
        vec![Notice { failure_reason: Some("spawn <redacted-path> failed".to_owned()),
                      ..feed("leg-a", Unknown, Failed) },
             feed("leg-a", Failed, Connected)],
        Connected, 1, 1,
    )]
    // A leg that now serves the name from another binding leaves the old one: without the
    // `sessionEnded`, a page would keep the leg's line on the old binding, here where the old
    // aggregate stays `failed`.
    #[case::a_leg_moved_to_another_binding_ends_on_the_old_one(
        vec![Step::Open("leg-a"), Step::Open("leg-b"), observe("leg-a", Connected),
             observe("leg-b", Failed),
             Step::Observe("leg-a", Managed, McpServerReading::Observed(Connected), None)],
        vec![feed("leg-a", Unknown, Connected), feed("leg-b", Unknown, Failed),
             ended("leg-a", Failed, Failed),
             Notice { scope: Managed, ..feed("leg-a", Unknown, Connected) }],
        Failed, 1, 2,
    )]
    #[tokio::test]
    async fn the_tracker_folds_each_leg_and_notifies_each_change(
        #[case] steps: Vec<Step>,
        #[case] expected_notices: Vec<Notice>,
        #[case] expected_status: McpServerStatus,
        #[case] expected_reading_legs: usize,
        #[case] expected_remembered_legs: usize,
    ) {
        let provider = ProviderId::new("provider-a".to_owned()).expect("a provider id");
        let server_name = McpServerName::new("docs".to_owned()).expect("a server name");
        let binding = McpServerBindingRef::User {
            provider: provider.clone(),
            server_name: server_name.clone(),
        };
        let managed_binding = McpServerBindingRef::Managed {
            provider,
            server_name: server_name.clone(),
        };
        let (tracker, mut subscriber, _first_observation_feed) = tracker_and_subscriber().await;

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
                        .push(tracker.open_leg(session_id, binding_id));
                }
                Step::Observe(name, scope, reading, failure_text) => {
                    let observed_binding = match scope {
                        Managed => &managed_binding,
                        _ => &binding,
                    };
                    sinks
                        .get(name)
                        .and_then(|leg_sinks| leg_sinks.last())
                        .expect("the case opened a sink")
                        .observe(
                            observed_binding,
                            McpServerStatusEmission::new(
                                server_name.clone(),
                                reading,
                                failure_text.map(str::to_owned),
                            ),
                        );
                }
                Step::Retire(name) => {
                    let (session_id, binding_id) = leg_of(name);
                    tracker.retire_leg(session_id, binding_id);
                }
                Step::DropSink(name) => {
                    let sink = sinks
                        .get_mut(name)
                        .and_then(Vec::pop)
                        .expect("the case opened a sink");
                    drop(sink);
                }
                Step::Probe(status) => tracker.record_probe(&binding, status, None),
            }
            // Read after each step, so each notice is seen before a later one under its key
            // replaces it.
            notices.extend(
                waiting_notices(&mut subscriber)
                    .into_iter()
                    .map(read_notice),
            );
        }

        assert_eq!(notices, expected_notices);
        let reading = tracker.reading(&McpBindingKey::of(&binding));
        assert_eq!(reading.status, expected_status);
        assert_eq!(reading.legs.len(), expected_reading_legs);
        // Only a binding nothing has observed reads with no instant.
        assert_eq!(
            reading.observed_at.is_none(),
            expected_status == Unknown && expected_reading_legs == 0
        );
        assert_eq!(tracker.leg_count(), expected_remembered_legs);
    }
}
