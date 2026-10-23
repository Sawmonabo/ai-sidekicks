//! Which execution each provider delivery belongs to: one cursor per runtime binding, counting the
//! turns the binding delivered in its delivery order, the provider operations opened on it, and
//! the fence an undo's confirmed cut sets. Nothing here is a guess made at read time: a delivery
//! is attributed from what its binding delivered before it.

use std::collections::HashMap;
use std::collections::hash_map::Entry;
use std::num::NonZeroUsize;

use lru::LruCache;
use serde_json::{Map, Value};
use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::transcript::turn_attribution::EpochPosition;
use sidekicks_contracts::wire::integer::SafeInt;

use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

/// The provider operations a binding remembers: past it the oldest one opened is dropped, and a
/// late delivery of it may read as from before the last cut.
#[expect(
    dead_code,
    reason = "the daemon's start builds the execution epochs under this cap"
)]
pub(crate) const MAX_ASSOCIATIONS_PER_BINDING: NonZeroUsize =
    NonZeroUsize::new(4096).expect("the cap is not zero");

// Why an eviction is reported, in the words the diagnostic carries.
const EVICTION_DISPOSITION_REASON: &str = "the binding's operation associations reached their \
    cap, so the oldest was dropped; once a cut has closed a generation, a late row of that \
    operation is stamped as from before the cut, and its lifecycle event or permission ask is read \
    as current";

/// The runtime binding a cursor counts deliveries for.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct EpochBinding {
    /// The binding.
    pub(crate) id: RuntimeBindingId,
    /// The run it belongs to.
    pub(crate) run_id: RunId,
    /// The provider it runs on, as the binding names it.
    pub(crate) provider_name: ProviderId,
    /// The account it runs under, `None` on the machine's default home.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
}

/// The provider-side operation a delivery belongs to (a tool call, a message item, an artifact),
/// by the key the provider correlates its deliveries with. The first delivery of every operation
/// is passed as its opening; a later one that finds no opening held is read as one evicted.
#[derive(Clone, Copy, Debug)]
pub(crate) struct DeliveryOperation<'key> {
    /// The provider's key for the operation.
    pub(crate) correlation_key: &'key str,
    /// Whether this is the operation's first delivery.
    pub(crate) is_opening: bool,
}

/// Which execution a delivery belongs to: the current one, the one before an undo's cut, or
/// unknown for an operation whose opening was evicted, which may be from before the cut at
/// `source`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum DeliveryAttribution {
    /// The execution the binding runs now.
    Current,
    /// The execution before a cut, at `source`.
    BeforeCut {
        /// The epoch and turn the delivery belongs to.
        source: EpochPosition,
    },
    /// Possibly the execution before a cut; `source` is the generation it may be from.
    Unknown {
        /// The epoch and turn of the generation the delivery may belong to.
        source: EpochPosition,
    },
}

/// An undo's cut, confirmed by the provider. In place, the binding stays and its deliveries after
/// the fence open the new epoch at `point`; by a fork and restart, the old binding freezes whole
/// and `new_binding` opens the new epoch at `point`.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the provider's event delivery fences each cut the provider confirms"
    )
)]
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum ConfirmedCut {
    /// The provider rewound the binding's own conversation.
    InPlace {
        /// The binding cut.
        binding_id: RuntimeBindingId,
        /// The turn the new epoch opens at.
        point: SourcePosition,
    },
    /// The provider forked the conversation and restarted on the fork.
    ForkRestart {
        /// The binding that freezes.
        binding_id: RuntimeBindingId,
        /// The turn the new epoch opens at.
        point: SourcePosition,
        /// The binding that carries the new epoch.
        new_binding: EpochBinding,
    },
}

/// Why a cursor call was refused: the caller named a binding in the wrong state for it.
#[derive(Debug, thiserror::Error)]
pub(crate) enum EpochCursorError {
    /// The binding already has a cursor open.
    #[error("runtime binding {} already has an epoch cursor", binding_id.as_str())]
    AlreadyOpen {
        /// The binding.
        binding_id: RuntimeBindingId,
    },
    /// The binding has no cursor open.
    #[error("runtime binding {} has no epoch cursor open", binding_id.as_str())]
    NotOpen {
        /// The binding.
        binding_id: RuntimeBindingId,
    },
    /// The binding froze at an earlier cut, so it takes no further cut.
    #[error("runtime binding {} froze at an earlier cut", binding_id.as_str())]
    Frozen {
        /// The binding.
        binding_id: RuntimeBindingId,
    },
}

