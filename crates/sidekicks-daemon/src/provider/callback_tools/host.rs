//! The host: the one daemon-side dispatcher every provider's callback-tool calls reach through the
//! `sidekicks` tool route. No call is left unanswered, and none is answered
//! `completed` without the approval seam's adjudication, so without a seam the registry is
//! withheld at spawn and a stray call is answered `denied`. An unknown tool, or a call from a
//! spawn whose registry a later spawn replaced, is answered `failed` before any adjudication.

use std::collections::hash_map::Entry;
use std::collections::{HashMap, HashSet};
use std::error::Error;
use std::fmt::Display;
use std::sync::{Arc, Mutex, MutexGuard};

use futures::future::BoxFuture;
use serde_json::{Map, Value};
use sidekicks_contracts::provider::driver::length_limits::PROVIDER_TOOL_NAME_MAX_LEN;
use sidekicks_contracts::provider::driver::tools::SessionCallbackTool;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::text::FreeFormText;
use strum::IntoStaticStr;

use crate::mutex_lock::lock;
use crate::provider::driver::callback_tool::{CallbackToolInvocation, CallbackToolResult};
use crate::provider::driver::diagnostics::{
    DriverDiagnosticKind, DriverDiagnosticRecord, emit_driver_diagnostic,
};

/// An error a seam, executor or sink returns: anything that failed, with its causes.
pub(crate) type CallbackToolPortError = Box<dyn Error + Send + Sync>;

/// How an adjudication was reached; only a `User*` basis raised an approval request.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CallbackToolApprovalBasis {
    /// The person's policy settled it.
    Policy,
    /// A rule the person remembered settled it.
    RememberedRule,
    /// The person allowed it when asked.
    UserGrant,
    /// The person refused it when asked.
    UserRefusal,
}

/// The seam's settled adjudication. There is no ask arm: the approval pipeline holds the pending
/// request and answers once the person has.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CallbackToolApprovalOutcome {
    /// The call may run.
    Allow {
        /// How it was allowed: `Policy`, `RememberedRule` or `UserGrant`.
        basis: CallbackToolApprovalBasis,
    },
    /// The call may not run.
    Deny {
        /// How it was denied: `Policy`, `RememberedRule` or `UserRefusal`.
        basis: CallbackToolApprovalBasis,
        /// Why, for the provider.
        reason: String,
    },
}

/// The approval pipeline's evaluation, which the daemon's start binds to the composed check.
pub(crate) trait CallbackToolApprovalSeam: Send + Sync {
    /// Adjudicates `invocation`, whose arguments a policy may read, made by `provider`'s process.
    /// An error when it could not adjudicate, which the host answers `denied`.
    fn evaluate<'a>(
        &'a self,
        invocation: &'a CallbackToolInvocation,
        provider: &'a ProviderId,
    ) -> BoxFuture<'a, Result<CallbackToolApprovalOutcome, CallbackToolPortError>>;
}

/// Runs a call the seam allowed, so it never checks authorization again.
pub(crate) trait CallbackToolExecutor: Send + Sync {
    /// Runs `invocation` and answers it. An error when it could not run, which the host answers
    /// `failed`.
    fn execute(
        &self,
        invocation: CallbackToolInvocation,
    ) -> BoxFuture<'_, Result<CallbackToolResult, CallbackToolPortError>>;
}

/// How one call settled, for the tool activity row it lands as.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CallbackToolActivityDisposition {
    /// The tool ran and completed.
    Completed,
    /// The seam denied it.
    DeniedByPolicy,
    /// No seam could adjudicate it.
    DeniedNoSeam,
    /// It named no tool the session's registry holds.
    FailedUnknownTool,
    /// The route's check refused its arguments.
    FailedInvalidArguments,
    /// It came from a spawn whose registry a later spawn replaced.
    FailedSupersededBinding,
    /// It was allowed, then failed while running.
    FailedInExecution,
}

