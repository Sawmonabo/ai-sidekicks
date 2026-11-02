//! The account's rate-limit readings one service keeps, each change taken on the connection's
//! reader in arrival order and counted, so a filing tells a newer reading from an older one, a
//! complete read lands at its answer's place among the pushes, and a switch keeps the last readings
//! of the account it left for the frames that arrived before it.

use std::mem;
use std::sync::Arc;

use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::transport::connection::CodexAnswerHook;
use crate::driver::codex::usage_limit_signal::{
    CodexRateLimitObservation, observe_codex_rate_limit_read, observe_codex_rate_limit_update,
};

/// The readings a service holds: the newest, how many changes they took, and the last readings of
/// the account a switch left. The account outlives a connection, so a reconnect keeps them.
#[derive(Default)]
pub(super) struct CodexRateLimitReadings {
    observation: CodexRateLimitObservation,
    // Raised at each change, on the reader, so its order is the frames' order.
    arrival: u64,
    // The account a switch left and its readings as the switch found them; one switch's worth.
    left: Option<(ProviderAccountId, CodexRateLimitObservation)>,
}

impl CodexRateLimitReadings {
    /// Merges a pushed `account/rateLimits/updated` into the readings; answers whether they
    /// changed.
    pub(super) fn merge_update(&mut self, update: &Value) -> bool {
        let merged = observe_codex_rate_limit_update(self.observation.clone(), update);
        if merged == self.observation {
            return false;
        }
        self.observation = merged;
        self.arrival += 1;
        true
    }

    fn replace(&mut self, observation: CodexRateLimitObservation) {
        self.observation = observation;
        self.arrival += 1;
    }
}

/// The readings as one filing takes them: the account they are read under, the readings, and
/// their place in the service's arrival order.
pub(crate) struct CodexRateLimitReading {
    /// The account the service ran on when the readings were taken.
    pub(crate) provider_account_id: Option<ProviderAccountId>,
    /// The readings.
    pub(crate) observation: CodexRateLimitObservation,
    /// How many changes the service's readings had taken; a larger one is newer.
    pub(crate) arrival: u64,
}

impl CodexService {
    /// The readings with the account they are read under and their arrival, taken together, so a
    /// switch landing between two reads never pairs one account with the other's readings.
    pub(crate) fn rate_limit_reading(&self) -> CodexRateLimitReading {
        let routing = self.lock_routing();
        CodexRateLimitReading {
            provider_account_id: self.provider_account_id(),
            observation: routing.rate_limits.observation.clone(),
            arrival: routing.rate_limits.arrival,
        }
    }

    /// The readings a frame of a conversation on `provider_account_id`'s account reads: the ones
    /// the last switch left while it left that account, since a frame queued before the switch
    /// landed belongs to it, and the service's own otherwise.
    pub(crate) fn rate_limit_observation_of(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> CodexRateLimitObservation {
        let routing = self.lock_routing();
        let readings = &routing.rate_limits;
        match &readings.left {
            Some((left, observation)) if left == provider_account_id => observation.clone(),
            Some(_) | None => readings.observation.clone(),
        }
    }

    /// The hook a complete `account/rateLimits/read` is sent with: at its answer's place among the
    /// service's frames it replaces the readings with the read's, so a push that arrives after the
    /// answer is merged over it and never under it. An answer that cannot be read changes nothing.
    pub(crate) fn rate_limit_read_hook(&self) -> CodexAnswerHook {
        let routing = Arc::clone(&self.routing);
        Box::new(move |answer: Option<&RawValue>| {
            let Some(reply) =
                answer.and_then(|reply| serde_json::from_str::<Value>(reply.get()).ok())
            else {
                return;
            };
            lock(&routing)
                .rate_limits
                .replace(observe_codex_rate_limit_read(&reply));
        })
    }

    /// Starts the readings afresh as a switch lands, keeping the account left with its last
    /// readings, and runs `carry`, which moves the service onto its new account, under the same
    /// hold, so no reading is ever taken with one account and the other's readings.
    pub(crate) fn restart_rate_limits(&self, carry: impl FnOnce()) {
        let mut routing = self.lock_routing();
        let left = self.provider_account_id();
        let readings = &mut routing.rate_limits;
        let observation = mem::take(&mut readings.observation);
        readings.left = left.map(|left| (left, observation));
        readings.arrival += 1;
        carry();
    }

    /// Replaces the readings with `observation`, as a complete read's answer does.
    #[cfg(test)]
    pub(crate) fn store_rate_limit_read(&self, observation: CodexRateLimitObservation) {
        self.lock_routing().rate_limits.replace(observation);
    }
}
