//! The legs map: what each live leg last saw of each MCP server, the machine probe's newest reading
//! per binding, and the fold of a binding's status from them. It reads no clock and sends nothing:
//! each change answers the status change the tracker sends.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::mem;

use sidekicks_contracts::mcp::server::inventory::McpServerLegStatus;
use sidekicks_contracts::mcp::server::{
    MCP_SERVER_STATUS_SEVERITY_ORDER, McpServerBindingRef, McpServerName, McpServerStatus,
};
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_provider::driver::mcp_server_status::{McpServerReading, McpServerStatusUpdate};

use super::McpBindingStatusReading;
use crate::binding_store::McpBindingKey;

/// One leg: a runtime binding of one session.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker keys its legs by it")
)]
#[derive(Clone, PartialEq, Eq, Hash)]
pub(super) struct LegId {
    /// The session.
    pub(super) session_id: SessionId,
    /// The session's runtime binding.
    pub(super) binding_id: RuntimeBindingId,
}

/// What one leg last saw of one server.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker keeps each leg's servers")
)]
struct LegServer {
    /// The effective binding the leg serves the server from.
    binding_key: McpBindingKey,
    /// The last status observed; `None` when the server was switched off before any.
    status: Option<McpServerStatus>,
    /// The provider switched the server off for this leg, so it is out of the aggregate.
    is_switched_off: bool,
    /// The provider's raw error text, sanitized only when it leaves.
    failure_text: Option<String>,
    /// When the leg last reported the server.
    observed_at: WireInstant,
}

/// A leg's servers and the sinks that can still report for it.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker keeps each leg")
)]
struct Leg {
    /// Each server the leg reported, by name.
    servers: HashMap<McpServerName, LegServer>,
    /// How many of the leg's sinks are open.
    open_sinks: usize,
    /// The leg was retired: what it reports is ignored until its last sink drops.
    is_retired: bool,
}

/// The machine probe's newest reading of a binding.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the machine probe records its readings")
)]
struct ProbeReading {
    status: McpServerStatus,
    failure_text: Option<String>,
    observed_at: WireInstant,
}

/// One binding's sources and its folded status.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker folds each binding")
)]
struct BindingStatus {
    /// The legs holding an entry for the binding: the index the fold reads instead of every leg.
    legs: HashSet<LegId>,
    /// The machine probe's newest reading.
    probe: Option<ProbeReading>,
    /// The aggregate the last change left, the previous status of the next `sessionEnded`.
    aggregate: McpServerStatus,
}

/// Where a status change came from.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker sends a notice per change")
)]
pub(super) enum ChangeOrigin {
    /// A live leg's own status changed.
    SessionFeed {
        /// The leg.
        leg: LegId,
        /// When the reading that changed it was observed.
        observed_at: WireInstant,
    },
    /// A leg left the binding's aggregate: retired, now serving the server from another binding,
    /// or the server switched off for it.
    SessionEnded(LegId),
    /// The machine probe's reading changed.
    MachineProbe,
}

/// One status notice to send: a `sessionFeed`'s two statuses are its leg's own, a
/// `sessionEnded`'s the binding's aggregate before and after the leg left, a `machineProbe`'s the
/// probe's own readings.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker sends a notice per change")
)]
pub(super) struct StatusChange {
    /// The binding's key.
    pub(super) binding_key: McpBindingKey,
    /// Where the change came from.
    pub(super) origin: ChangeOrigin,
    /// The status before the change.
    pub(super) previous_status: McpServerStatus,
    /// The status now.
    pub(super) status: McpServerStatus,
    /// The raw error text of the source the status comes from.
    pub(super) failure_text: Option<String>,
}

/// What a reading changed: the status changes to send, and the binding for the drain to record
/// when the reading observed a status, is the leg's first report of it, or is a probe's.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker applies each reading")
)]
pub(super) struct ObservationOutcome {
    /// The status changes to send, in order.
    pub(super) changes: Vec<StatusChange>,
    /// The binding to record, which the drain skips once it is recorded in this process.
    pub(super) observed_binding: Option<McpServerBindingRef>,
}

/// A binding's status folded from its sources.
struct Fold {
    status: McpServerStatus,
    failure_text: Option<String>,
    observed_at: Option<WireInstant>,
}

/// Every leg and every binding's sources.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker keeps its state in it")
)]
pub(super) struct McpLegs {
    legs: HashMap<LegId, Leg>,
    bindings: HashMap<McpBindingKey, BindingStatus>,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker keeps its state in it")
)]
impl McpLegs {
    /// No leg, no binding.
    pub(super) fn new() -> Self {
        Self {
            legs: HashMap::new(),
            bindings: HashMap::new(),
        }
    }

