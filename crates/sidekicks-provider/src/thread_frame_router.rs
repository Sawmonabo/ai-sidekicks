//! Decides which inbound provider frames project into the session transcript.
//!
//! A provider multiplexes child-thread traffic (subagent, review and compaction threads) over the
//! connection that carries the session's own thread. Projecting every frame would render a child's
//! output in the parent's transcript and double-count or lose the child's spend, so each session
//! routes every inbound frame through its one router before normalizing, and only the session's
//! own thread projects.
//!
//! A thread-scoped family routes by the thread identity on the frame; a connection- or
//! account-scoped family (retry notices, rate limits, the capability and initialization frames)
//! routes without one, because its shape has none; an unrecognized family is quarantined, since an
//! unlisted shape is never presumed connection-scoped.
//!
//! A thread identity is recognized by registration only, never by arrival order: the session's
//! own thread at establishment, a thread the session moved off that is held while a command of it
//! still runs, or a child announced with a provider-declared parent.
//!
//! Two bounded held states differ in meaning. A pending-registration hold keeps a frame naming a
//! present but unregistered thread (child traffic racing its announcement); it is released when
//! the registration lands and shed with a diagnostic on timeout. The quarantine keeps a frame with
//! no identity where its family needs one, or naming a thread no registration admits; it is a
//! capped diagnostic buffer, oldest shed first, not a delivery queue.
//!
//! Two carve-outs apply ahead of suppression: a child's spend is metered though its content is
//! not (to its subagent, or to the parent run for an internal child with no subagent identity),
//! and a child's approval, permission and input requests use the parent run's pipeline, answered
//! on the child's own correlation identity, since suppressing them would hang the child.
//! Suppression covers only a child's transcript projection; its lifecycle reaches the transcript
//! through `agent.subagent.started` and `agent.subagent.completed`.

use std::collections::{HashMap, HashSet, VecDeque};
use std::time::Duration;

use serde_json::{Map, Value};
use sidekicks_contracts::provider::id::ProviderId;
use tokio::time::Instant;

use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, OnceReportedDiagnostics, emit_driver_diagnostic,
};

/// The capability a thread-scoped frame carries, which selects its carve-out: `Usage` and
/// `InteractiveRequest` are carved out ahead of suppression, while a child's `Lifecycle` and
/// `Content` are kept out of the session transcript.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ThreadScopedFrameCapability {
    /// A usage reading.
    Usage,
    /// An approval, permission or input request.
    InteractiveRequest,
    /// A turn or thread lifecycle frame.
    Lifecycle,
    /// Transcript content.
    Content,
}

/// One frame's family as the driver classified it; the router decides. `Unknown` is a real arm,
/// because an unlisted family is never presumed connection-scoped.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ThreadFrameFamilyClass {
    /// A connection- or account-scoped family, which carries no thread identity.
    Connection,
    /// A thread-scoped family.
    Thread {
        /// What the frame carries.
        capability: ThreadScopedFrameCapability,
    },
    /// A family the driver does not list.
    Unknown,
}

/// One inbound frame as the router sees it; each driver's frame type states how it reads these
/// from its own wire.
pub(crate) trait RoutableProviderFrame {
    /// The frame's wire kind, verbatim and untrusted; carried as data only.
    fn raw_wire_type(&self) -> &str;

    /// The frame's family.
    fn family_class(&self) -> ThreadFrameFamilyClass;

    /// The thread identity read from the frame, or `None` when it carries none.
    fn thread_id(&self) -> Option<&str>;
}

/// How a registered child's usage attributes: to its subagent, or to the parent run.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ChildSpendAttribution {
    /// To the subagent the provider named.
    Subagent {
        /// The provider-attributed subagent identity.
        subagent_id: String,
    },
    /// To the parent run, for an internal child such as a compaction thread.
    ParentRun,
}