/// One settled call as the event pipeline records it; the pipeline builds the event itself.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct CallbackToolActivityRecord {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run whose turn made the call.
    pub(crate) run_id: RunId,
    /// The tool called.
    pub(crate) tool_name: FreeFormText<PROVIDER_TOOL_NAME_MAX_LEN>,
    /// The provider's id for the call, unchanged, since a tool's start and end pair on it.
    pub(crate) tool_call_id: ToolCallId,
    /// How it settled.
    pub(crate) disposition: CallbackToolActivityDisposition,
    /// How it was adjudicated; `None` when it was refused before adjudication.
    pub(crate) approval_basis: Option<CallbackToolApprovalBasis>,
}

/// Lands each settled call as an ordinary tool activity row.
pub(crate) trait CallbackToolActivitySink: Send + Sync {
    /// Records `record`. An error when it could not, which the host logs; the call's answer
    /// stands.
    fn record<'a>(
        &'a self,
        record: &'a CallbackToolActivityRecord,
    ) -> BoxFuture<'a, Result<(), CallbackToolPortError>>;
}

/// Why a spawn withheld the callback-tool registry from the provider.
#[derive(Clone, Copy, Debug, PartialEq, Eq, IntoStaticStr)]
#[strum(serialize_all = "camelCase")]
pub(crate) enum CallbackToolRegistryWithholdingReason {
    /// No approval seam is registered, so nothing could be adjudicated.
    NoApprovalSeam,
    /// The provider cannot register the tools in this spawn.
    ProviderRegistrationUnavailable,
}

/// One installation of one session's registry, so a replaced spawn's calls and teardown cannot
/// act on its replacement. Two tokens are equal only when they are the same installation.
#[derive(Clone, Debug)]
pub(crate) struct CallbackToolRegistryToken(Arc<RegistryInstallation>);

#[derive(Debug)]
struct RegistryInstallation {
    /// The host's count of installations, for diagnostics only.
    ordinal: u64,
    /// The provider of the spawn that installed it.
    provider: ProviderId,
}

impl PartialEq for CallbackToolRegistryToken {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

impl Eq for CallbackToolRegistryToken {}

/// What one spawn asks of the host.
#[derive(Clone, Debug)]
pub(crate) struct CallbackToolSpawnRequest {
    /// The session the spawn serves.
    pub(crate) session_id: SessionId,
    /// The spawn's provider.
    pub(crate) provider: ProviderId,
    /// The callback tools the session asks to offer.
    pub(crate) requested_tools: Vec<SessionCallbackTool>,
    /// Why the provider cannot register tools in this spawn; `None` when it can.
    pub(crate) provider_registration_unavailable: Option<String>,
}

/// Whether a spawn may offer its tools to the provider.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) enum CallbackToolAdmission {
    /// Offer these tools; empty when none was asked for.
    Admitted {
        /// The tools to offer.
        tools: Vec<SessionCallbackTool>,
    },
    /// Offer none; a session without callback tools is degraded, not failed.
    Withheld {
        /// Why.
        reason: CallbackToolRegistryWithholdingReason,
        /// Why, in words.
        detail: String,
    },
}

/// One session's installed registry: the tool names its calls may use.
struct InstalledRegistry {
    token: CallbackToolRegistryToken,
    tool_names: HashSet<String>,
    /// The installation this one replaced, for a rollback. One deep: an older one was replaced by
    /// a spawn that succeeded, and restoring it would revive a registry whose process is gone.
    superseded: Option<Box<InstalledRegistry>>,
}

#[derive(Default)]
struct Registries {
    by_session: HashMap<SessionId, InstalledRegistry>,
    last_ordinal: u64,
}

/// A refusal before adjudication: its activity row, its diagnostic and its answer.
#[derive(Clone, Copy)]
enum Refusal {
    NoSeam,
    UnknownTool,
    InvalidArguments,
    SupersededBinding,
}