/// One binding's place in its execution.
#[derive(Clone, Debug)]
struct BindingCursor {
    binding: EpochBinding,
    // The open generation's pair; its position moves at each turn boundary.
    current: EpochPosition,
    // Set when a fork and restart froze the binding: every later delivery belongs to this pair.
    frozen_at: Option<EpochPosition>,
    // The pair of each generation an in-place cut closed, oldest first. Those below the newest
    // evicted association's epoch are pruned, the latest kept, since no lookup asks for them.
    closed_generations: Vec<EpochPosition>,
    // Each operation's pair when it opened, the oldest dropped first past the cap.
    associations: LruCache<String, EpochPosition>,
    newest_evicted_epoch: Option<SourceEpoch>,
}

/// The cursors of the open runtime bindings. Calls for one binding are made in its delivery
/// order, the fence among them, since each attribution is decided from the calls before it.
pub(crate) struct ExecutionEpochs {
    max_associations_per_binding: NonZeroUsize,
    // One entry per binding opened and not yet closed.
    cursors: HashMap<RuntimeBindingId, BindingCursor>,
}

impl ExecutionEpochs {
    /// No cursors yet; each binding remembers up to `max_associations_per_binding` operations.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the daemon's start builds the one set of epoch cursors"
        )
    )]
    pub(crate) fn new(max_associations_per_binding: NonZeroUsize) -> Self {
        Self {
            max_associations_per_binding,
            cursors: HashMap::new(),
        }
    }

    /// Opens a binding's cursor at `start`, the epoch and turn its conversation stands at. Fails
    /// with [`EpochCursorError::AlreadyOpen`] for a binding that has one.
    pub(crate) fn open_binding(
        &mut self,
        binding: EpochBinding,
        start: EpochPosition,
    ) -> Result<(), EpochCursorError> {
        let cursor = BindingCursor {
            current: start,
            frozen_at: None,
            closed_generations: Vec::new(),
            associations: LruCache::new(self.max_associations_per_binding),
            newest_evicted_epoch: None,
            binding,
        };
        self.insert_cursor(cursor)
    }

    /// Opens the cursor of a binding that carries `predecessor_id`'s conversation on in a new
    /// process: where the predecessor's stands, with what it remembers, while its cursor is open,
    /// else at `start`. Fails with [`EpochCursorError::AlreadyOpen`] for a binding that has one.
    pub(crate) fn continue_binding(
        &mut self,
        binding: EpochBinding,
        predecessor_id: &RuntimeBindingId,
        start: EpochPosition,
    ) -> Result<(), EpochCursorError> {
        let Some(predecessor) = self.cursors.get(predecessor_id) else {
            return self.open_binding(binding, start);
        };
        let cursor = BindingCursor {
            binding,
            ..predecessor.clone()
        };
        self.insert_cursor(cursor)
    }

    /// Drops a binding's cursor once the binding has ended and delivers nothing more; one with no
    /// cursor is already dropped.
    pub(crate) fn close_binding(&mut self, binding_id: &RuntimeBindingId) {
        self.cursors.remove(binding_id);
    }

    /// The binding a cursor counts for. Fails with [`EpochCursorError::NotOpen`] for a binding
    /// with no cursor open.
    pub(crate) fn binding(
        &self,
        binding_id: &RuntimeBindingId,
    ) -> Result<&EpochBinding, EpochCursorError> {
        self.cursors
            .get(binding_id)
            .map(|cursor| &cursor.binding)
            .ok_or_else(|| EpochCursorError::NotOpen {
                binding_id: binding_id.clone(),
            })
    }

    /// Counts a turn boundary the binding delivered: the current generation moves to its next
    /// turn. On a frozen binding nothing moves, and the boundary belongs to the execution before
    /// the cut. Fails with [`EpochCursorError::NotOpen`] for a binding with no cursor open.
    pub(crate) fn open_turn(
        &mut self,
        binding_id: &RuntimeBindingId,
    ) -> Result<DeliveryAttribution, EpochCursorError> {
        let cursor = self.cursor_mut(binding_id)?;
        if let Some(frozen_at) = cursor.frozen_at {
            return Ok(DeliveryAttribution::BeforeCut { source: frozen_at });
        }
        let next_position = SafeInt::new(cursor.current.position.0.get() + 1)
            .expect("a binding's turns number far fewer than 2^53");
        cursor.current.position = SourcePosition(next_position);
        Ok(DeliveryAttribution::Current)
    }

    /// Attributes one delivery. With an operation, the pair it opened at decides, and an opening
    /// is recorded at the current pair, afresh when its key last opened before a cut; without one,
    /// a frozen binding's delivery takes its retained pair and an in-place binding's is current,
    /// by the fence's order. Fails with [`EpochCursorError::NotOpen`] for a binding with no cursor
    /// open.
    pub(crate) fn attribute(
        &mut self,
        binding_id: &RuntimeBindingId,
        operation: Option<DeliveryOperation<'_>>,
    ) -> Result<DeliveryAttribution, EpochCursorError> {
        let max_associations = self.max_associations_per_binding;
        let cursor = self.cursor_mut(binding_id)?;
        let opened = operation
            .and_then(|operation| cursor.associations.peek(operation.correlation_key).copied());
        if let Some(frozen_at) = cursor.frozen_at {
            return Ok(DeliveryAttribution::BeforeCut {
                source: opened.unwrap_or(frozen_at),
            });
        }
        let Some(operation) = operation else {
            return Ok(DeliveryAttribution::Current);
        };
        if opened.is_some_and(|opened| opened.epoch == cursor.current.epoch) {
            return Ok(DeliveryAttribution::Current);
        }
        if operation.is_opening {
            // A provider may reuse an operation's key after an in-place cut; the reuse is a new
            // operation, moved to the newest place so eviction drops it last.
            cursor.record_opening(operation.correlation_key, max_associations);
            return Ok(DeliveryAttribution::Current);
        }
        Ok(match opened {
            None => cursor.attribute_evicted_operation(),
            Some(source) => DeliveryAttribution::BeforeCut { source },
        })
    }

    /// Sets the fence of a confirmed cut. Fails with [`EpochCursorError::NotOpen`] for a binding
    /// with no cursor open, [`EpochCursorError::Frozen`] for one frozen, and, by a fork and
    /// restart, [`EpochCursorError::AlreadyOpen`] when the new binding has a cursor.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the provider's event delivery fences each cut the provider confirms"
        )
    )]
    pub(crate) fn fence_cut(&mut self, cut: ConfirmedCut) -> Result<(), EpochCursorError> {
        match cut {
            ConfirmedCut::InPlace { binding_id, point } => {
                let cursor = self.unfrozen_cursor_mut(&binding_id)?;
                let next = next_generation(cursor.current, point);
                cursor.closed_generations.push(cursor.current);
                cursor.current = next;
                Ok(())
            }
            ConfirmedCut::ForkRestart {
                binding_id,
                point,
                new_binding,
            } => {
                let current = self.unfrozen_cursor_mut(&binding_id)?.current;
                self.open_binding(new_binding, next_generation(current, point))?;
                self.cursors
                    .get_mut(&binding_id)
                    .expect("the cut binding's cursor was read above and only another was opened")
                    .frozen_at = Some(current);
                Ok(())
            }
        }
    }

    fn insert_cursor(&mut self, cursor: BindingCursor) -> Result<(), EpochCursorError> {
        match self.cursors.entry(cursor.binding.id.clone()) {
            Entry::Occupied(occupied) => Err(EpochCursorError::AlreadyOpen {
                binding_id: occupied.key().clone(),
            }),
            Entry::Vacant(vacant) => {
                vacant.insert(cursor);
                Ok(())
            }
        }
    }

    fn cursor_mut(
        &mut self,
        binding_id: &RuntimeBindingId,
    ) -> Result<&mut BindingCursor, EpochCursorError> {
        self.cursors
            .get_mut(binding_id)
            .ok_or_else(|| EpochCursorError::NotOpen {
                binding_id: binding_id.clone(),
            })
    }

    fn unfrozen_cursor_mut(
        &mut self,
        binding_id: &RuntimeBindingId,
    ) -> Result<&mut BindingCursor, EpochCursorError> {
        let cursor = self.cursor_mut(binding_id)?;
        if cursor.frozen_at.is_some() {
            return Err(EpochCursorError::Frozen {
                binding_id: binding_id.clone(),
            });
        }
        Ok(cursor)
    }
}