/// A child-thread announcement carrying the parent the provider declared, as the driver read it.
#[derive(Clone, Debug, PartialEq, Eq)]
#[expect(
    clippy::struct_field_names,
    reason = "each member is an id, named for what it identifies"
)]
pub(crate) struct ChildThreadAnnouncement {
    /// The child's thread identity.
    pub(crate) child_thread_id: String,
    /// The parent the provider itself declared, or `None` when it named none.
    pub(crate) declared_parent_thread_id: Option<String>,
    /// The provider-attributed subagent identity, or `None` for an internal child such as a
    /// compaction thread, whose spend attributes to the parent run.
    pub(crate) subagent_id: Option<String>,
}

/// The result of admitting one child announcement.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ChildRegistrationResult<Frame> {
    /// The child is registered.
    Registered {
        /// The child's thread identity.
        child_thread_id: String,
        /// Where its spend attributes.
        attribution: ChildSpendAttribution,
        /// The frames held pending this registration, in arrival order, for the caller to route
        /// again.
        released_frames: Vec<Frame>,
    },
    /// The announcement named no recognized parent; a diagnostic was emitted.
    Refused,
}

/// Which `subagent` lifecycle event a driver states for a child.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SubagentLifecycleEventType {
    /// `agent.subagent.started`, when the child registers.
    Started,
    /// `agent.subagent.completed`, when the child completes.
    Completed,
}

/// An `agent.subagent.started` or `agent.subagent.completed` emission a driver states when a child
/// registers or completes; the emission pipeline mints its event. These two are the child's only
/// transcript presence, since its own frames are kept out of the transcript.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct SubagentLifecycleEmission {
    /// Which event.
    pub(crate) event_type: SubagentLifecycleEventType,
    /// The provider-attributed subagent identity, verbatim off the wire.
    pub(crate) subagent_id: String,
    /// The tool call the provider opened the subagent under, verbatim, where it names one.
    pub(crate) parent_tool_call_id: Option<String>,
}

/// The one routing decision for a frame, which the terminal-emission gate consumes unchanged.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ThreadFrameRoute {
    /// The session's own thread: project into the session transcript.
    Project,
    /// A known connection- or account-scoped family: route without identity.
    RouteConnectionScoped,
    /// A registered child's usage frame: meter under the stated attribution.
    CarveOutUsage {
        /// The child's thread identity.
        child_thread_id: String,
        /// Where its spend attributes.
        attribution: ChildSpendAttribution,
    },
    /// A registered child's interactive request: the parent's pipeline, the child's identity.
    CarveOutInteractiveRequest {
        /// The child's thread identity.
        child_thread_id: String,
    },
    /// A registered child's content or lifecycle frame: the driver writes it on the child's run.
    ChildTranscript {
        /// The child's thread identity.
        child_thread_id: String,
    },
    /// A present but unregistered identity: held awaiting its announcement.
    HeldPendingRegistration,
    /// An absent or unrecognized identity, or an unrecognized family: refused with a diagnostic.
    Quarantined,
}

/// The caps and timeout that bound the router's two held states.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ThreadFrameRouterConfig {
    /// How many quarantined frames are kept before the oldest is shed.
    pub(crate) max_quarantined_frames: usize,
    /// How many frames may wait for a registration before the oldest is shed.
    pub(crate) max_pending_hold_frames: usize,
    /// How long a frame waits for its thread's registration.
    pub(crate) pending_registration_timeout: Duration,
}

/// A frame held for its thread's registration, with when it arrived.
struct PendingHold<Frame> {
    frame: Frame,
    held_at: Instant,
}

/// What the quarantine keeps of a frame: only what its shed diagnostic names.
struct QuarantinedFrame {
    raw_wire_type: String,
    thread_id: Option<String>,
}

/// Holds the thread registry for one session and makes the routing decision for each frame.
pub(crate) struct ThreadFrameRouter<Frame> {
    /// The provider its diagnostics name.
    provider: ProviderId,
    /// The bounds on the held states.
    config: ThreadFrameRouterConfig,
    /// The session's own thread, once established.
    session_thread_id: Option<String>,
    /// Threads the session moved off while a command of each still runs.
    held_thread_ids: HashSet<String>,
    /// Each registered child's spend attribution, by its thread identity.
    child_attributions_by_thread_id: HashMap<String, ChildSpendAttribution>,
    /// Frames waiting for their thread's registration, in arrival order.
    pending_holds: VecDeque<PendingHold<Frame>>,
    /// The quarantine, oldest first.
    quarantined_frames: VecDeque<QuarantinedFrame>,
    /// The families quarantined so far, each reported once.
    quarantine_reports: OnceReportedDiagnostics,
}