    /// Counts one more open sink for `leg`.
    pub(super) fn open_sink(&mut self, leg: LegId) {
        self.legs.entry(leg).or_insert_with(Leg::new).open_sinks += 1;
    }

    /// Counts one sink of `leg` closed; a retired leg whose last sink closed is forgotten, since
    /// nothing can report for it any more.
    pub(super) fn close_sink(&mut self, leg: &LegId) {
        let Some(held) = self.legs.get_mut(leg) else {
            return;
        };
        held.open_sinks -= 1;
        if held.open_sinks == 0 && held.is_retired {
            self.legs.remove(leg);
        }
    }

    /// Applies one server's reading from a leg, `binding` being the effective binding the leg
    /// serves it from. A notice goes out when the leg's own status changed. A switch-off takes the
    /// leg out of the aggregate with a `sessionEnded`, its last status kept, and a leg that now
    /// serves the name from another binding leaves the old one the same way. A switched-off leg
    /// that reports again counts as new on the binding. A retired leg's reading changes nothing.
    pub(super) fn observe(
        &mut self,
        binding: &McpServerBindingRef,
        update: McpServerStatusUpdate,
        observed_at: WireInstant,
    ) -> ObservationOutcome {
        let leg_id = LegId {
            session_id: update.session_id,
            binding_id: update.binding_id,
        };
        let key = McpBindingKey::of(binding);
        let mut outcome = ObservationOutcome {
            changes: Vec::new(),
            observed_binding: None,
        };
        let leg = self.legs.entry(leg_id.clone()).or_insert_with(Leg::new);
        if leg.is_retired {
            return outcome;
        }
        let new_entry = || {
            leg_server(
                key.clone(),
                update.reading,
                update.failure_text.clone(),
                observed_at.clone(),
            )
        };
        // The leg's status on this binding before the reading, `None` when the leg had none or was
        // switched off, so its return reads as new; the entry the leg held for the name on another
        // binding, when it moved; and whether a switch-off took the leg out of this binding's
        // aggregate.
        let (previous, moved_from, is_new_on_binding, has_left_aggregate) =
            match leg.servers.entry(update.server_name) {
                Entry::Occupied(mut held) if held.get().binding_key == key => {
                    let server = held.get_mut();
                    let was_in_aggregate = !server.is_switched_off;
                    let previous = server.status.filter(|_| was_in_aggregate);
                    match update.reading {
                        McpServerReading::Observed(status) => {
                            server.status = Some(status);
                            server.is_switched_off = false;
                            // The newest text, so a later notice this leg decides quotes it.
                            server.failure_text = update.failure_text.clone();
                        }
                        // The last status and its text stay; the leg leaves the aggregate, answered
                        // below with a `sessionEnded`.
                        McpServerReading::SwitchedOff => server.is_switched_off = true,
                    }
                    server.observed_at = observed_at.clone();
                    let has_left_aggregate = was_in_aggregate && server.is_switched_off;
                    (previous, None, false, has_left_aggregate)
                }
                // On a binding new to the leg, a switch-off never joined the aggregate, so it
                // leaves nothing.
                Entry::Occupied(mut held) => {
                    let moved_from = mem::replace(held.get_mut(), new_entry());
                    (None, Some(moved_from), true, false)
                }
                Entry::Vacant(vacant) => {
                    vacant.insert(new_entry());
                    (None, None, true, false)
                }
            };
        if let Some(moved_from) = moved_from {
            if let Some(binding_status) = self.bindings.get_mut(&moved_from.binding_key) {
                binding_status.legs.remove(&leg_id);
            }
            let aggregate = self.refold(&moved_from.binding_key);
            // A switched-off entry already left the aggregate, so its move sends nothing.
            if !moved_from.is_switched_off {
                outcome.changes.extend(aggregate.map(|fold| {
                    fold.change(
                        moved_from.binding_key,
                        ChangeOrigin::SessionEnded(leg_id.clone()),
                    )
                }));
            }
        }
        if is_new_on_binding {
            self.bindings
                .entry(key.clone())
                .or_insert_with(BindingStatus::new)
                .legs
                .insert(leg_id.clone());
        }
        // Every observed status hands the binding over, so a binding whose write failed is tried
        // again at its next reading.
        if is_new_on_binding || matches!(update.reading, McpServerReading::Observed(_)) {
            outcome.observed_binding = Some(binding.clone());
        }
        let aggregate = self.refold(&key);
        if has_left_aggregate {
            outcome.changes.extend(
                aggregate.map(|fold| {
                    fold.change(key.clone(), ChangeOrigin::SessionEnded(leg_id.clone()))
                }),
            );
        }
        if let McpServerReading::Observed(status) = update.reading
            && previous != Some(status)
        {
            outcome.changes.push(StatusChange {
                binding_key: key,
                origin: ChangeOrigin::SessionFeed {
                    leg: leg_id,
                    observed_at,
                },
                previous_status: previous.unwrap_or(McpServerStatus::Unknown),
                status,
                failure_text: update.failure_text,
            });
        }
        outcome
    }