impl Refusal {
    const fn disposition(self) -> CallbackToolActivityDisposition {
        match self {
            Self::NoSeam => CallbackToolActivityDisposition::DeniedNoSeam,
            Self::UnknownTool => CallbackToolActivityDisposition::FailedUnknownTool,
            Self::InvalidArguments => CallbackToolActivityDisposition::FailedInvalidArguments,
            Self::SupersededBinding => CallbackToolActivityDisposition::FailedSupersededBinding,
        }
    }

    /// `denied` when nothing could adjudicate, since `failed` would blame the provider.
    fn answer(self, detail: String) -> (DriverDiagnosticKind, CallbackToolResult) {
        let error = Some(detail);
        match self {
            Self::NoSeam => (
                DriverDiagnosticKind::CallbackToolSeamAbsent,
                CallbackToolResult::Denied { error },
            ),
            Self::UnknownTool | Self::InvalidArguments | Self::SupersededBinding => (
                DriverDiagnosticKind::CallbackToolInvocationRefused,
                CallbackToolResult::Failed { error },
            ),
        }
    }
}

/// The daemon's one callback-tool dispatcher for every provider, holding each session's registry.
/// Spawns reach it through [`super::spawn_binding::bind_callback_tools_for_spawn`]; the registry
/// lock is never held across an await.
pub(crate) struct CallbackToolHost {
    executor: Arc<dyn CallbackToolExecutor>,
    activity_sink: Arc<dyn CallbackToolActivitySink>,
    approval_seam: Option<Arc<dyn CallbackToolApprovalSeam>>,
    registries: Mutex<Registries>,
}

