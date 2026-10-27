//! The zero-turn read of which capability flags a provider's build carries, shared by every driver:
//! each driver hands over its own rules and exchange, and the read only ever withdraws a flag the
//! driver declares. The capability reading every driver answers is composed here from it.

use std::collections::BTreeMap;
use std::error::Error;
use std::path::PathBuf;

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::tools::ProviderToolMetadata;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::wire::text::FreeFormText;
use strum::VariantArray;

use crate::driver::ProviderDescriptor;
use crate::driver::capabilities::{
    DriverCapabilities, DriverCapabilityFlag, DriverCapabilityFlags,
};
use crate::driver::contract::{CapabilityDetectionSource, DriverError, GetCapabilitiesResult};
use crate::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};
use crate::driver::is_same_text;
use crate::spawned_version::SpawnedProviderVersionReading;

/// One condition a probe must meet to decide a flag; a flag read from the driver's own table names
/// each one no probe of it meets.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProbeAdmissibilityConjunct {
    /// The probe spends no turn.
    ZeroTurn,
    /// The probe changes nothing the session owns.
    NonMutating,
    /// The probe's answer decides the flag at the granularity its consumers use it.
    DecisiveAtConsumptionGranularity,
}

/// How one capability flag's value is reached for one driver.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CapabilityDetection {
    /// From the driver's own table, since no admissible probe decides the flag.
    Static {
        /// The conditions no probe of the flag meets; never empty.
        failing_conjuncts: &'static [ProbeAdmissibilityConjunct],
    },
    /// By sending each name with no payload: every one must be accepted, and the first that is not
    /// withdraws the flag.
    Probed {
        /// The wire names sent, in order; never empty.
        probe_names: &'static [&'static str],
    },
}

impl CapabilityDetection {
    /// The source a reading reports for a flag decided this way.
    pub(crate) fn source(self) -> CapabilityDetectionSource {
        match self {
            Self::Static { .. } => CapabilityDetectionSource::Static,
            Self::Probed { .. } => CapabilityDetectionSource::Probed,
        }
    }
}

/// What one probe's reply says about its name. `Accepted` includes a handler's own typed refusal;
/// only a refusal of the name itself reads `UnknownName`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ProbeAnswer {
    /// The provider knows the name.
    Accepted,
    /// The provider refused the name itself.
    UnknownName,
    /// The reply could not be read either way; it withdraws, never reading as availability.
    Unrecognized,
}

/// One driver's probe rules, a constant of its own module that it hands to the read.
pub(crate) struct CapabilityProbeRules {
    /// How each flag is decided: a `match` over every flag.
    pub(crate) detection: fn(DriverCapabilityFlag) -> CapabilityDetection,
    /// A name the probe channel must refuse; a channel that answered it would report every
    /// capability available. Sent first, and only when some flag is probed.
    pub(crate) negative_control: &'static str,
    /// Wire names no probe may send, refused at every dispatch: each would change a session or
    /// start a turn, and a probe must leave the provider as it found it.
    pub(crate) prohibited_names: &'static [&'static str],
    /// Reads one reply; the second argument is the name it answers.
    pub(crate) classify_reply: fn(&Value, &str) -> ProbeAnswer,
}

/// A driver's exchange of one probe: the name sent with no payload on a connection that has never
/// started a conversation or sent a message, and the provider's reply, untrusted. The implementer
/// owns the deadline.
pub(crate) trait CapabilityProbeExchange {
    /// Sends `probe_name` and answers its reply; an error when no reply came.
    fn exchange(
        &mut self,
        probe_name: &'static str,
    ) -> BoxFuture<'_, Result<Value, Box<dyn Error + Send + Sync>>>;
}

/// A failure of the probe read itself, which leaves no reading: nothing is declared from it.
#[derive(Debug, thiserror::Error)]
pub enum CapabilityProbeError {
    /// The negative control was answered, so the channel's refusals cannot be trusted.
    #[error(
        "the capability probe's negative control `{probe_name}` was answered by provider `{}`, \
         so its channel's refusals cannot be trusted",
        .provider.as_str()
    )]
    NegativeControlAnswered {
        /// The provider whose channel answered.
        provider: ProviderId,
        /// The control's name.
        probe_name: &'static str,
    },
    /// The exchange failed, so no reply exists.
    #[error(
        "the capability probe `{probe_name}` could not be exchanged with provider `{}`",
        .provider.as_str()
    )]
    Transport {
        /// The provider the probe was for.
        provider: ProviderId,
        /// The name being sent.
        probe_name: &'static str,
        /// Why the exchange failed.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// A name no probe may send reached the dispatch.
    #[error("the capability probe refused `{probe_name}`, a wire name no probe may send")]
    ProhibitedName {
        /// The refused name.
        probe_name: &'static str,
    },
}

