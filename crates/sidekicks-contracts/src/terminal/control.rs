//! The per-shell control lease: who holds a shell, taking it, the broadcast of each change of
//! holder, the refusal that names the holder, and the flow-control signal.
//!
//! The lease is one per shell, held by one of the person's devices or by an agent's running
//! command on this machine. A run's hold carries this machine's device id, the run's id and the
//! holding command's id, so a screen can tell "this device", "another device" and "a run" apart and
//! stop the command. There is no release: a device's hold is bound to each connection and pane
//! output subscription it was taken or written through, either one ending ends that binding, and
//! the hold ends with its last or when another device takes the shell; a run's hold ends when its
//! command ends or the run leaves its running state. Every change of holder raises the shell's
//! lease version by one, so a client keeps whichever reading of the holder is newest.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::command::CommandId;
use crate::jsonrpc::streaming::SubscriptionId;
use crate::method::methods;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::terminal::TerminalId;
use crate::trust_statement::DeviceId;
use crate::wire::integer::SafeInt;
use crate::wire::{Never, NullableSchema, True, nullable};

/// How many times a shell's holder has changed; a shell opens at 0.
pub type LeaseVersion = SafeInt<0>;

/// A run holds a shell only through one of its running commands, so a hold names both or neither:
/// a run without its command leaves nothing to stop, and a command without its run names no agent.
fn run_hold_names_its_command(has_run: bool, has_command: bool) -> garde::Result {
    if has_run == has_command {
        Ok(())
    } else {
        Err(garde::Error::new(
            "a run's hold names the run and its holding command together",
        ))
    }
}

/// Declares a struct naming a shell's holder, with the members the caller adds.
macro_rules! terminal_holder {
    ($(#[doc = $doc:literal])+ $name:ident { $($extra:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[garde(allow_unvalidated)]
        #[schemars(extend("dependentRequired" = {
            "holderRunId": ["holderCommandId"],
            "holderCommandId": ["holderRunId"],
        }))]
        pub struct $name {
            $($extra)*
            /// The holding device: this machine's own while a run holds the shell.
            pub holder_device_id: DeviceId,
            /// The holding run, whose agent the screen reads from the run.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "RunId")]
            pub holder_run_id: Option<RunId>,
            /// The holding command, which is what stopping the hold stops.
            #[serde(
                default,
                skip_serializing_if = "Option::is_none",
                deserialize_with = "crate::wire::present"
            )]
            #[schemars(with = "CommandId")]
            #[garde(custom(|command: &Option<CommandId>, (): &()| {
                run_hold_names_its_command(self.holder_run_id.is_some(), command.is_some())
            }))]
            pub holder_command_id: Option<CommandId>,
        }
    };
}

terminal_holder! {
    /// Who holds one shell's control lease; a run's hold names its command.
    TerminalControlHolder {}
}

terminal_holder! {
    /// The `terminal.control.heldByOther` refusal's details: the shell and who holds it, so the
    /// screen can tell a run's hold, which ends with its command and which no take moves, from
    /// another device's, which a forced take or close moves.
    TerminalControlHeldByOtherDetails {
        /// The shell.
        pub terminal_id: TerminalId,
    }
}

/// `terminal.control.take`: takes one shell's lease for the calling connection, bound to
/// `outputSubscriptionId`, the taking pane's own `terminal.output.subscribe` subscription to that
/// shell, whose end gives the hold back. `force` moves it off another of the person's devices; a
/// take never moves it off a run.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalControlTakeRequest {
    /// The session.
    pub session_id: SessionId,
    /// The shell.
    pub terminal_id: TerminalId,
    /// The taking pane's output subscription.
    pub output_subscription_id: SubscriptionId,
    /// Whether to move the shell off another device.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub force: Option<bool>,
}

/// The shell and the calling device, which now holds it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalControlTakeResponse {
    /// The shell.
    pub terminal_id: TerminalId,
    /// The calling device.
    pub holder_device_id: DeviceId,
}

/// `terminal.flowControl.update`: the state this connection declares for one shell, `paused`
/// while it is behind, false once it has caught up. The daemon stops reading the shell only while
/// every live watcher is behind, and a connection's state clears when it disconnects. Not gated by
/// the lease: it moves no bytes toward the shell. A call naming a shell its session does not have
/// changes nothing and is not refused.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalFlowControlUpdateRequest {
    /// The session.
    pub session_id: SessionId,
    /// The shell.
    pub terminal_id: TerminalId,
    /// Whether the connection is behind.
    pub paused: bool,
}

/// The declared state was taken; nothing is read back.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct TerminalFlowControlUpdateResponse {
    /// Always true.
    pub accepted: True,
}

/// Why a shell's holder changed: it was taken, taken by force off another device, the holding
/// connection ended, the pane's output subscription it was taken through closed, the holding run's
/// command ended, or the holding run left its running state. A run's two releases hand the shell
/// back to the device the run took it from, while one of that device's bindings is open.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum TerminalControlChangedReason {
    /// Taken.
    Taken,
    /// Taken by force off another device.
    TakenByForce,
    /// The holding connection ended.
    AutoReleasedDisconnect,
    /// The pane's output subscription it was taken through closed.
    AutoReleasedPaneClosed,
    /// The holding run's command ended.
    AutoReleasedCommandEnded,
    /// The holding run left its running state.
    AutoReleasedRunIdle,
}

