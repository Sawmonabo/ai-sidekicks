//! The legs map: what each live leg last saw of each MCP server, the machine probe's newest reading
//! per binding, and the fold of a binding's status from them. It reads no clock and sends nothing:
//! each change answers the status change the core sends.

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
    expect(dead_code, reason = "the status core keys its legs by it")
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
    expect(dead_code, reason = "the status core keeps each leg's servers")
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
    expect(dead_code, reason = "the status core keeps each leg")
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
    expect(dead_code, reason = "the status core folds each binding")
)]
struct BindingStatus {
    /// The binding, as its first source named it.
    binding: McpServerBindingRef,
    /// The legs holding an entry for the binding: the index the fold reads instead of every leg.
    legs: HashSet<LegId>,
    /// The machine probe's newest reading.
    probe: Option<ProbeReading>,
    /// The aggregate the last change answered, the next notice's previous status.
    aggregate: McpServerStatus,
}

/// Where a status change came from.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status core sends a notice per change")
)]
pub(super) enum ChangeOrigin {
    /// A live leg's observation.
    SessionFeed(LegId),
    /// A retired leg left the aggregate.
    SessionEnded(LegId),
    /// The machine probe's reading.
    MachineProbe,
}

/// A binding's folded status after one change, with the status before it.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status core sends a notice per change")
)]
pub(super) struct StatusChange {
    /// The binding's key.
    pub(super) binding_key: McpBindingKey,
    /// The binding.
    pub(super) binding: McpServerBindingRef,
    /// Where the change came from.
    pub(super) origin: ChangeOrigin,
    /// The aggregate before the change.
    pub(super) previous_status: McpServerStatus,
    /// The aggregate now.
    pub(super) status: McpServerStatus,
    /// The raw error text of the source the aggregate comes from.
    pub(super) failure_text: Option<String>,
}

/// What an observation changed: the status change to send, if any, and the binding when this is
/// its first observation in this process.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status core applies each observation")
)]
pub(super) struct ObservationOutcome {
    /// The status changes to send, in order.
    pub(super) changes: Vec<StatusChange>,
    /// The binding, seen for the first time.
    pub(super) first_observation: Option<McpServerBindingRef>,
}

/// A binding's status folded from its sources.
struct Fold {
    status: McpServerStatus,
    failure_text: Option<String>,
    observed_at: Option<WireInstant>,
}

/// Every leg, every binding's sources, and the bindings already observed in this process.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status core keeps its state in it")
)]
pub(super) struct McpLegs {
    legs: HashMap<LegId, Leg>,
    bindings: HashMap<McpBindingKey, BindingStatus>,
    first_observed: HashSet<McpBindingKey>,
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status core keeps its state in it")
)]
impl McpLegs {
    /// No leg, no binding.
    pub(super) fn new() -> Self {
        Self {
            legs: HashMap::new(),
            bindings: HashMap::new(),
            first_observed: HashSet::new(),
        }
    }