impl<Frame: RoutableProviderFrame + Clone> ThreadFrameRouter<Frame> {
    /// An empty router for one session of `provider`, its held states bounded by `config`.
    pub(crate) fn new(provider: ProviderId, config: ThreadFrameRouterConfig) -> Self {
        Self {
            provider,
            config,
            session_thread_id: None,
            held_thread_ids: HashSet::new(),
            child_attributions_by_thread_id: HashMap::new(),
            pending_holds: VecDeque::new(),
            quarantined_frames: VecDeque::new(),
            quarantine_reports: OnceReportedDiagnostics::default(),
        }
    }

    /// Registers the session's own thread at establishment and returns the frames held pending
    /// it, in arrival order. Session traffic can arrive before its identity is known, so the
    /// caller routes the returned frames again; dropping them loses session traffic for good.
    pub(crate) fn register_session_thread(&mut self, thread_id: String) -> Vec<Frame> {
        let released_frames = self.take_pending_holds_for(&thread_id);
        self.session_thread_id = Some(thread_id);
        released_frames
    }

    /// Admits a thread the session moved off while a command of it still runs, so that command's
    /// frames project as the session's own until [`Self::release_held_thread`].
    pub(crate) fn admit_held_thread(&mut self, thread_id: String) {
        self.held_thread_ids.insert(thread_id);
    }

    /// Stops admitting a held thread once the session let it go.
    pub(crate) fn release_held_thread(&mut self, thread_id: &str) {
        self.held_thread_ids.remove(thread_id);
    }

    /// Admits a child announcement whose declared parent is the session's own thread or a
    /// registered child, returning the frames held pending the child in arrival order for the
    /// caller to route again. Any other announcement is refused with a diagnostic.
    pub(crate) fn register_child_thread(
        &mut self,
        announcement: ChildThreadAnnouncement,
    ) -> ChildRegistrationResult<Frame> {
        let ChildThreadAnnouncement {
            child_thread_id,
            declared_parent_thread_id,
            subagent_id,
        } = announcement;
        let is_parent_recognized = declared_parent_thread_id.as_ref().is_some_and(|parent| {
            self.session_thread_id.as_ref() == Some(parent)
                || self.child_attributions_by_thread_id.contains_key(parent)
        });
        if !is_parent_recognized {
            self.emit(
                DriverDiagnosticKind::ThreadRegistrationRefused,
                None,
                "child announcement carries no recognized parent linkage; recognition derives \
                 from the provider's declared lineage, never from arrival order",
                [
                    ("childThreadId", Value::from(child_thread_id)),
                    (
                        "declaredParentThreadId",
                        Value::from(declared_parent_thread_id),
                    ),
                ],
            );
            return ChildRegistrationResult::Refused;
        }

        let attribution = match subagent_id {
            Some(subagent_id) => ChildSpendAttribution::Subagent { subagent_id },
            None => ChildSpendAttribution::ParentRun,
        };
        self.child_attributions_by_thread_id
            .insert(child_thread_id.clone(), attribution.clone());
        ChildRegistrationResult::Registered {
            released_frames: self.take_pending_holds_for(&child_thread_id),
            child_thread_id,
            attribution,
        }
    }

    /// The registered attribution for one child thread, if it is registered.
    pub(crate) fn child_attribution_for(
        &self,
        child_thread_id: &str,
    ) -> Option<&ChildSpendAttribution> {
        self.child_attributions_by_thread_id.get(child_thread_id)
    }