/// Declares `TerminalControlChangedPayload` with the members every reason repeats.
macro_rules! control_changed_payload {
    ($($(#[doc = $doc:literal])+ $arm:ident { $($fields:tt)* })+) => {
        /// The `terminal.control.changed` payload: one change of one shell's holder. The holder
        /// members name who holds it after the change, `previousHolderDeviceId` who held it before,
        /// and `leaseVersion` the change's lease version. A take names a holder, every release
        /// names the holder it ended, a disconnect or a closed pane names nobody after it, a run's
        /// release names the device it hands the shell back to or nobody, and a forced take moves
        /// the shell off another device to a device. Clients keep the newest version they have read
        /// and never infer a holder from a take they made.
        #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(
            tag = "reason",
            rename_all = "camelCase",
            rename_all_fields = "camelCase",
            deny_unknown_fields
        )]
        #[garde(allow_unvalidated)]
        #[garde(custom(|payload: &Self, (): &()| payload.names_its_run_hold_whole()))]
        #[schemars(extend("type" = "object", "dependentRequired" = {
            "holderRunId": ["holderCommandId"],
            "holderCommandId": ["holderRunId"],
        }))]
        pub enum TerminalControlChangedPayload {$(
            $(#[doc = $doc])+
            $arm {
                /// The session.
                session_id: SessionId,
                /// The shell.
                terminal_id: TerminalId,
                /// The change's lease version.
                lease_version: SafeInt<1>,
                $($fields)*
            },
        )+}
    };
}

/// Declares the members of a release that leaves no run holding the shell, `$holder` naming the
/// device after it.
macro_rules! release_arms {
    ($($(#[doc = $doc:literal])+ $arm:ident($holder:ty, $holder_schema:literal);)+) => {
        control_changed_payload! {
            /// Taken: by a device, or by a run through its command.
            Taken {
                /// The device holding it after the take.
                holder_device_id: DeviceId,
                /// The holding run.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "RunId")]
                holder_run_id: Option<RunId>,
                /// The holding command.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "CommandId")]
                holder_command_id: Option<CommandId>,
                /// The device that held it before, or `null`.
                #[serde(deserialize_with = "nullable")]
                #[schemars(with = "NullableSchema<DeviceId>")]
                previous_holder_device_id: Option<DeviceId>,
            }
            /// Taken by force off another device, by a device.
            TakenByForce {
                /// The device holding it after the take.
                holder_device_id: DeviceId,
                /// Never present: no run takes a shell by force.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                holder_run_id: Option<Never>,
                /// Never present: no run takes a shell by force.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                holder_command_id: Option<Never>,
                /// The device it was moved off.
                previous_holder_device_id: DeviceId,
            }
            $(
                $(#[doc = $doc])+
                $arm {
                    /// The device holding it after the release.
                    #[serde(deserialize_with = "nullable")]
                    #[schemars(with = $holder_schema)]
                    holder_device_id: $holder,
                    /// Never present: a release leaves no run holding the shell.
                    #[serde(
                        default,
                        skip_serializing_if = "Option::is_none",
                        deserialize_with = "crate::wire::present"
                    )]
                    #[schemars(with = "Never")]
                    holder_run_id: Option<Never>,
                    /// Never present: a release leaves no run holding the shell.
                    #[serde(
                        default,
                        skip_serializing_if = "Option::is_none",
                        deserialize_with = "crate::wire::present"
                    )]
                    #[schemars(with = "Never")]
                    holder_command_id: Option<Never>,
                    /// The holder the release ended.
                    previous_holder_device_id: DeviceId,
                }
            )+
        }
    };
}

release_arms! {
    /// The holding connection ended; nobody holds the shell after it.
    AutoReleasedDisconnect(Option<Never>, "NullableSchema<Never>");
    /// The pane's output subscription closed; nobody holds the shell after it.
    AutoReleasedPaneClosed(Option<Never>, "NullableSchema<Never>");
    /// The holding run's command ended; the shell goes back to the device the run took it from,
    /// or to nobody.
    AutoReleasedCommandEnded(Option<DeviceId>, "NullableSchema<DeviceId>");
    /// The holding run left its running state; the shell goes back to the device the run took it
    /// from, or to nobody.
    AutoReleasedRunIdle(Option<DeviceId>, "NullableSchema<DeviceId>");
}

impl TerminalControlChangedPayload {
    /// Whether a take's hold names its run and command together; every other arm names no run.
    fn names_its_run_hold_whole(&self) -> garde::Result {
        match self {
            Self::Taken {
                holder_run_id,
                holder_command_id,
                ..
            } => run_hold_names_its_command(holder_run_id.is_some(), holder_command_id.is_some()),
            Self::TakenByForce { .. }
            | Self::AutoReleasedDisconnect { .. }
            | Self::AutoReleasedPaneClosed { .. }
            | Self::AutoReleasedCommandEnded { .. }
            | Self::AutoReleasedRunIdle { .. } => Ok(()),
        }
    }
}

methods! {
    /// The two `session.*` methods that act on one shell: the lease take and flow control.
    pub const TERMINAL_CONTROL_METHOD_DESCRIPTORS = [
        /// Takes one shell's lease.
        TerminalControlTake = mutation "terminal.control.take" {
            mutating: true,
            params: TerminalControlTakeRequest,
            result: TerminalControlTakeResponse,
            refusals: [
                SessionNotFound,
                TerminalNotFound,
                TerminalControlHeldByOther,
                TerminalOutputSubscriptionNotFound,
            ],
        },
        /// Declares whether this connection is behind on one shell.
        TerminalFlowControlUpdate = mutation "terminal.flowControl.update" {
            mutating: true,
            params: TerminalFlowControlUpdateRequest,
            result: TerminalFlowControlUpdateResponse,
            refusals: [SessionNotFound],
        },
    ];
}