    /// Retires `leg`: its servers leave every binding's aggregate, each binding whose aggregate it
    /// was in answering a `sessionEnded` change, and what it reports later is ignored. The leg is
    /// forgotten at once when no sink of it is open, else when its last sink closes.
    pub(super) fn retire(&mut self, leg_id: &LegId) -> Vec<StatusChange> {
        let Some(leg) = self.legs.get_mut(leg_id) else {
            return Vec::new();
        };
        let servers = mem::take(&mut leg.servers);
        leg.is_retired = true;
        if leg.open_sinks == 0 {
            self.legs.remove(leg_id);
        }
        let mut changes = Vec::with_capacity(servers.len());
        for server in servers.into_values() {
            if let Some(binding_status) = self.bindings.get_mut(&server.binding_key) {
                binding_status.legs.remove(leg_id);
            }
            let aggregate = self.refold(&server.binding_key);
            // A switched-off entry already left the aggregate, so its retire sends nothing.
            if !server.is_switched_off {
                changes.extend(aggregate.map(|fold| {
                    fold.change(
                        server.binding_key,
                        ChangeOrigin::SessionEnded(leg_id.clone()),
                    )
                }));
            }
        }
        changes
    }

    /// Stores the machine probe's newest reading of `binding`, which stands for the binding only
    /// while no live leg holds a status; a change answers when the probe's own reading moved.
    pub(super) fn record_probe(
        &mut self,
        binding: &McpServerBindingRef,
        status: McpServerStatus,
        failure_text: Option<String>,
        observed_at: WireInstant,
    ) -> ObservationOutcome {
        let key = McpBindingKey::of(binding);
        let binding_status = self
            .bindings
            .entry(key.clone())
            .or_insert_with(BindingStatus::new);
        let previous_status = binding_status
            .probe
            .as_ref()
            .map_or(McpServerStatus::Unknown, |probe| probe.status);
        binding_status.probe = Some(ProbeReading {
            status,
            failure_text: failure_text.clone(),
            observed_at,
        });
        self.refold(&key);
        let changes = (previous_status != status)
            .then(|| StatusChange {
                binding_key: key,
                origin: ChangeOrigin::MachineProbe,
                previous_status,
                status,
                failure_text,
            })
            .into_iter()
            .collect();
        ObservationOutcome {
            changes,
            observed_binding: Some(binding.clone()),
        }
    }

    /// `key`'s status and the legs in its aggregate; `unknown` with no leg for a binding nothing
    /// reports.
    pub(super) fn reading(&self, key: &McpBindingKey) -> McpBindingStatusReading {
        let Some(binding_status) = self.bindings.get(key) else {
            return McpBindingStatusReading {
                status: McpServerStatus::Unknown,
                legs: Vec::new(),
                observed_at: None,
            };
        };
        let fold = fold(&self.legs, key, binding_status);
        let legs = live_servers(&self.legs, key, binding_status)
            .map(|(leg_id, server, status)| McpServerLegStatus {
                session_id: leg_id.session_id,
                binding_id: leg_id.binding_id.clone(),
                status,
                observed_at: Some(server.observed_at.clone()),
                failed_reason: None,
            })
            .collect();
        McpBindingStatusReading {
            status: fold.status,
            legs,
            observed_at: fold.observed_at,
        }
    }

    /// How many legs are remembered, retired ones included.
    #[cfg(test)]
    pub(super) fn leg_count(&self) -> usize {
        self.legs.len()
    }

    /// Folds `key`'s status again and stores it as the binding's aggregate, answering the
    /// aggregate before and after; a binding left with no leg and no probe reading is forgotten,
    /// its aggregate `unknown`.
    fn refold(&mut self, key: &McpBindingKey) -> Option<AggregateFold> {
        let binding_status = self.bindings.get(key)?;
        let folded = fold(&self.legs, key, binding_status);
        let aggregate = AggregateFold {
            previous_status: binding_status.aggregate,
            status: folded.status,
            failure_text: folded.failure_text,
        };
        if binding_status.legs.is_empty() && binding_status.probe.is_none() {
            self.bindings.remove(key);
        } else if let Some(binding_status) = self.bindings.get_mut(key) {
            binding_status.aggregate = aggregate.status;
        }
        Some(aggregate)
    }
}