/// Why a probe withdrew a flag.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WithdrawalReason {
    /// The provider refused the name.
    UnknownName,
    /// The reply could not be read.
    UnrecognizedReply,
}

/// One flag a probe withdrew: the first of its names, in table order, that was not accepted, and
/// why; the flag's later names are not sent on its account.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CapabilityWithdrawal {
    /// The withdrawn flag.
    pub(crate) flag: DriverCapabilityFlag,
    /// The name whose reply withdrew it.
    pub(crate) probe_name: &'static str,
    /// What that reply said.
    pub(crate) reason: WithdrawalReason,
}

/// One live detection reading for one provider build.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CapabilityDetectionReading {
    /// The provider read.
    pub(crate) provider: ProviderId,
    /// The build this reading describes, as the version handshake resolved it, so a reading of
    /// another build is never mixed into its report.
    pub(crate) bound_executable_path: PathBuf,
    /// How each flag was decided, every flag present.
    pub(crate) detection_source: BTreeMap<DriverCapabilityFlag, CapabilityDetectionSource>,
    /// Each flag its probe withdrew, in flag order.
    pub(crate) withdrawals: Vec<CapabilityWithdrawal>,
}

impl CapabilityDetectionReading {
    /// `declared` with every flag this reading withdrew turned off. A probe never turns a flag on,
    /// since a build must not be reported as carrying what the driver's code does not implement.
    pub(crate) fn apply_to(&self, declared: &DriverCapabilityFlags) -> DriverCapabilityFlags {
        DriverCapabilityFlags::from_fn(|flag| {
            declared.is_on(flag)
                && !self
                    .withdrawals
                    .iter()
                    .any(|withdrawal| withdrawal.flag == flag)
        })
    }

    /// Reports each flag this reading withdrew as a diagnostic of its own, apart from a failed
    /// read: the read worked, but the build carries less than the driver declares. Reports nothing
    /// when every flag was accepted.
    pub(crate) fn report_withdrawals(&self) {
        for withdrawal in &self.withdrawals {
            let (reason, disposition_reason) = match withdrawal.reason {
                WithdrawalReason::UnknownName => (
                    "unknownName",
                    "the probe channel refused the wire name itself, so this build lacks what the \
                     flag declares; flag withdrawn",
                ),
                WithdrawalReason::UnrecognizedReply => (
                    "unrecognizedReply",
                    "the probe's reply could not be classified, and an unread reply never counts \
                     as available; flag withdrawn",
                ),
            };
            emit_driver_diagnostic(&DriverDiagnosticRecord {
                provider: self.provider.clone(),
                provider_account_id: None,
                kind: DriverDiagnosticKind::CapabilityFlagWithdrawn,
                raw_wire_type: Some(withdrawal.probe_name.to_owned()),
                disposition_reason: disposition_reason.to_owned(),
                details: Map::from_iter([
                    (
                        "flag".to_owned(),
                        Value::from(<&str>::from(withdrawal.flag)),
                    ),
                    ("probeName".to_owned(), Value::from(withdrawal.probe_name)),
                    ("disposition".to_owned(), Value::from(reason)),
                    (
                        "boundExecutablePath".to_owned(),
                        Value::from(self.bound_executable_path.to_string_lossy()),
                    ),
                ]),
            });
        }
    }
}