    /// Counts one more open sink for `leg`.
    pub(super) fn open_sink(&mut self, leg: LegId) {
        self.legs
            .entry(leg)
            .or_insert_with(|| Leg {
                servers: HashMap::new(),
                open_sinks: 0,
                is_retired: false,
            })
            .open_sinks += 1;
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
    /// serves it from. A retired leg's reading changes nothing.
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
        let leg = self.legs.entry(leg_id.clone()).or_insert_with(|| Leg {
            servers: HashMap::new(),
            open_sinks: 0,
            is_retired: false,
        });
        let mut outcome = ObservationOutcome {
            changes: Vec::new(),
            first_observation: None,
        };
        if leg.is_retired {
            return outcome;
        }
        let mut is_new_on_leg = true;
        let mut must_notify = true;
        match leg.servers.entry(update.server_name) {
            Entry::Occupied(mut held) if held.get().binding_key == key => {
                is_new_on_leg = false;
                let server = held.get_mut();
                match update.reading {
                    McpServerReading::Observed(status)
                        if !server.is_switched_off && server.status == Some(status) =>
                    {
                        server.observed_at = observed_at;
                        return outcome;
                    }
                    McpServerReading::Observed(status) => {
                        server.status = Some(status);
                        server.is_switched_off = false;
                        server.failure_text = update.failure_text;
                    }
                    // The last status and its text stay; the leg only leaves the aggregate.
                    McpServerReading::SwitchedOff => {
                        server.is_switched_off = true;
                        must_notify = false;
                    }
                }
                server.observed_at = observed_at;
            }
            Entry::Occupied(mut held) => {
                // The leg now serves the name from another binding, which leaves the old one.
                let moved_from = mem::replace(
                    held.get_mut(),
                    leg_server(
                        key.clone(),
                        update.reading,
                        update.failure_text,
                        observed_at,
                    ),
                );
                must_notify = update.reading != McpServerReading::SwitchedOff;
                if let Some(binding_status) = self.bindings.get_mut(&moved_from.binding_key) {
                    binding_status.legs.remove(&leg_id);
                }
                outcome.changes.extend(
                    self.refold(
                        &moved_from.binding_key,
                        ChangeOrigin::SessionFeed(leg_id.clone()),
                    )
                    .filter(StatusChange::is_change),
                );
            }
            Entry::Vacant(vacant) => {
                must_notify = update.reading != McpServerReading::SwitchedOff;
                vacant.insert(leg_server(
                    key.clone(),
                    update.reading,
                    update.failure_text,
                    observed_at,
                ));
            }
        }
        if is_new_on_leg {
            self.bindings
                .entry(key.clone())
                .or_insert_with(|| BindingStatus {
                    binding: binding.clone(),
                    legs: HashSet::new(),
                    probe: None,
                    aggregate: McpServerStatus::Unknown,
                })
                .legs
                .insert(leg_id.clone());
            if self.first_observed.insert(key.clone()) {
                outcome.first_observation = Some(binding.clone());
            }
        }
        outcome.changes.extend(
            self.refold(&key, ChangeOrigin::SessionFeed(leg_id))
                .filter(|change| must_notify || change.is_change()),
        );
        outcome
    }

    /// Retires `leg`: its servers leave every binding's aggregate, each touched binding answering
    /// a `sessionEnded` change, and what it reports later is ignored. The leg is forgotten at once
    /// when no sink of it is open, else when its last sink closes.
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
            changes.extend(self.refold(
                &server.binding_key,
                ChangeOrigin::SessionEnded(leg_id.clone()),
            ));
        }
        changes
    }

    /// Stores the machine probe's newest reading of `binding`. It is used only while no live leg
    /// holds a status, so a change answers only when the aggregate moved.
    pub(super) fn record_probe(
        &mut self,
        binding: &McpServerBindingRef,
        status: McpServerStatus,
        failure_text: Option<String>,
        observed_at: WireInstant,
    ) -> Option<StatusChange> {
        let key = McpBindingKey::of(binding);
        self.bindings
            .entry(key.clone())
            .or_insert_with(|| BindingStatus {
                binding: binding.clone(),
                legs: HashSet::new(),
                probe: None,
                aggregate: McpServerStatus::Unknown,
            })
            .probe = Some(ProbeReading {
            status,
            failure_text,
            observed_at,
        });
        self.refold(&key, ChangeOrigin::MachineProbe)
            .filter(StatusChange::is_change)
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

    /// Folds `key`'s status again, stores it, and answers the change from the stored aggregate;
    /// a binding left with no leg and no probe reading is forgotten, its aggregate `unknown`.
    fn refold(&mut self, key: &McpBindingKey, origin: ChangeOrigin) -> Option<StatusChange> {
        let binding_status = self.bindings.get(key)?;
        let folded = fold(&self.legs, key, binding_status);
        let change = StatusChange {
            binding_key: key.clone(),
            binding: binding_status.binding.clone(),
            origin,
            previous_status: binding_status.aggregate,
            status: folded.status,
            failure_text: folded.failure_text,
        };
        if binding_status.legs.is_empty() && binding_status.probe.is_none() {
            self.bindings.remove(key);
        } else if let Some(binding_status) = self.bindings.get_mut(key) {
            binding_status.aggregate = change.status;
        }
        Some(change)
    }
}

#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status core sends a notice per change")
)]
impl StatusChange {
    /// Whether the aggregate moved.
    fn is_change(&self) -> bool {
        self.previous_status != self.status
    }
}

/// A new leg entry for one reading.
#[cfg_attr(
    not(test),
    expect(dead_code, reason = "the status core keeps each leg's servers")
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
    expect(dead_code, reason = "the status core folds each binding")
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
    expect(dead_code, reason = "the status core folds each binding")
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
    expect(dead_code, reason = "the status core folds each binding")
)]
fn severity_rank(status: McpServerStatus) -> usize {
    MCP_SERVER_STATUS_SEVERITY_ORDER
        .iter()
        .position(|ranked| *ranked == status)
        .expect("the severity order lists every status")
}