    /// Releases a completed child thread's state, so the registry does not grow with every child
    /// a long session starts, and sheds with a diagnostic each frame still held pending it.
    /// Completion is terminal for the identity: a later frame naming it waits again and ends in
    /// the timeout shed. Answers whether the child was registered.
    pub(crate) fn complete_child_thread(&mut self, child_thread_id: &str) -> bool {
        let was_registered = self
            .child_attributions_by_thread_id
            .remove(child_thread_id)
            .is_some();
        for abandoned_frame in self.take_pending_holds_for(child_thread_id) {
            self.emit(
                DriverDiagnosticKind::ThreadPendingHoldShed,
                Some(abandoned_frame.raw_wire_type()),
                "child thread completed while frames were still held pending its registration; \
                 shed with a recorded diagnostic rather than dropped",
                [
                    ("threadId", Value::from(abandoned_frame.thread_id())),
                    ("childThreadId", Value::from(child_thread_id)),
                ],
            );
        }
        was_registered
    }

    /// Routes one inbound frame arriving at `now`; the one decision both normalizers consult
    /// before projecting. A held frame is kept as a copy, so the caller keeps its own.
    pub(crate) fn route_frame(&mut self, frame: &Frame, now: Instant) -> ThreadFrameRoute {
        self.expire_pending_holds(now);

        let capability = match frame.family_class() {
            ThreadFrameFamilyClass::Connection => return ThreadFrameRoute::RouteConnectionScoped,
            ThreadFrameFamilyClass::Unknown => {
                return self.quarantine(
                    frame,
                    "unrecognized family; the pinned census is the discriminator and an unlisted \
                     shape is never presumed connection-scoped",
                );
            }
            ThreadFrameFamilyClass::Thread { capability } => capability,
        };
        let Some(thread_id) = frame.thread_id() else {
            return self.quarantine(
                frame,
                "thread-scoped frame family carrying no thread identity; refused fail-closed \
                 rather than projected into the session's own thread",
            );
        };

        if self.session_thread_id.as_deref() == Some(thread_id)
            || self.held_thread_ids.contains(thread_id)
        {
            return ThreadFrameRoute::Project;
        }

        if let Some(attribution) = self.child_attributions_by_thread_id.get(thread_id) {
            let child_thread_id = thread_id.to_owned();
            return match capability {
                ThreadScopedFrameCapability::Usage => ThreadFrameRoute::CarveOutUsage {
                    child_thread_id,
                    attribution: attribution.clone(),
                },
                ThreadScopedFrameCapability::InteractiveRequest => {
                    ThreadFrameRoute::CarveOutInteractiveRequest { child_thread_id }
                }
                ThreadScopedFrameCapability::Lifecycle | ThreadScopedFrameCapability::Content => {
                    ThreadFrameRoute::ChildTranscript { child_thread_id }
                }
            };
        }

        // Present but unregistered: child traffic racing its own announcement.
        self.pending_holds.push_back(PendingHold {
            frame: frame.clone(),
            held_at: now,
        });
        if self.pending_holds.len() > self.config.max_pending_hold_frames
            && let Some(shed_hold) = self.pending_holds.pop_front()
        {
            self.emit(
                DriverDiagnosticKind::ThreadPendingHoldShed,
                Some(shed_hold.frame.raw_wire_type()),
                "pending-registration hold exceeded its declared cap; oldest entry shed per the \
                 bounded-hold rule",
                [
                    ("threadId", Value::from(shed_hold.frame.thread_id())),
                    (
                        "maxPendingHoldFrames",
                        Value::from(self.config.max_pending_hold_frames),
                    ),
                ],
            );
        }
        ThreadFrameRoute::HeldPendingRegistration
    }

    /// Sheds the pending holds held for the registration timeout or longer at `now`, each with a
    /// diagnostic.
    fn expire_pending_holds(&mut self, now: Instant) {
        let timeout = self.config.pending_registration_timeout;
        // Holds are pushed in arrival order, so the expired ones are the oldest.
        while let Some(held) = self
            .pending_holds
            .pop_front_if(|held| now.saturating_duration_since(held.held_at) >= timeout)
        {
            let held_for = now.saturating_duration_since(held.held_at);
            self.emit(
                DriverDiagnosticKind::ThreadPendingHoldShed,
                Some(held.frame.raw_wire_type()),
                "pending-registration hold timed out before the parent-linked announcement \
                 landed; shed with a recorded diagnostic",
                [
                    ("threadId", Value::from(held.frame.thread_id())),
                    (
                        "heldForMs",
                        Value::from(u64::try_from(held_for.as_millis()).unwrap_or(u64::MAX)),
                    ),
                    (
                        "pendingRegistrationTimeoutMs",
                        Value::from(u64::try_from(timeout.as_millis()).unwrap_or(u64::MAX)),
                    ),
                ],
            );
        }
    }