impl BindingCursor {
    // Records an operation's opening at the current pair; past the cap the oldest opening is
    // dropped, the closed generations no lookup can ask for go with it, and the drop is reported.
    fn record_opening(&mut self, correlation_key: &str, max_associations: NonZeroUsize) {
        let Some((dropped_key, evicted)) = self
            .associations
            .push(correlation_key.to_owned(), self.current)
        else {
            return;
        };
        // A reopened key hands back its own earlier pair, which is no eviction.
        if dropped_key == correlation_key {
            return;
        }
        self.newest_evicted_epoch = Some(evicted.epoch);
        let kept_from = self
            .closed_generations
            .iter()
            .position(|generation| generation.epoch >= evicted.epoch)
            .unwrap_or(self.closed_generations.len().saturating_sub(1));
        self.closed_generations.drain(..kept_from);
        let mut details = Map::new();
        details.insert(
            "bindingId".to_owned(),
            Value::from(self.binding.id.as_str()),
        );
        details.insert(
            "runId".to_owned(),
            Value::from(self.binding.run_id.text().as_str()),
        );
        details.insert(
            "evictedEpoch".to_owned(),
            Value::from(evicted.epoch.0.get()),
        );
        details.insert(
            "evictedPosition".to_owned(),
            Value::from(evicted.position.0.get()),
        );
        details.insert(
            "maxAssociationsPerBinding".to_owned(),
            Value::from(max_associations.get()),
        );
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: self.binding.provider_name.clone(),
            provider_account_id: self.binding.provider_account_id.clone(),
            kind: DriverDiagnosticKind::EpochAssociationEvicted,
            raw_wire_type: None,
            disposition_reason: EVICTION_DISPOSITION_REASON.to_owned(),
            details,
        });
    }

    // A continuation of an operation the binding does not hold. With nothing evicted it never
    // opened here and is current, by the fence's order. Otherwise it opened no later than the
    // newest evicted operation, so once a generation has closed it may be from one: its execution
    // is unknown, with the pair of the generation it may be from.
    fn attribute_evicted_operation(&self) -> DeliveryAttribution {
        let (Some(newest_evicted_epoch), Some(latest_closed)) =
            (self.newest_evicted_epoch, self.closed_generations.last())
        else {
            return DeliveryAttribution::Current;
        };
        let source = self
            .closed_generations
            .iter()
            .find(|generation| generation.epoch == newest_evicted_epoch)
            .unwrap_or(latest_closed);
        DeliveryAttribution::Unknown { source: *source }
    }
}