/// A binding's aggregate before and after one change, with the deciding source's error text.
struct AggregateFold {
    previous_status: McpServerStatus,
    status: McpServerStatus,
    failure_text: Option<String>,
}

impl AggregateFold {
    /// The aggregate as `binding_key`'s status change from `origin`.
    fn change(self, binding_key: McpBindingKey, origin: ChangeOrigin) -> StatusChange {
        StatusChange {
            binding_key,
            origin,
            previous_status: self.previous_status,
            status: self.status,
            failure_text: self.failure_text,
        }
    }
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker keeps each leg")
)]
impl Leg {
    /// A leg with no server and no open sink.
    fn new() -> Self {
        Self {
            servers: HashMap::new(),
            open_sinks: 0,
            is_retired: false,
        }
    }
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker folds each binding")
)]
impl BindingStatus {
    /// A binding with no source yet.
    fn new() -> Self {
        Self {
            legs: HashSet::new(),
            probe: None,
            aggregate: McpServerStatus::Unknown,
        }
    }
}

/// A new leg entry for one reading.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker keeps each leg's servers")
)]
fn leg_server(
    binding_key: McpBindingKey,
    reading: McpServerReading,
    failure_text: Option<String>,
    observed_at: WireInstant,
) -> LegServer {
    let (status, is_switched_off) = match reading {
        McpServerReading::Observed(status) => (Some(status), false),
        McpServerReading::SwitchedOff => (None, true),
    };
    LegServer {
        binding_key,
        status,
        is_switched_off,
        failure_text,
        observed_at,
    }
}

/// The entries of `key`'s legs that are in its aggregate, not switched off and holding a status,
/// each with that status.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker folds each binding")
)]
fn live_servers<'a>(
    legs: &'a HashMap<LegId, Leg>,
    key: &'a McpBindingKey,
    binding_status: &'a BindingStatus,
) -> impl Iterator<Item = (&'a LegId, &'a LegServer, McpServerStatus)> {
    binding_status.legs.iter().flat_map(move |leg_id| {
        legs.get(leg_id)
            .into_iter()
            .flat_map(|leg| leg.servers.values())
            .filter(move |server| &server.binding_key == key && !server.is_switched_off)
            .filter_map(move |server| server.status.map(|status| (leg_id, server, status)))
    })
}

/// The most severe status among `key`'s live legs, ties going to the newest, with its error text;
/// else the probe's newest reading; else `unknown`. `observed_at` is the newest live leg's, else
/// the probe's.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker folds each binding")
)]
fn fold(legs: &HashMap<LegId, Leg>, key: &McpBindingKey, binding_status: &BindingStatus) -> Fold {
    let mut deciding: Option<(usize, McpServerStatus, &LegServer)> = None;
    let mut newest: Option<&WireInstant> = None;
    for (_, server, status) in live_servers(legs, key, binding_status) {
        let rank = severity_rank(status);
        // The stored instant is fixed-width UTC text, so its text order is its time order.
        let is_newer = |held: &WireInstant| server.observed_at.as_str() > held.as_str();
        if newest.is_none_or(is_newer) {
            newest = Some(&server.observed_at);
        }
        if deciding.is_none_or(|(held_rank, _, held)| {
            rank < held_rank || (rank == held_rank && is_newer(&held.observed_at))
        }) {
            deciding = Some((rank, status, server));
        }
    }
    if let Some((_, status, server)) = deciding {
        return Fold {
            status,
            failure_text: server.failure_text.clone(),
            observed_at: newest.cloned(),
        };
    }
    match &binding_status.probe {
        Some(probe) => Fold {
            status: probe.status,
            failure_text: probe.failure_text.clone(),
            observed_at: Some(probe.observed_at.clone()),
        },
        None => Fold {
            status: McpServerStatus::Unknown,
            failure_text: None,
            observed_at: None,
        },
    }
}

/// `status`'s place in the severity order, `0` the most severe.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status tracker folds each binding")
)]
fn severity_rank(status: McpServerStatus) -> usize {
    MCP_SERVER_STATUS_SEVERITY_ORDER
        .iter()
        .position(|ranked| *ranked == status)
        .expect("the severity order lists every status")
}