    /// Removes and returns the holds naming `thread_id`, in arrival order; the one release path.
    fn take_pending_holds_for(&mut self, thread_id: &str) -> Vec<Frame> {
        let (taken, kept): (VecDeque<_>, VecDeque<_>) = std::mem::take(&mut self.pending_holds)
            .into_iter()
            .partition(|held| held.frame.thread_id() == Some(thread_id));
        self.pending_holds = kept;
        taken.into_iter().map(|held| held.frame).collect()
    }

    // Quarantines `frame`, reporting the first of its family and the first shed of each family;
    // one the build sends every turn would otherwise log on every frame.
    fn quarantine(&mut self, frame: &Frame, reason: &str) -> ThreadFrameRoute {
        let record = self.record(
            DriverDiagnosticKind::ThreadFrameQuarantined,
            Some(frame.raw_wire_type()),
            reason,
            [("threadId", Value::from(frame.thread_id()))],
        );
        self.quarantine_reports.report(&record);
        self.quarantined_frames.push_back(QuarantinedFrame {
            raw_wire_type: frame.raw_wire_type().to_owned(),
            thread_id: frame.thread_id().map(str::to_owned),
        });
        if self.quarantined_frames.len() > self.config.max_quarantined_frames
            && let Some(shed_frame) = self.quarantined_frames.pop_front()
        {
            let record = self.record(
                DriverDiagnosticKind::ThreadQuarantineShed,
                Some(shed_frame.raw_wire_type.as_str()),
                "quarantine buffer exceeded its declared cap; oldest entry shed (a diagnostic \
                 buffer, not a delivery queue)",
                [
                    ("threadId", Value::from(shed_frame.thread_id)),
                    (
                        "maxQuarantinedFrames",
                        Value::from(self.config.max_quarantined_frames),
                    ),
                ],
            );
            self.quarantine_reports.report(&record);
        }
        ThreadFrameRoute::Quarantined
    }

    fn emit<const FIELDS: usize>(
        &self,
        kind: DriverDiagnosticKind,
        raw_wire_type: Option<&str>,
        disposition_reason: &str,
        details: [(&str, Value); FIELDS],
    ) {
        emit_driver_diagnostic(&self.record(kind, raw_wire_type, disposition_reason, details));
    }