// The pair a cut opens: the epoch after `current`'s, at `point`.
fn next_generation(current: EpochPosition, point: SourcePosition) -> EpochPosition {
    let next_epoch = SafeInt::new(current.epoch.0.get() + 1)
        .expect("a binding's cuts number far fewer than 2^53");
    EpochPosition {
        epoch: SourceEpoch(next_epoch),
        position: point,
    }
}

#[cfg(test)]
mod tests {
    use std::num::NonZeroUsize;

    use rstest::rstest;
    use sidekicks_contracts::event::envelope::{SourceEpoch, SourcePosition};
    use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::transcript::turn_attribution::{EpochPosition, RUN_START_POSITION};
    use sidekicks_contracts::wire::integer::SafeInt;

    use super::{
        ConfirmedCut, DeliveryAttribution, DeliveryOperation, EpochBinding, ExecutionEpochs,
    };
    use crate::provider::driver::registry::test_provider;
    use sidekicks_contracts::wire::id::mint_uuid_v7;

    /// One delivery or fence the binding sees, in its delivery order.
    #[derive(Clone, Copy, Debug)]
    enum Step {
        /// A turn boundary.
        Turn,
        /// The first delivery of the operation with this key.
        Open(&'static str),
        /// A confirmed in-place cut opening the next epoch at this turn.
        CutInPlace(u64),
        /// A confirmed fork and restart opening the next epoch at this turn on a new binding.
        CutByFork(u64),
    }

