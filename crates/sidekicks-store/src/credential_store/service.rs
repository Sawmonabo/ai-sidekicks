//! The keychain services the daemon files its items under: one closed set, so a move and an erase
//! find every item the app made, orphans included, since no store keeps an attribute shared across
//! the app. No name holds a `.`, which the Windows Credential Manager reads as the line between the
//! account and the service.

/// A keychain service the daemon files items under; each feature that keeps a secret has its own.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeychainService {
    /// The workflow secrets' values, each under its secret's id.
    WorkflowSecrets,
    /// The write-probe-read-delete check's item, under a fresh account each start.
    Probe,
    /// This machine's identity key and channel key, under `identity-<machine id>` and
    /// `channel-<machine id>`.
    MachineKeys,
    /// The delivery channels' secrets: the web address and its signing secret.
    DeliverySecrets,
}

impl KeychainService {
    /// Every service, in the order a move and an erase walk them.
    pub(crate) const ALL: [Self; 4] = [
        Self::WorkflowSecrets,
        Self::Probe,
        Self::MachineKeys,
        Self::DeliverySecrets,
    ];

    /// The service's name in the store.
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::WorkflowSecrets => "ai-sidekicks-workflow-secrets",
            Self::Probe => "ai-sidekicks-probe",
            Self::MachineKeys => "ai-sidekicks-machine-keys",
            Self::DeliverySecrets => "ai-sidekicks-delivery-secrets",
        }
    }

    /// Whether a move carries the service's items: the probe's item belongs to one start's check
    /// and an erase sweeps any left behind.
    pub(crate) const fn is_moved(self) -> bool {
        match self {
            Self::WorkflowSecrets | Self::MachineKeys | Self::DeliverySecrets => true,
            Self::Probe => false,
        }
    }
}