/// Reads which of `rules`' probed flags the build at `bound_executable_path` carries, through
/// `exchange`: the negative control first, then each distinct name once, in flag order; with no
/// flag probed, nothing is sent. An error when the control is answered, an exchange fails or a
/// prohibited name would be sent.
pub(crate) async fn read_capability_detection(
    provider: ProviderId,
    rules: &CapabilityProbeRules,
    bound_executable_path: PathBuf,
    exchange: &mut impl CapabilityProbeExchange,
) -> Result<CapabilityDetectionReading, CapabilityProbeError> {
    let flags = DriverCapabilityFlag::VARIANTS;
    let is_any_probed = flags
        .iter()
        .any(|flag| matches!((rules.detection)(*flag), CapabilityDetection::Probed { .. }));
    // First: a channel that answers a name that cannot exist would accept every probe.
    if is_any_probed {
        let answer = dispatch_probe(&provider, rules, rules.negative_control, exchange).await?;
        if answer != ProbeAnswer::UnknownName {
            return Err(CapabilityProbeError::NegativeControlAnswered {
                provider,
                probe_name: rules.negative_control,
            });
        }
    }

    let mut answers: Vec<(&'static str, ProbeAnswer)> = Vec::new();
    let mut detection_source = BTreeMap::new();
    let mut withdrawals = Vec::new();
    for &flag in flags {
        let detection = (rules.detection)(flag);
        detection_source.insert(flag, detection.source());
        let CapabilityDetection::Probed { probe_names } = detection else {
            continue;
        };
        for &probe_name in probe_names {
            let answer =
                if let Some(&(_, answer)) = answers.iter().find(|(name, _)| *name == probe_name) {
                    answer
                } else {
                    let answer = dispatch_probe(&provider, rules, probe_name, exchange).await?;
                    answers.push((probe_name, answer));
                    answer
                };
            let reason = match answer {
                ProbeAnswer::Accepted => continue,
                ProbeAnswer::UnknownName => WithdrawalReason::UnknownName,
                ProbeAnswer::Unrecognized => WithdrawalReason::UnrecognizedReply,
            };
            withdrawals.push(CapabilityWithdrawal {
                flag,
                probe_name,
                reason,
            });
            break;
        }
    }
    Ok(CapabilityDetectionReading {
        provider,
        bound_executable_path,
        detection_source,
        withdrawals,
    })
}

/// Reads the capabilities of the build `version` describes for the provider `descriptor` names:
/// probes that same build through `exchange` under `rules`, reports each flag the probe withdrew,
/// and composes `declared` narrowed by the probe, `contract_version`, `tools`, the version the
/// build printed and the descriptor's output-speed levels where the output-speed flag resolved on.
/// Fails with [`DriverError::CapabilityProbe`] when the probe read fails.
pub(crate) async fn read_provider_capabilities(
    descriptor: &ProviderDescriptor,
    rules: &CapabilityProbeRules,
    declared: &DriverCapabilityFlags,
    contract_version: &'static str,
    tools: Vec<ProviderToolMetadata>,
    version: &SpawnedProviderVersionReading,
    exchange: &mut impl CapabilityProbeExchange,
) -> Result<GetCapabilitiesResult, DriverError> {
    // Bound to the version reading's own path, so the flags describe the build whose version is
    // reported.
    let detection = read_capability_detection(
        descriptor.provider_id(),
        rules,
        version.resolved_executable_path.clone(),
        exchange,
    )
    .await
    .map_err(DriverError::CapabilityProbe)?;
    detection.report_withdrawals();
    let flags = detection.apply_to(declared);
    let output_speed_levels =
        descriptor.static_output_speed_levels(flags.is_on(DriverCapabilityFlag::OutputSpeed));
    Ok(GetCapabilitiesResult {
        capabilities: DriverCapabilities {
            flags,
            contract_version: FreeFormText::new(contract_version.to_owned())
                .expect("a driver's contract version is non-blank and within its cap"),
        },
        tools,
        cli_version: version.report.clone(),
        detection_source: Some(detection.detection_source),
        output_speed_levels,
    })
}

async fn dispatch_probe(
    provider: &ProviderId,
    rules: &CapabilityProbeRules,
    probe_name: &'static str,
    exchange: &mut impl CapabilityProbeExchange,
) -> Result<ProbeAnswer, CapabilityProbeError> {
    // Screened here as well as by each driver's table check, so a name from anywhere is refused.
    if rules.prohibited_names.contains(&probe_name) {
        return Err(CapabilityProbeError::ProhibitedName { probe_name });
    }
    let reply =
        exchange
            .exchange(probe_name)
            .await
            .map_err(|source| CapabilityProbeError::Transport {
                provider: provider.clone(),
                probe_name,
                source,
            })?;
    Ok((rules.classify_reply)(&reply, probe_name))
}

/// Whether `detection` is admissible: a static flag names at least one failing conjunct, and a
/// probed flag sends at least one name, none empty and none of `prohibited_names`. Each driver
/// asserts it over its whole table when it compiles.
pub(crate) const fn is_detection_admissible(
    detection: CapabilityDetection,
    prohibited_names: &[&str],
) -> bool {
    let probe_names = match detection {
        CapabilityDetection::Static { failing_conjuncts } => return !failing_conjuncts.is_empty(),
        CapabilityDetection::Probed { probe_names } => probe_names,
    };
    if probe_names.is_empty() {
        return false;
    }
    let mut i = 0;
    while i < probe_names.len() {
        if probe_names[i].is_empty() {
            return false;
        }
        let mut j = 0;
        while j < prohibited_names.len() {
            if is_same_text(probe_names[i], prohibited_names[j]) {
                return false;
            }
            j += 1;
        }
        i += 1;
    }
    true
}

/// Fails the build when a driver's detection table probes a name that may not be sent or declares a
/// flag static without naming a failing conjunct: its `const fn` table and its prohibited names,
/// checked over every flag.
macro_rules! assert_admissible_detection {
    ($detection_of:path, $prohibited_names:expr) => {
        const _: () = {
            use ::strum::VariantArray as _;
            let flags = $crate::driver::capabilities::DriverCapabilityFlag::VARIANTS;
            let mut i = 0;
            while i < flags.len() {
                assert!(
                    $crate::capability::probe::is_detection_admissible(
                        $detection_of(flags[i]),
                        $prohibited_names,
                    ),
                    "a static flag names no failing conjunct, or a probed flag sends no name, an \
                     empty name or a prohibited name"
                );
                i += 1;
            }
        };
    };
}
pub(crate) use assert_admissible_detection;

#[cfg(test)]
mod tests {
    use std::error::Error;
    use std::path::PathBuf;

    use futures::future::BoxFuture;
    use serde_json::{Value, json};
    use sidekicks_contracts::provider::id::ProviderId;

    use super::{
        CapabilityDetection, CapabilityProbeError, CapabilityProbeExchange, CapabilityProbeRules,
        CapabilityWithdrawal, ProbeAdmissibilityConjunct, ProbeAnswer, WithdrawalReason,
        read_capability_detection,
    };
    use crate::driver::capabilities::{DriverCapabilityFlag, DriverCapabilityFlags};

    const CONTROL: &str = "zzq/control";

    const fn detection_of(flag: DriverCapabilityFlag) -> CapabilityDetection {
        match flag {
            DriverCapabilityFlag::Steer => CapabilityDetection::Probed {
                probe_names: &["steer"],
            },
            DriverCapabilityFlag::SessionGoals => CapabilityDetection::Probed {
                probe_names: &["goal/set", "goal/clear"],
            },
            DriverCapabilityFlag::ContextCompaction => CapabilityDetection::Probed {
                probe_names: &["compact"],
            },
            DriverCapabilityFlag::Resume
            | DriverCapabilityFlag::InteractiveRequests
            | DriverCapabilityFlag::Mcp
            | DriverCapabilityFlag::ToolCalls
            | DriverCapabilityFlag::ReasoningStream
            | DriverCapabilityFlag::ModelMutation
            | DriverCapabilityFlag::StructuredOutput
            | DriverCapabilityFlag::Rollback
            | DriverCapabilityFlag::SessionFork
            | DriverCapabilityFlag::CallbackTools
            | DriverCapabilityFlag::Subagents
            | DriverCapabilityFlag::ProviderCommands
            | DriverCapabilityFlag::OutputSpeed => CapabilityDetection::Static {
                failing_conjuncts: &[ProbeAdmissibilityConjunct::DecisiveAtConsumptionGranularity],
            },
        }
    }

    // A reply is `{"answer": "accepted"}` or `{"answer": "unknown"}`; anything else is unread.
    fn classify_reply(reply: &Value, _probe_name: &str) -> ProbeAnswer {
        match reply.get("answer").and_then(Value::as_str) {
            Some("accepted") => ProbeAnswer::Accepted,
            Some("unknown") => ProbeAnswer::UnknownName,
            Some(_) | None => ProbeAnswer::Unrecognized,
        }
    }

    fn rules(prohibited_names: &'static [&'static str]) -> CapabilityProbeRules {
        CapabilityProbeRules {
            detection: detection_of,
            negative_control: CONTROL,
            prohibited_names,
            classify_reply,
        }
    }

    // Answers each listed name with its reply and refuses every other name; records each send.
    struct ScriptedExchange {
        replies: Vec<(&'static str, Value)>,
        sent: Vec<&'static str>,
    }

    impl ScriptedExchange {
        fn new(replies: Vec<(&'static str, Value)>) -> Self {
            Self {
                replies,
                sent: Vec::new(),
            }
        }
    }

    impl CapabilityProbeExchange for ScriptedExchange {
        fn exchange(
            &mut self,
            probe_name: &'static str,
        ) -> BoxFuture<'_, Result<Value, Box<dyn Error + Send + Sync>>> {
            self.sent.push(probe_name);
            let reply = self
                .replies
                .iter()
                .find(|(name, _)| *name == probe_name)
                .map_or_else(
                    || json!({ "answer": "unknown" }),
                    |(_, reply)| reply.clone(),
                );
            Box::pin(async move { Ok::<_, Box<dyn Error + Send + Sync>>(reply) })
        }
    }

    async fn read(
        prohibited_names: &'static [&'static str],
        exchange: &mut ScriptedExchange,
    ) -> Result<super::CapabilityDetectionReading, CapabilityProbeError> {
        read_capability_detection(
            ProviderId::new("test".to_owned()).expect("a valid provider id"),
            &rules(prohibited_names),
            PathBuf::from("/bin/test"),
            exchange,
        )
        .await
    }

    #[tokio::test]
    async fn an_answered_negative_control_fails_the_read_before_any_probe() {
        let mut exchange = ScriptedExchange::new(vec![
            (CONTROL, json!({ "answer": "accepted" })),
            ("steer", json!({ "answer": "accepted" })),
        ]);
        let outcome = read(&[], &mut exchange).await;
        assert!(
            matches!(
                outcome,
                Err(CapabilityProbeError::NegativeControlAnswered {
                    probe_name: CONTROL,
                    ..
                })
            ),
            "{outcome:?}"
        );
        assert_eq!(exchange.sent, [CONTROL]);
    }

    #[tokio::test]
    async fn a_refusal_or_an_unread_reply_withdraws_only_its_own_flag() {
        let mut exchange = ScriptedExchange::new(vec![
            ("steer", json!({ "answer": "accepted" })),
            ("goal/set", json!({ "answer": "accepted" })),
            ("compact", json!({ "result": {} })),
        ]);
        let reading = read(&[], &mut exchange)
            .await
            .expect("the control is refused");
        assert_eq!(
            reading.withdrawals,
            [
                CapabilityWithdrawal {
                    flag: DriverCapabilityFlag::SessionGoals,
                    probe_name: "goal/clear",
                    reason: WithdrawalReason::UnknownName,
                },
                CapabilityWithdrawal {
                    flag: DriverCapabilityFlag::ContextCompaction,
                    probe_name: "compact",
                    reason: WithdrawalReason::UnrecognizedReply,
                },
            ]
        );
        let resolved = reading.apply_to(&DriverCapabilityFlags::from_fn(|_| true));
        assert!(resolved.is_on(DriverCapabilityFlag::Steer));
        assert!(resolved.is_on(DriverCapabilityFlag::Resume));
        assert!(!resolved.is_on(DriverCapabilityFlag::SessionGoals));
        assert!(!resolved.is_on(DriverCapabilityFlag::ContextCompaction));
    }

    #[tokio::test]
    async fn a_prohibited_name_is_refused_at_dispatch() {
        let mut exchange = ScriptedExchange::new(vec![
            ("steer", json!({ "answer": "accepted" })),
            ("goal/set", json!({ "answer": "accepted" })),
            ("goal/clear", json!({ "answer": "accepted" })),
        ]);
        let outcome = read(&["compact"], &mut exchange).await;
        assert!(
            matches!(
                outcome,
                Err(CapabilityProbeError::ProhibitedName {
                    probe_name: "compact"
                })
            ),
            "{outcome:?}"
        );
        assert!(!exchange.sent.contains(&"compact"), "{:?}", exchange.sent);
    }
}