    fn record<const FIELDS: usize>(
        &self,
        kind: DriverDiagnosticKind,
        raw_wire_type: Option<&str>,
        disposition_reason: &str,
        details: [(&str, Value); FIELDS],
    ) -> DriverDiagnosticRecord {
        DriverDiagnosticRecord {
            provider: self.provider.clone(),
            provider_account_id: None,
            kind,
            raw_wire_type: raw_wire_type.map(str::to_owned),
            disposition_reason: disposition_reason.to_owned(),
            details: details
                .into_iter()
                .map(|(name, value)| (name.to_owned(), value))
                .collect::<Map<String, Value>>(),
        }
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use rstest::rstest;
    use tokio::time::Instant;

    use super::{
        ChildRegistrationResult, ChildSpendAttribution, ChildThreadAnnouncement,
        RoutableProviderFrame, ThreadFrameFamilyClass, ThreadFrameRoute, ThreadFrameRouter,
        ThreadFrameRouterConfig, ThreadScopedFrameCapability,
    };
    use crate::driver::diagnostics::RecordedEvents;
    use crate::driver::registry::test_provider;

    const PENDING_REGISTRATION_TIMEOUT: Duration = Duration::from_secs(5);

    #[derive(Clone, Debug, PartialEq, Eq)]
    struct TestFrame {
        raw_wire_type: String,
        family_class: ThreadFrameFamilyClass,
        thread_id: Option<String>,
    }

    impl RoutableProviderFrame for TestFrame {
        fn raw_wire_type(&self) -> &str {
            &self.raw_wire_type
        }

        fn family_class(&self) -> ThreadFrameFamilyClass {
            self.family_class
        }

        fn thread_id(&self) -> Option<&str> {
            self.thread_id.as_deref()
        }
    }

    fn content_on(thread_id: &str, raw_wire_type: &str) -> TestFrame {
        TestFrame {
            raw_wire_type: raw_wire_type.to_owned(),
            family_class: ThreadFrameFamilyClass::Thread {
                capability: ThreadScopedFrameCapability::Content,
            },
            thread_id: Some(thread_id.to_owned()),
        }
    }

    fn router_for_session() -> ThreadFrameRouter<TestFrame> {
        let mut router = ThreadFrameRouter::new(
            test_provider(),
            ThreadFrameRouterConfig {
                max_quarantined_frames: 2,
                max_pending_hold_frames: 8,
                pending_registration_timeout: PENDING_REGISTRATION_TIMEOUT,
            },
        );
        router.register_session_thread("session".to_owned());
        router
    }

    fn child_of_session() -> ChildThreadAnnouncement {
        ChildThreadAnnouncement {
            child_thread_id: "child".to_owned(),
            declared_parent_thread_id: Some("session".to_owned()),
            subagent_id: Some("helper".to_owned()),
        }
    }

    /// A frame for an unregistered child is held until the child registers, and shed with a
    /// diagnostic once it waited out the timeout.
    #[rstest]
    #[case::registered_in_time(Duration::from_secs(1), Some(vec!["early"]))]
    #[case::registered_too_late(PENDING_REGISTRATION_TIMEOUT, None)]
    fn a_pending_hold_releases_on_registration_or_sheds_on_timeout(
        #[case] registered_after: Duration,
        #[case] released: Option<Vec<&str>>,
    ) {
        let recorded = RecordedEvents::default();
        let mut registration = None;
        recorded.record_during(|| {
            let mut router = router_for_session();
            let start = Instant::now();
            let early = content_on("child", "early");
            assert_eq!(
                router.route_frame(&early, start),
                ThreadFrameRoute::HeldPendingRegistration
            );
            // Any frame routed at the registration's moment expires what waited too long.
            let connection_frame = TestFrame {
                raw_wire_type: "rate_limits".to_owned(),
                family_class: ThreadFrameFamilyClass::Connection,
                thread_id: None,
            };
            router.route_frame(&connection_frame, start + registered_after);
            registration = Some(router.register_child_thread(child_of_session()));
        });

        let shed_count = usize::from(released.is_none());
        let released_frames = released
            .unwrap_or_default()
            .into_iter()
            .map(|raw_wire_type| content_on("child", raw_wire_type))
            .collect();
        assert_eq!(
            registration,
            Some(ChildRegistrationResult::Registered {
                child_thread_id: "child".to_owned(),
                attribution: ChildSpendAttribution::Subagent {
                    subagent_id: "helper".to_owned(),
                },
                released_frames,
            })
        );
        assert_eq!(
            recorded.counters(),
            vec!["driver.threadRouter.pendingHoldShed"; shed_count]
        );
    }

    // Killed by shedding any frame but the oldest, and by reporting every shed of a family once
    // the buffer stays full (`first` shed twice).
    #[test]
    fn the_quarantine_sheds_its_oldest_frame_at_its_cap() {
        let recorded = RecordedEvents::default();
        recorded.record_during(|| {
            let mut router = router_for_session();
            let now = Instant::now();
            for raw_wire_type in ["first", "second", "first", "second", "first"] {
                let unknown = TestFrame {
                    raw_wire_type: raw_wire_type.to_owned(),
                    family_class: ThreadFrameFamilyClass::Unknown,
                    thread_id: None,
                };
                assert_eq!(
                    router.route_frame(&unknown, now),
                    ThreadFrameRoute::Quarantined
                );
            }
        });

        assert_eq!(
            recorded.field_on("driver.threadRouter.quarantineShed", "raw_wire_type"),
            ["first", "second"]
        );
    }
}
