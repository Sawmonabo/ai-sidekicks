//! The account's rate-limit readings one service keeps, each change taken on the connection's
//! reader in arrival order and counted, so a filing tells a newer reading from an older one, and a
//! switch keeps the last readings of the account it left for the frames that arrived before it.
//! Complete reads keep Codex's own client's order: each is numbered as it is sent, its answer
//! dropped where a read sent after it was applied first; the pushes that arrive while it is out
//! are laid back over its answer, field by field per limit; and a hard-stop push drops every read
//! still out, since each left before the stop.

use std::collections::BTreeMap;
use std::mem;
use std::sync::Arc;

use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::transport::connection::CodexAnswerHook;
use crate::driver::codex::usage_limit_signal::{
    CodexRateLimitObservation, is_codex_hard_stop, observe_codex_rate_limit_read,
    observe_codex_rate_limit_update,
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
    // Each complete read still out, by the number it was sent under, with the pushes merged since
    // it was sent. One unanswered goes once a later read is applied.
    reads_out: BTreeMap<u64, CodexRateLimitObservation>,
    // How many complete reads were sent.
    reads_sent: u64,
}

impl CodexRateLimitReadings {
    /// Merges a pushed `account/rateLimits/updated` into the readings, and into what each read
    /// still out lays over its answer, or drops every such read where it is a hard stop; answers
    /// whether the readings changed.
    pub(super) fn merge_update(&mut self, update: &Value) -> bool {
        if is_codex_hard_stop(update) {
            self.reads_out.clear();
        } else {
            for pushed in self.reads_out.values_mut() {
                *pushed = observe_codex_rate_limit_update(mem::take(pushed), update);
            }
        }
        let merged = observe_codex_rate_limit_update(self.observation.clone(), update);
        if merged == self.observation {
            return false;
        }
        self.observation = merged;
        self.arrival += 1;
        true
    }

    // Numbers a complete read as it is sent and keeps it out.
    fn send_read(&mut self) -> u64 {
        self.reads_sent += 1;
        self.reads_out
            .insert(self.reads_sent, CodexRateLimitObservation::default());
        self.reads_sent
    }

    // Takes read `sent`'s answer, `None` where Codex answered with an error: the read's set with
    // every push since it was sent laid over it replaces the readings, and every read sent before
    // it is dropped; a read dropped already, by a hard stop or a later read applied first, changes
    // nothing.
    fn answer_read(&mut self, sent: u64, reply: Option<&Value>) {
        let Some(pushed) = self.reads_out.remove(&sent) else {
            return;
        };
        let Some(reply) = reply else {
            return;
        };
        self.reads_out = self.reads_out.split_off(&sent);
        let mut observation = observe_codex_rate_limit_read(reply);
        observation.lay_pushes_over(&pushed);
        self.replace(observation);
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

    /// Numbers a complete `account/rateLimits/read` about to be sent and answers the hook it is
    /// sent with: at its answer's place among the service's frames the read's set, with every push
    /// since it was sent laid over it, replaces the readings, unless a hard stop or a read sent
    /// after it was taken first; a push after the answer is merged over it. An answer that cannot
    /// be read changes nothing.
    pub(crate) fn rate_limit_read_hook(&self) -> CodexAnswerHook {
        let sent = self.lock_routing().rate_limits.send_read();
        let routing = Arc::clone(&self.routing);
        Box::new(move |answer: Option<&RawValue>| {
            let reply = answer.and_then(|reply| serde_json::from_str::<Value>(reply.get()).ok());
            lock(&routing).rate_limits.answer_read(sent, reply.as_ref());
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

#[cfg(test)]
mod tests {
    use serde_json::{Value, json};

    use super::CodexRateLimitReadings;
    use crate::driver::codex::usage_limit_signal::{
        CodexRateLimitObservation, observe_codex_rate_limit_read, observe_codex_rate_limit_update,
    };

    // A whole set of the `codex` limit whose five-hour window stands at `used`.
    fn whole_set(used: u32) -> Value {
        json!({"rateLimits": {
            "limitId": "codex",
            "primary": {"usedPercent": used, "windowDurationMins": 300},
        }})
    }

    // Fails when a read sent before a hard stop, or one answered after a read sent later was
    // applied, lands its older set over the readings.
    #[test]
    fn a_read_out_at_a_hard_stop_or_older_than_the_applied_one_changes_nothing() {
        let mut readings = CodexRateLimitReadings::default();
        let hard_stop = json!({"rateLimits": {
            "limitId": "codex",
            "rateLimitReachedType": "workspace_member_usage_limit_reached",
            "primary": {"usedPercent": 100, "windowDurationMins": 300},
        }});

        let out_at_the_stop = readings.send_read();
        readings.merge_update(&hard_stop);
        readings.answer_read(out_at_the_stop, Some(&whole_set(10)));
        let after_the_stop = readings.observation.clone();
        let older = readings.send_read();
        let newer = readings.send_read();
        readings.answer_read(newer, Some(&whole_set(30)));
        readings.answer_read(older, Some(&whole_set(20)));

        assert_eq!(
            after_the_stop,
            observe_codex_rate_limit_update(CodexRateLimitObservation::default(), &hard_stop)
        );
        assert_eq!(
            readings.observation,
            observe_codex_rate_limit_read(&whole_set(30))
        );
    }
}