impl CallbackToolHost {
    /// A host with no registry installed. Without `approval_seam` every registry is withheld at
    /// spawn and every call is answered `denied`.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the callback tools' approval route builds the host"
        )
    )]
    pub(crate) fn new(
        executor: Arc<dyn CallbackToolExecutor>,
        activity_sink: Arc<dyn CallbackToolActivitySink>,
        approval_seam: Option<Arc<dyn CallbackToolApprovalSeam>>,
    ) -> Self {
        Self {
            executor,
            activity_sink,
            approval_seam,
            registries: Mutex::new(Registries::default()),
        }
    }

    /// Answers a call whose arguments the `sidekicks` route's received check refused, as `failed`
    /// with `fault`, recording the refusal and the activity like any other.
    #[expect(
        dead_code,
        reason = "the callback tools' approval route builds the host"
    )]
    pub(crate) async fn refuse_invalid_arguments(
        &self,
        session_id: SessionId,
        run_id: RunId,
        tool_name: FreeFormText<PROVIDER_TOOL_NAME_MAX_LEN>,
        tool_call_id: ToolCallId,
        fault: &dyn Display,
    ) -> CallbackToolResult {
        let provider = self
            .lock_registries()
            .by_session
            .get(&session_id)
            .map(|installed| installed.token.0.provider.clone());
        let refusal = Refusal::InvalidArguments;
        let record = CallbackToolActivityRecord {
            session_id,
            run_id,
            tool_name,
            tool_call_id,
            disposition: refusal.disposition(),
            approval_basis: None,
        };
        let detail = fault.to_string();
        self.refuse(provider.as_ref(), &record, refusal, detail)
            .await
    }

    fn lock_registries(&self) -> MutexGuard<'_, Registries> {
        lock(&self.registries)
    }

    /// Installs the registry a spawn may offer and returns its token with the admission. A
    /// withholding still installs an empty registry, so a stray call reads as an unknown tool.
    pub(super) fn resolve_spawn_registry(
        &self,
        request: CallbackToolSpawnRequest,
    ) -> (CallbackToolRegistryToken, CallbackToolAdmission) {
        let CallbackToolSpawnRequest {
            session_id,
            provider,
            requested_tools,
            provider_registration_unavailable: unavailable,
        } = request;
        let withholding = if requested_tools.is_empty() {
            None
        } else if self.approval_seam.is_none() {
            Some((
                CallbackToolRegistryWithholdingReason::NoApprovalSeam,
                "no approval seam is registered, so no call could be adjudicated".to_owned(),
            ))
        } else {
            unavailable.map(|detail| {
                let reason = CallbackToolRegistryWithholdingReason::ProviderRegistrationUnavailable;
                (reason, detail)
            })
        };
        let Some((reason, detail)) = withholding else {
            let tool_names = requested_tools
                .iter()
                .map(|tool| tool.name.clone())
                .collect();
            let token = self.install_registry(session_id, provider, tool_names);
            return (
                token,
                CallbackToolAdmission::Admitted {
                    tools: requested_tools,
                },
            );
        };
        let token = self.install_registry(session_id, provider.clone(), HashSet::new());
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider,
            provider_account_id: None,
            kind: DriverDiagnosticKind::CallbackToolRegistryWithheld,
            raw_wire_type: None,
            disposition_reason: detail.clone(),
            details: Map::from_iter([
                session_detail(session_id),
                ("reason".to_owned(), Value::from(<&str>::from(reason))),
                (
                    "withheldToolCount".to_owned(),
                    Value::from(requested_tools.len()),
                ),
            ]),
        });
        (token, CallbackToolAdmission::Withheld { reason, detail })
    }

    /// Installs a session's registry under a new token, keeping the one it replaced for a
    /// rollback; a replacement is logged, since from then the replaced spawn's calls are refused.
    fn install_registry(
        &self,
        session_id: SessionId,
        provider: ProviderId,
        tool_names: HashSet<String>,
    ) -> CallbackToolRegistryToken {
        let mut registries = self.lock_registries();
        registries.last_ordinal += 1;
        let token = CallbackToolRegistryToken(Arc::new(RegistryInstallation {
            ordinal: registries.last_ordinal,
            provider,
        }));
        let superseded = registries
            .by_session
            .remove(&session_id)
            .map(|mut superseded| {
                superseded.superseded = None;
                Box::new(superseded)
            });
        let superseded_token = superseded
            .as_ref()
            .map(|superseded| superseded.token.clone());
        registries.by_session.insert(
            session_id,
            InstalledRegistry {
                token: token.clone(),
                tool_names,
                superseded,
            },
        );
        drop(registries);
        if let Some(superseded_token) = superseded_token {
            record_registry_change(
                DriverDiagnosticKind::CallbackToolRegistrySuperseded,
                &token.0.provider,
                session_id,
                "a second spawn installed a callback-tool registry for a session that still had \
                 one; the replaced installation no longer dispatches or releases",
                [&superseded_token, &token],
            );
        }
        token
    }

    /// Ends `token`'s installation: removes it, or after a failed spawn (`is_rollback`) restores
    /// the registry it replaced, which a driver may still be using. A replaced spawn's late
    /// teardown is logged and leaves the live registry in place, no longer one a rollback restores.
    pub(super) fn end_installation(
        &self,
        session_id: SessionId,
        token: &CallbackToolRegistryToken,
        is_rollback: bool,
    ) {
        let mut registries = self.lock_registries();
        let Entry::Occupied(mut installed) = registries.by_session.entry(session_id) else {
            return;
        };
        if installed.get().token != *token {
            // Its binding is gone, so a later rollback must not bring it back unreleased.
            let live = installed.get_mut();
            if live
                .superseded
                .as_ref()
                .is_some_and(|superseded| superseded.token == *token)
            {
                live.superseded = None;
            }
            let installed_token = live.token.clone();
            drop(registries);
            record_registry_change(
                DriverDiagnosticKind::CallbackToolRegistryReleaseIgnored,
                &token.0.provider,
                session_id,
                "a replaced spawn's teardown ran after its callback-tool registry had been \
                 replaced; leaving the live installation in place",
                [token, &installed_token],
            );
            return;
        }
        let predecessor = installed.get_mut().superseded.take();
        let Some(predecessor) = predecessor.filter(|_| is_rollback) else {
            installed.remove();
            return;
        };
        let restored_token = predecessor.token.clone();
        installed.insert(*predecessor);
        drop(registries);
        record_registry_change(
            DriverDiagnosticKind::CallbackToolRegistrySuperseded,
            &restored_token.0.provider,
            session_id,
            "a failed spawn rolled its callback-tool registry back; the installation it had \
             replaced is live again and the failed one no longer dispatches or releases",
            [token, &restored_token],
        );
    }

    /// Reads, under the lock alone, whether the session's registry admits `invocation` from the
    /// spawn holding `token`, or why not.
    fn standing_of(
        &self,
        invocation: &CallbackToolInvocation,
        token: &CallbackToolRegistryToken,
    ) -> Result<(), (Refusal, &'static str)> {
        let registries = self.lock_registries();
        match registries.by_session.get(&invocation.session_id) {
            None => Err((
                Refusal::UnknownTool,
                "the call names a session with no callback-tool registry",
            )),
            // Ahead of the tool lookup, so a replaced spawn's late call is refused even when the
            // live registry holds a tool of the same name.
            Some(installed) if *token != installed.token => Err((
                Refusal::SupersededBinding,
                "the call was raised against a callback-tool registry a later spawn replaced",
            )),
            Some(installed) if installed.tool_names.contains(invocation.tool_name.as_str()) => {
                Ok(())
            }
            Some(_) => Err((
                Refusal::UnknownTool,
                "the call names no registered callback tool",
            )),
        }
    }

    /// Answers one call, in order: the seam's presence, the registry and its token, the seam's
    /// adjudication, then the executor. `token` scopes the call to one spawn's installation, whose
    /// provider its diagnostics name.
    pub(super) async fn dispatch(
        &self,
        invocation: CallbackToolInvocation,
        token: &CallbackToolRegistryToken,
    ) -> CallbackToolResult {
        let standing = self.standing_of(&invocation, token);
        let provider = Some(&token.0.provider);
        // The seam is checked first: a withholding installs an empty registry, so a call reaching
        // a host without one would otherwise read as an unknown tool.
        let adjudication = match (&self.approval_seam, standing) {
            (None, _) => Err((
                Refusal::NoSeam,
                "no approval seam is registered; refusing rather than completing without \
                 adjudication"
                    .to_owned(),
            )),
            (Some(_), Err((refusal, detail))) => Err((refusal, detail.to_owned())),
            (Some(seam), Ok(())) => {
                seam.evaluate(&invocation, &token.0.provider)
                    .await
                    .map_err(|error| {
                        let detail = format!(
                            "the approval seam failed before adjudicating; refusing rather than \
                             completing without adjudication ({error})"
                        );
                        (Refusal::NoSeam, detail)
                    })
            }
        };
        let outcome = match adjudication {
            Ok(outcome) => outcome,
            Err((refusal, detail)) => {
                let record = activity_of(&invocation, refusal.disposition(), None);
                return self.refuse(provider, &record, refusal, detail).await;
            }
        };
        let basis = match outcome {
            CallbackToolApprovalOutcome::Deny { basis, reason } => {
                let record = activity_of(
                    &invocation,
                    CallbackToolActivityDisposition::DeniedByPolicy,
                    Some(basis),
                );
                self.record_activity(provider, &record).await;
                return CallbackToolResult::Denied {
                    error: Some(reason),
                };
            }
            CallbackToolApprovalOutcome::Allow { basis } => basis,
        };
        // A failure while running is the tool's outcome, not the pipeline's: an allowed row that
        // failed.
        let mut record = activity_of(
            &invocation,
            CallbackToolActivityDisposition::FailedInExecution,
            Some(basis),
        );
        let result = match self.executor.execute(invocation).await {
            Ok(result) => result,
            Err(error) => CallbackToolResult::Failed {
                error: Some(error.to_string()),
            },
        };
        if matches!(result, CallbackToolResult::Completed { .. }) {
            record.disposition = CallbackToolActivityDisposition::Completed;
        }
        self.record_activity(provider, &record).await;
        result
    }

    /// Logs a refusal before adjudication, records its activity and answers it.
    async fn refuse(
        &self,
        provider: Option<&ProviderId>,
        record: &CallbackToolActivityRecord,
        refusal: Refusal,
        detail: String,
    ) -> CallbackToolResult {
        let (kind, answer) = refusal.answer(detail.clone());
        if let Some(provider) = provider {
            emit_driver_diagnostic(&DriverDiagnosticRecord {
                provider: provider.clone(),
                provider_account_id: None,
                kind,
                raw_wire_type: None,
                disposition_reason: detail,
                details: call_details(record),
            });
        }
        self.record_activity(provider, record).await;
        answer
    }

    /// Records one settled call. A sink failure is logged and never changes the call's answer,
    /// since the row is what the person reads and the answer is what the provider waits on.
    async fn record_activity(
        &self,
        provider: Option<&ProviderId>,
        record: &CallbackToolActivityRecord,
    ) {
        let Err(error) = self.activity_sink.record(record).await else {
            return;
        };
        let disposition_reason = format!("the activity sink failed: {error}");
        let Some(provider) = provider else {
            tracing::warn!(
                counter = DriverDiagnosticKind::CallbackToolActivityRecordFailed.counter_name(),
                error = &*error as &(dyn Error + 'static),
                "a callback-tool activity row was not recorded for a session with no registry"
            );
            return;
        };
        emit_driver_diagnostic(&DriverDiagnosticRecord {
            provider: provider.clone(),
            provider_account_id: None,
            kind: DriverDiagnosticKind::CallbackToolActivityRecordFailed,
            raw_wire_type: None,
            disposition_reason,
            details: call_details(record),
        });
    }
}

