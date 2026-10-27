//! The bounded reorder buffer at a normalize boundary that pairs tool events by tool call id: it
//! holds a completion that arrives before its initiation, and flushes in arrival order with a
//! diagnostic when it overflows or a pairing times out, so no reordering is ever silent.

use std::num::NonZeroUsize;
use std::time::Duration;

use lru::LruCache;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::id::ProviderId;
use tokio::time::Instant;

use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

/// How many initiations the buffer remembers awaiting their completion; past it the oldest is
/// forgotten, so a later completion for it holds instead of pairing.
const MAX_SEEN_INITIATION_IDS: NonZeroUsize = NonZeroUsize::new(1024).expect("1024 is not zero");

/// Where an event stands in its tool call's pair.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ReorderPairingRole {
    /// The call's start.
    Initiation,
    /// The call's end, which never goes out before its start.
    Completion,
    /// Neither; it never waits.
    Unpaired,
}

/// One normalized event offered to the buffer. `tool_call_id` is the provider's tool call id,
/// verbatim; an event with none never waits.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ReorderBufferedEvent<Event> {
    /// The tool call the event belongs to.
    pub(crate) tool_call_id: Option<String>,
    /// Where it stands in the call's pair.
    pub(crate) pairing_role: ReorderPairingRole,
    /// The event.
    pub(crate) event: Event,
}

/// A completion held for its initiation, with when it arrived.
struct HeldCompletion<Event> {
    tool_call_id: String,
    event: Event,
    held_at: Instant,
}

/// The bounded reorder buffer for a boundary that pairs tool events by tool call id: the only
/// reordering is holding a completion that arrives before its initiation. Overflow and the pairing
/// timeout flush in arrival order, each with a diagnostic; the caller supplies the clock.
pub(crate) struct NormalizedEventReorderBuffer<Event> {
    /// The provider its diagnostics name.
    provider: ProviderId,
    /// How many completions may wait at once before all are flushed.
    max_buffered_events: usize,
    /// How long a completion waits for its initiation.
    pairing_timeout: Duration,
    /// The waiting completions, in arrival order.
    held_completions: Vec<HeldCompletion<Event>>,
    /// The initiations seen whose completion has not come. Capped, since no completion is
    /// guaranteed; `contains` and `pop` leave the order alone, so eviction takes the oldest.
    seen_initiation_tool_call_ids: LruCache<String, ()>,
}

impl<Event> NormalizedEventReorderBuffer<Event> {
    /// An empty buffer for `provider` holding at most `max_buffered_events` completions, each for
    /// at most `pairing_timeout`.
    pub(crate) fn new(
        provider: ProviderId,
        max_buffered_events: usize,
        pairing_timeout: Duration,
    ) -> Self {
        Self {
            provider,
            max_buffered_events,
            pairing_timeout,
            held_completions: Vec::new(),
            seen_initiation_tool_call_ids: LruCache::new(MAX_SEEN_INITIATION_IDS),
        }
    }

    /// Admits one event at `now`; returns the events it releases, in order.
    pub(crate) fn admit(
        &mut self,
        buffered: ReorderBufferedEvent<Event>,
        now: Instant,
    ) -> Vec<Event> {
        let mut released = self.flush_expired(now);
        let ReorderBufferedEvent {
            tool_call_id,
            pairing_role,
            event,
        } = buffered;
        match (pairing_role, tool_call_id) {
            (ReorderPairingRole::Completion, Some(tool_call_id)) => {
                if self
                    .seen_initiation_tool_call_ids
                    .pop(&tool_call_id)
                    .is_some()
                {
                    released.push(event);
                    return released;
                }
                self.held_completions.push(HeldCompletion {
                    tool_call_id,
                    event,
                    held_at: now,
                });
                if self.held_completions.len() > self.max_buffered_events {
                    released.extend(self.flush_on_overflow());
                }
            }
            (ReorderPairingRole::Initiation, Some(tool_call_id)) => {
                self.admit_seen_initiation(&tool_call_id);
                released.push(event);
                let paired_completions = self.release_held_completions_for(&tool_call_id);
                if !paired_completions.is_empty() {
                    self.seen_initiation_tool_call_ids.pop(&tool_call_id);
                }
                released.extend(paired_completions);
            }
            (ReorderPairingRole::Unpaired, Some(_) | None)
            | (ReorderPairingRole::Completion | ReorderPairingRole::Initiation, None) => {
                released.push(event);
            }
        }
        released
    }

    /// Releases the held completions whose pairing timeout has passed at `now`, in arrival order,
    /// with a diagnostic for each.
    pub(crate) fn flush_expired(&mut self, now: Instant) -> Vec<Event> {
        let pairing_timeout = self.pairing_timeout;
        self.release_held(now, |held_for| held_for >= pairing_timeout)
    }

    /// When the oldest held completion's pairing timeout runs out, for the caller's timer; `None`
    /// when none is held.
    pub(crate) fn next_release(&self) -> Option<Instant> {
        self.held_completions
            .first()
            .map(|held| held.held_at + self.pairing_timeout)
    }

    /// Releases every held completion, in arrival order, each with the pairing timeout's
    /// diagnostic and the time it was held until `now`; for a run that ends with some unpaired.
    pub(crate) fn flush_all(&mut self, now: Instant) -> Vec<Event> {
        self.release_held(now, |_held_for| true)
    }

