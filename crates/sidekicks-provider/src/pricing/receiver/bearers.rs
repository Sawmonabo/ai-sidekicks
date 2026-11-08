//! The live telemetry bearers: one token per provider process or launch that exports, minted for
//! its provider and the holder its driver names it by, admitted only while its holder keeps it.

use std::sync::{Arc, Mutex, Weak};

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::mutex_lock::lock;

use crate::bearer_token::{BEARER_PREFIX, BearerToken};

/// The number a driver names the one process or launch a bearer was minted for by.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub struct TelemetryHolderId(u64);

impl TelemetryHolderId {
    /// The holder the driver numbers `number`.
    pub fn new(number: u64) -> Self {
        Self(number)
    }

    /// The number the driver named the holder by.
    pub fn number(self) -> u64 {
        self.0
    }
}

/// The registry of every live bearer, which the receiver resolves each export's token against.
#[derive(Default)]
pub struct TelemetryBearers {
    // Held only for one mint's insert, one drop's removal or one resolve's compares.
    live: Mutex<Vec<LiveBearer>>,
}

// One live bearer: the provider it was minted for, its holder and its token, which its guard
// shares and whose allocation names the entry.
struct LiveBearer {
    provider: ProviderId,
    holder: TelemetryHolderId,
    token: Arc<BearerToken>,
}

impl TelemetryBearers {
    /// Mints a token for `holder`, a process or launch of `provider`, admitted until the answered
    /// guard drops. Fails when the system's random source cannot be read.
    pub fn mint(
        self: &Arc<Self>,
        provider: ProviderId,
        holder: TelemetryHolderId,
    ) -> Result<TelemetryBearer, getrandom::Error> {
        let token = Arc::new(BearerToken::mint()?);
        lock(&self.live).push(LiveBearer {
            provider,
            holder,
            token: Arc::clone(&token),
        });
        Ok(TelemetryBearer {
            bearers: Arc::downgrade(self),
            holder,
            token,
        })
    }

    /// The holder of the live bearer `authorization`, a request's `Authorization` header,
    /// presents on `provider`'s path; `None` for a token never minted, one whose guard dropped and
    /// one minted for another provider.
    pub fn resolve(
        &self,
        provider: &ProviderId,
        authorization: Option<&[u8]>,
    ) -> Option<TelemetryHolderId> {
        lock(&self.live)
            .iter()
            .find(|live| &live.provider == provider && live.token.admits(authorization))
            .map(|live| live.holder)
    }
}

/// The guard of one minted bearer, which its holder keeps for as long as the process or launch
/// exports; its drop refuses the token from then on.
pub struct TelemetryBearer {
    bearers: Weak<TelemetryBearers>,
    holder: TelemetryHolderId,
    token: Arc<BearerToken>,
}

impl TelemetryBearer {
    /// The OTLP exporters' headers setting that presents the token, `authorization=Bearer <token>`,
    /// which an exporter splits at its first `=`; Claude's settings file takes the same value.
    pub fn exporter_headers(&self) -> String {
        format!("authorization={BEARER_PREFIX}{}", self.token.text())
    }

    /// The process or launch the bearer was minted for.
    pub fn holder(&self) -> TelemetryHolderId {
        self.holder
    }
}

impl Drop for TelemetryBearer {
    fn drop(&mut self) {
        if let Some(bearers) = self.bearers.upgrade() {
            lock(&bearers.live).retain(|live| !Arc::ptr_eq(&live.token, &self.token));
        }
    }
}