/// The activity row `invocation` lands as.
fn activity_of(
    invocation: &CallbackToolInvocation,
    disposition: CallbackToolActivityDisposition,
    approval_basis: Option<CallbackToolApprovalBasis>,
) -> CallbackToolActivityRecord {
    CallbackToolActivityRecord {
        session_id: invocation.session_id,
        run_id: invocation.run_id,
        tool_name: invocation.tool_name.clone(),
        tool_call_id: invocation.tool_call_id.clone(),
        disposition,
        approval_basis,
    }
}

fn session_detail(session_id: SessionId) -> (String, Value) {
    ("sessionId".to_owned(), Value::from(session_id.to_string()))
}

/// The call's identity and disposition as diagnostic details; the ids are bounded, so they are
/// carried whole.
fn call_details(record: &CallbackToolActivityRecord) -> Map<String, Value> {
    let text = |name: &str, value: &str| (name.to_owned(), Value::from(value));
    Map::from_iter([
        session_detail(record.session_id),
        text("runId", &record.run_id.to_string()),
        text("toolName", record.tool_name.as_str()),
        text("toolCallId", record.tool_call_id.as_str()),
        text("disposition", <&str>::from(record.disposition)),
    ])
}

/// Logs `kind` for a session whose installation `from` was replaced by, or outlived by, `to`,
/// naming `provider`, the provider of the spawn that acted.
fn record_registry_change(
    kind: DriverDiagnosticKind,
    provider: &ProviderId,
    session_id: SessionId,
    disposition_reason: &str,
    [from, to]: [&CallbackToolRegistryToken; 2],
) {
    emit_driver_diagnostic(&DriverDiagnosticRecord {
        provider: provider.clone(),
        provider_account_id: None,
        kind,
        raw_wire_type: None,
        disposition_reason: disposition_reason.to_owned(),
        details: Map::from_iter([
            session_detail(session_id),
            ("fromInstallation".to_owned(), Value::from(from.0.ordinal)),
            (
                "installedInstallation".to_owned(),
                Value::from(to.0.ordinal),
            ),
        ]),
    });
}