    fn binding_id(name: &str) -> RuntimeBindingId {
        RuntimeBindingId::new(name.to_owned()).expect("a binding id")
    }

    fn binding(name: &str) -> EpochBinding {
        EpochBinding {
            id: binding_id(name),
            run_id: RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id"),
            provider_name: test_provider(),
            provider_account_id: None,
        }
    }

    fn pair(epoch: u64, position: u64) -> EpochPosition {
        EpochPosition {
            epoch: SourceEpoch(SafeInt::new(epoch).expect("a small epoch")),
            position: SourcePosition(SafeInt::new(position).expect("a small position")),
        }
    }

    // Killed by a continuation of an operation opened before an in-place cut read as current, by
    // a frozen binding's delivery read as current, by a key reused after a cut kept at its old
    // pair, and by an evicted operation's late delivery read as current or given the latest
    // closed generation instead of the evicted one's.
    #[rstest]
    #[case::an_operation_of_the_current_epoch_is_current(
        1,
        &[Step::Turn, Step::Open("call")],
        Some("call"),
        DeliveryAttribution::Current,
    )]
    #[case::an_operation_opened_before_an_in_place_cut_is_before_it(
        8,
        &[Step::Turn, Step::Open("call"), Step::CutInPlace(1)],
        Some("call"),
        DeliveryAttribution::BeforeCut { source: pair(0, 1) },
    )]
    #[case::a_binding_frozen_by_a_fork_delivers_from_before_the_cut(
        8,
        &[Step::Turn, Step::Turn, Step::Open("call"), Step::CutByFork(1)],
        None,
        DeliveryAttribution::BeforeCut { source: pair(0, 2) },
    )]
    #[case::a_key_reused_after_an_in_place_cut_is_a_new_operation(
        8,
        &[Step::Turn, Step::Open("call"), Step::CutInPlace(1), Step::Open("call")],
        Some("call"),
        DeliveryAttribution::Current,
    )]
    #[case::an_evicted_operation_is_unknown_with_its_own_generation(
        2,
        &[
            Step::Turn,
            Step::Open("first"),
            Step::CutInPlace(1),
            Step::Turn,
            Step::Open("second"),
            Step::CutInPlace(2),
            Step::Open("third"),
        ],
        Some("first"),
        DeliveryAttribution::Unknown { source: pair(0, 1) },
    )]
    fn a_delivery_is_attributed_from_what_its_binding_delivered_before_it(
        #[case] max_associations: usize,
        #[case] steps: &[Step],
        #[case] continued_operation: Option<&'static str>,
        #[case] expected: DeliveryAttribution,
    ) {
        let old = binding_id("old");
        let mut epochs = ExecutionEpochs::new(
            NonZeroUsize::new(max_associations).expect("the case's cap is not zero"),
        );
        epochs
            .open_binding(binding("old"), RUN_START_POSITION)
            .expect("the binding has no cursor yet");
        for step in steps {
            match *step {
                Step::Turn => {
                    epochs
                        .open_turn(&old)
                        .expect("the binding's cursor is open");
                }
                Step::Open(correlation_key) => {
                    let operation = DeliveryOperation {
                        correlation_key,
                        is_opening: true,
                    };
                    epochs
                        .attribute(&old, Some(operation))
                        .expect("the binding's cursor is open");
                }
                Step::CutInPlace(point) => epochs
                    .fence_cut(ConfirmedCut::InPlace {
                        binding_id: old.clone(),
                        point: pair(0, point).position,
                    })
                    .expect("the binding's cursor is open and not frozen"),
                Step::CutByFork(point) => epochs
                    .fence_cut(ConfirmedCut::ForkRestart {
                        binding_id: old.clone(),
                        point: pair(0, point).position,
                        new_binding: binding("new"),
                    })
                    .expect("the binding's cursor is open and not frozen"),
            }
        }

        let operation = continued_operation.map(|correlation_key| DeliveryOperation {
            correlation_key,
            is_opening: false,
        });
        let attribution = epochs
            .attribute(&old, operation)
            .expect("the binding's cursor is open");

        assert_eq!(attribution, expected);
    }
}