    fn admit_seen_initiation(&mut self, tool_call_id: &str) {
        // Pushed only when absent, so a repeat keeps its place in the eviction order.
        if self.seen_initiation_tool_call_ids.contains(tool_call_id) {
            return;
        }
        let Some((evicted_tool_call_id, ())) = self
            .seen_initiation_tool_call_ids
            .push(tool_call_id.to_owned(), ())
        else {
            return;
        };
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: self.provider.clone(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::ReorderSeenInitiationEvicted,
            raw_wire_type: None,
            disposition_reason: "seen-initiation set exceeded its declared cap; oldest identity \
                                 evicted, so a later completion for it holds instead of pairing"
                .to_owned(),
            details: Map::from_iter([
                ("toolCallId".to_owned(), Value::from(evicted_tool_call_id)),
                (
                    "maxSeenInitiationIds".to_owned(),
                    Value::from(MAX_SEEN_INITIATION_IDS.get()),
                ),
            ]),
        });
    }

    fn release_held_completions_for(&mut self, tool_call_id: &str) -> Vec<Event> {
        self.held_completions
            .extract_if(.., |held| held.tool_call_id == tool_call_id)
            .map(|held| held.event)
            .collect()
    }

    /// Releases the held completions `is_due` picks by how long each was held, with a pairing
    /// timeout diagnostic for each.
    fn release_held(&mut self, now: Instant, is_due: impl Fn(Duration) -> bool) -> Vec<Event> {
        let due: Vec<HeldCompletion<Event>> = self
            .held_completions
            .extract_if(.., |held| {
                is_due(now.saturating_duration_since(held.held_at))
            })
            .collect();
        due.into_iter()
            .map(|held| {
                let held_for = now.saturating_duration_since(held.held_at);
                emit_driver_diagnostic(&DriverDiagnosticRecord {
                    provider: self.provider.clone(),
                    provider_account_id: None,
                    kind: DriverDiagnosticKind::ToolPairingTimeout,
                    raw_wire_type: None,
                    disposition_reason: "unpaired toolCallId held past the reorder buffer's \
                                         pairing timeout; flushed in arrival order"
                        .to_owned(),
                    details: Map::from_iter([
                        ("toolCallId".to_owned(), Value::from(held.tool_call_id)),
                        (
                            "heldForMs".to_owned(),
                            Value::from(u64::try_from(held_for.as_millis()).unwrap_or(u64::MAX)),
                        ),
                        (
                            "pairingTimeoutMs".to_owned(),
                            Value::from(
                                u64::try_from(self.pairing_timeout.as_millis()).unwrap_or(u64::MAX),
                            ),
                        ),
                    ]),
                });
                held.event
            })
            .collect()
    }

    fn flush_on_overflow(&mut self) -> Vec<Event> {
        let flushed: Vec<Event> = self
            .held_completions
            .drain(..)
            .map(|held| held.event)
            .collect();
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: self.provider.clone(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::ReorderBufferOverflow,
            raw_wire_type: None,
            disposition_reason: "reorder buffer exceeded its maximum buffered-event cap; flushed \
                                 in arrival order"
                .to_owned(),
            details: Map::from_iter([
                ("flushedEventCount".to_owned(), Value::from(flushed.len())),
                (
                    "maxBufferedEvents".to_owned(),
                    Value::from(self.max_buffered_events),
                ),
            ]),
        });
        flushed
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::Instant;

    use super::{NormalizedEventReorderBuffer, ReorderBufferedEvent, ReorderPairingRole};
    use crate::driver::diagnostics::RecordedEvents;
    use crate::driver::registry::test_provider;

    fn offered(
        tool_call_id: &str,
        pairing_role: ReorderPairingRole,
        event: &'static str,
    ) -> ReorderBufferedEvent<&'static str> {
        ReorderBufferedEvent {
            tool_call_id: Some(tool_call_id.to_owned()),
            pairing_role,
            event,
        }
    }

    #[test]
    fn an_early_completion_goes_out_after_its_initiation() {
        let mut buffer =
            NormalizedEventReorderBuffer::new(test_provider(), 8, Duration::from_secs(5));
        let now = Instant::now();

        let held = buffer.admit(
            offered("call-1", ReorderPairingRole::Completion, "end"),
            now,
        );
        let released = buffer.admit(
            offered("call-1", ReorderPairingRole::Initiation, "start"),
            now,
        );

        assert_eq!(held, [] as [&str; 0]);
        assert_eq!(released, ["start", "end"]);
    }

    #[test]
    fn an_overflow_flushes_in_arrival_order_and_counts_it() {
        let recorded = RecordedEvents::default();
        let mut released = Vec::new();
        recorded.record_during(|| {
            let mut buffer =
                NormalizedEventReorderBuffer::new(test_provider(), 2, Duration::from_secs(5));
            let now = Instant::now();
            let arrivals = [
                ("call-1", "first"),
                ("call-2", "second"),
                ("call-3", "third"),
            ];
            for (tool_call_id, event) in arrivals {
                let completion = offered(tool_call_id, ReorderPairingRole::Completion, event);
                released.extend(buffer.admit(completion, now));
            }
        });

        assert_eq!(released, ["first", "second", "third"]);
        assert_eq!(recorded.counters(), ["driver.reorderBuffer.overflow"]);
    }
}
