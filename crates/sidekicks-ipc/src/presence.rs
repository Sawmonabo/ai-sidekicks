//! The presence register: the last heartbeat each connection carried, filed under the device of
//! that connection, held in memory only. A device is connected while any connection that carried
//! its heartbeat is open, and shows its newest heartbeat across them; it leaves when the last one
//! closes. The register answers `presence.read`, pushes each change to `presence.subscribe`, and
//! says whether an app window is in front on any device.

use std::collections::{BTreeMap, HashMap};
use std::sync::Mutex;

use sidekicks_contracts::presence::{
    ConnectedDevice, MachinePresence, PresenceHeartbeatSendRequest,
};
use sidekicks_contracts::trust_statement::DeviceId;
use sidekicks_std::mutex_lock::lock;

use crate::registry::TransportId;
use crate::stream::latest_value::{LatestValueOutlet, LatestValueOutletId, LatestValueOutlets};

/// The devices connected to this machine, from the heartbeats their connections carried.
#[derive(Default)]
pub struct PresenceRegister {
    state: Mutex<PresenceState>,
}

struct PresenceState {
    heartbeats: HashMap<TransportId, ConnectionHeartbeat>,
    // Raised on each heartbeat, so a device shows the newest of its connections' heartbeats.
    next_order: u64,
    // The devices as last derived and sent, so a heartbeat that changes nothing sends nothing.
    presence: MachinePresence,
    outlets: LatestValueOutlets<MachinePresence>,
}

impl Default for PresenceState {
    fn default() -> Self {
        Self {
            heartbeats: HashMap::new(),
            next_order: 0,
            presence: MachinePresence {
                devices: Vec::new(),
            },
            outlets: LatestValueOutlets::default(),
        }
    }
}

struct ConnectionHeartbeat {
    device: ConnectedDevice,
    order: u64,
}

impl PresenceRegister {
    /// Files `heartbeat` under `device_id` as the last one `transport` carried, pushing the
    /// devices to every subscriber when what they show changed.
    pub fn record_heartbeat(
        &self,
        transport: TransportId,
        device_id: DeviceId,
        heartbeat: PresenceHeartbeatSendRequest,
    ) {
        let mut state = lock(&self.state);
        let order = state.next_order;
        state.next_order += 1;
        state.heartbeats.insert(
            transport,
            ConnectionHeartbeat {
                device: ConnectedDevice {
                    device_id,
                    device_type: heartbeat.device_type,
                    app_visible: heartbeat.app_visible,
                },
                order,
            },
        );
        state.push_if_changed();
    }

    /// Drops the heartbeat the closed connection `transport` carried; its device leaves only when
    /// no other open connection carried one of its heartbeats.
    pub fn cleanup_transport(&self, transport: TransportId) {
        let mut state = lock(&self.state);
        if state.heartbeats.remove(&transport).is_some() {
            state.push_if_changed();
        }
    }

    /// The devices connected now.
    pub fn read(&self) -> MachinePresence {
        lock(&self.state).presence.clone()
    }

    /// Whether an app window is in front on any connected device.
    pub fn is_app_visible_on_any_device(&self) -> bool {
        lock(&self.state)
            .presence
            .devices
            .iter()
            .any(|device| device.app_visible)
    }

    /// Sends the devices connected now through `outlet` and keeps it for every change, answering
    /// the id [`PresenceRegister::detach`] drops it by.
    pub fn follow(&self, outlet: LatestValueOutlet<MachinePresence>) -> LatestValueOutletId {
        let mut state = lock(&self.state);
        outlet.send(state.presence.clone());
        state.outlets.attach(outlet)
    }

    /// Drops the outlet `id` names; an id already dropped changes nothing.
    pub fn detach(&self, id: LatestValueOutletId) {
        lock(&self.state).outlets.detach(id);
    }
}

impl PresenceState {
    // Derives the devices from the heartbeats, one per device in id order, and sends them when
    // they differ from what was last sent.
    fn push_if_changed(&mut self) {
        let mut newest: BTreeMap<&DeviceId, &ConnectionHeartbeat> = BTreeMap::new();
        for heartbeat in self.heartbeats.values() {
            newest
                .entry(&heartbeat.device.device_id)
                .and_modify(|held| {
                    if heartbeat.order > held.order {
                        *held = heartbeat;
                    }
                })
                .or_insert(heartbeat);
        }
        let presence = MachinePresence {
            devices: newest
                .into_values()
                .map(|heartbeat| heartbeat.device.clone())
                .collect(),
        };
        if presence != self.presence {
            self.outlets.send(&presence);
            self.presence = presence;
        }
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::presence::DeviceType;

    use super::*;

    fn heartbeat(app_visible: bool) -> PresenceHeartbeatSendRequest {
        PresenceHeartbeatSendRequest {
            device_type: DeviceType::new("desktop".to_owned()).expect("the type is well formed"),
            app_visible,
        }
    }

    #[test]
    fn a_device_leaves_only_when_its_last_connection_closes() {
        let register = PresenceRegister::default();
        let laptop = DeviceId::new("laptop".to_owned()).expect("the id is well formed");
        register.record_heartbeat(TransportId(1), laptop.clone(), heartbeat(false));
        register.record_heartbeat(TransportId(2), laptop.clone(), heartbeat(true));
        let devices = register.read().devices;
        assert_eq!(
            devices.len(),
            1,
            "two connections of one device list it once"
        );
        assert!(devices[0].app_visible, "it shows its newest heartbeat");

        register.cleanup_transport(TransportId(2));
        let devices = register.read().devices;
        assert_eq!(devices.len(), 1, "the device keeps its open connection");
        assert_eq!(devices[0].device_id, laptop);
        assert!(
            !devices[0].app_visible,
            "it shows the open connection's heartbeat"
        );

        register.cleanup_transport(TransportId(1));
        assert!(
            register.read().devices.is_empty(),
            "its last connection closed"
        );
    }
}
