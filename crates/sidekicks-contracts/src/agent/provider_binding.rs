//! How a change to an agent's provider binding settles for every client, not only the asker.
//! Every change to a running agent's model, effort, speed, provider or account is a switch,
//! acknowledged with a disposition (usually `pending`) and settled by one of two events.

use schemars::{JsonSchema, Schema};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::agent::definition::binding::{AgentProviderBinding, ProviderToken};
use crate::agent::definition::{AgentId, add_present_exactly_when};
use crate::event::registry::SessionEventType;
use crate::provider::account::record::ProviderAccountId;
use crate::provider::driver::declared_loss::DeclaredLossKind;
use crate::provider::name::ProviderName;
use crate::schema::push_all_of;
use crate::session::id::SessionId;
use crate::trust_statement::DeviceId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::SafeInt;
use crate::wire::literal;
use crate::wire::text::FreeFormText;

ts_constants! {
    /// The event a deferred switch settles with when it applied.
    pub const AGENT_PROVIDER_BINDING_CHANGED_EVENT: &str = SessionEventType::AgentProviderBindingChanged.as_str();
    /// The event a deferred switch settles with when it could not be applied.
    pub const AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT: &str =
        SessionEventType::AgentProviderBindingChangeFailed.as_str();
    /// The longest switch id the daemon mints.
    pub const AGENT_SWITCH_ID_MAX_LEN: usize = 256;
}

/// The daemon-minted id that pairs a switch's acknowledgment with its settlement.
pub type SwitchId = FreeFormText<AGENT_SWITCH_ID_MAX_LEN>;

/// How the conversation crossed the switch: `in_place`, the same provider carried it on; or
/// `brief`, a switch across providers that started from a hand-over brief with the old
/// transcript beside it as a file, never presented as an ordinary success.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentBindingContinuity {
    /// The same provider carried the conversation on.
    InPlace,
    /// A hand-over brief started the new provider.
    Brief,
}

/// Why an accepted switch could not be applied; a switch refused before it was accepted is an
/// error on the request instead.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentBindingSwitchFailureReason {
    /// The target driver is gone.
    DriverUnavailable,
    /// The target model is gone.
    ModelUnavailable,
    /// The target effort is gone.
    EffortUnavailable,
    /// The account it lands on cannot carry the run.
    AccountUnavailable,
    /// The target driver no longer declares the pended speed.
    OutputSpeedUnavailable,
    /// The run in flight refused the interrupt.
    InterruptRefused,
    /// The target could not start.
    TargetUnstartable,
}

/// Why the account a switch lands on cannot carry the run; only `reauth_required` offers a sign
/// in again. Listed in full, so a new account health state cannot widen it silently.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentBindingSwitchAccountState {
    /// The sign-in is gone.
    ReauthRequired,
    /// The credential home is missing.
    HomeMissing,
    /// Not decided.
    Indeterminate,
    /// No account is registered.
    NotRegistered,
}

/// Where a pending switch applies, resolved by the daemon against the target driver: the next
/// turn or the end of the run in flight; a switch moving several members takes the widest.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum AgentBindingSwitchBoundary {
    /// The next turn.
    TurnBoundary,
    /// The end of the run in flight.
    RunBoundary,
}

/// Whether a move names its window when it names a model, so an omitted `largerWindow` always
/// leaves the window unchanged.
pub fn model_move_names_window<T, W>(
    model_id: Option<&T>,
    larger_window: Option<&W>,
) -> garde::Result {
    if model_id.is_some() && larger_window.is_none() {
        Err(garde::Error::new(
            "a model move names its window too: a larger window in tokens, or null for the default",
        ))
    } else {
        Ok(())
    }
}

/// The schema twin of [`model_move_names_window`], for a schema's `transform`.
pub(crate) fn add_model_move_window_rule(schema: &mut Schema) {
    schema.insert(
        "dependentRequired".into(),
        json!({ "modelId": ["largerWindow"] }),
    );
}

/// The binding members a switch moves and the value each moves to; an omitted member does not
/// move. `largerWindow` as a number moves to that window in tokens and `null` back to the model's
/// default.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(target_names_window_on_model_move))]
#[schemars(transform = add_model_move_window_rule)]
pub struct AgentBindingSwitchTarget {
    /// The provider.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderName")]
    pub driver_name: Option<ProviderName>,
    /// The model.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub model_id: Option<ProviderToken>,
    /// The account; an account move sets only the account.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderAccountId")]
    pub provider_account_id: Option<ProviderAccountId>,
    /// The effort.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub effort: Option<ProviderToken>,
    /// The speed.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderToken")]
    pub output_speed: Option<ProviderToken>,
    /// The window in tokens, or `null` for the model's default.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        with = "serde_with::rust::double_option"
    )]
    #[schemars(with = "crate::wire::NullableSchema<SafeInt<1>>")]
    pub larger_window: Option<Option<SafeInt<1>>>,
}

/// Whether a target names its window on a model move.
fn target_names_window_on_model_move(target: &AgentBindingSwitchTarget, _: &()) -> garde::Result {
    model_move_names_window(target.model_id.as_ref(), target.larger_window.as_ref())
}

literal! {
    /// The status of a switch accepted and not applied.
    pub enum PendingSwitchStatus = "pending";
}
literal! {
    /// The status of a switch whose conversation arrived whole.
    pub enum AppliedSwitchStatus = "applied";
}
literal! {
    /// The status of a switch whose conversation did not arrive whole.
    pub enum DegradedSwitchStatus = "degraded";
}
literal! {
    /// The status of an accepted switch that could not be applied.
    pub enum FailedSwitchStatus = "failed";
}
literal! {
    /// An applied switch's continuity.
    pub enum InPlaceContinuity = "in_place";
}
literal! {
    /// A degraded switch's continuity.
    pub enum BriefContinuity = "brief";
}

/// A switch the daemon accepted and has not applied: at most one per agent, a later one replacing
/// it. The same record is the acknowledgment, the agent row's stored switch and `agent.list`'s
/// `pendingSwitch`, so `switching to …` survives a reload and reaches another device.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentBindingSwitchPending {
    /// Always `pending`.
    pub status: PendingSwitchStatus,
    /// The switch.
    pub switch_id: SwitchId,
    /// Where it applies.
    pub applies_at: AgentBindingSwitchBoundary,
    /// Whether the daemon interrupts to reach the boundary; never re-derived from `appliesAt`.
    pub interrupt_requested: bool,
    /// What it moves.
    #[garde(dive)]
    pub pending_axes: AgentBindingSwitchTarget,
    /// The earlier pending switch this one displaced, and the only record of it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SwitchId")]
    pub replaced_switch_id: Option<SwitchId>,
}

/// Whether a loss list agrees with its continuity: `in_place` declares none, and `brief` at least
/// the summarized history and the private reasoning.
pub fn declared_losses_match(
    continuity: AgentBindingContinuity,
    declared_losses: &[DeclaredLossKind],
) -> garde::Result {
    let agrees = match continuity {
        AgentBindingContinuity::InPlace => declared_losses.is_empty(),
        AgentBindingContinuity::Brief => {
            declared_losses.contains(&DeclaredLossKind::ConversationHistorySummarized)
                && declared_losses.contains(&DeclaredLossKind::ProviderPrivateReasoning)
        }
    };
    if agrees {
        Ok(())
    } else {
        Err(garde::Error::new(
            "an in-place switch declares no loss, and a brief the summarized history and the \
             private reasoning",
        ))
    }
}

/// The schema of the losses a brief declares: at least the two it always loses.
fn brief_losses_schema() -> Value {
    json!({
        "allOf": [
            { "type": "array", "contains": { "const": "conversation_history_summarized" } },
            { "type": "array", "contains": { "const": "provider_private_reasoning" } },
        ],
    })
}

/// The schema twin of [`declared_losses_match`] for an object holding both members.
pub(crate) fn add_declared_losses_rule(schema: &mut Schema) {
    push_all_of(
        schema,
        json!({
            "if": {
                "type": "object",
                "properties": { "continuity": { "const": "in_place" } },
                "required": ["continuity"],
            },
            "then": {
                "type": "object",
                "properties": { "declaredLosses": { "type": "array", "maxItems": 0 } },
            },
            "else": {
                "type": "object",
                "properties": { "declaredLosses": brief_losses_schema() },
            },
        }),
    );
}

/// The schema twin of the brief half of [`declared_losses_match`], for a degraded switch.
fn add_brief_losses_rule(schema: &mut Schema) {
    push_all_of(
        schema,
        json!({
            "type": "object",
            "properties": { "declaredLosses": brief_losses_schema() },
        }),
    );
}

/// Whether a failure carries an account state exactly when its reason is `account_unavailable`.
pub fn account_state_matches_reason(
    reason: AgentBindingSwitchFailureReason,
    account_state: Option<AgentBindingSwitchAccountState>,
) -> garde::Result {
    if (reason == AgentBindingSwitchFailureReason::AccountUnavailable) == account_state.is_some() {
        Ok(())
    } else {
        Err(garde::Error::new(
            "accountState is present exactly when the reason is account_unavailable",
        ))
    }
}

/// The schema twin of [`account_state_matches_reason`].
pub(crate) fn add_account_state_rule(schema: &mut Schema) {
    add_present_exactly_when(schema, "reason", "account_unavailable", "accountState");
}

/// A switch that applied with its conversation whole: it declares no loss.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[schemars(inline)]
pub struct AppliedSwitch {
    /// Always `applied`.
    pub status: AppliedSwitchStatus,
    /// The switch.
    pub switch_id: SwitchId,
    /// Always `in_place`.
    pub continuity: InPlaceContinuity,
    /// Always empty: nothing of the conversation was dropped.
    #[garde(length(max = 0))]
    #[schemars(length(max = 0))]
    pub declared_losses: Vec<DeclaredLossKind>,
}

/// A switch that applied from a hand-over brief, declaring what it lost.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(degraded_declares_brief_losses))]
#[schemars(inline, transform = add_brief_losses_rule)]
pub struct DegradedSwitch {
    /// Always `degraded`.
    pub status: DegradedSwitchStatus,
    /// The switch.
    pub switch_id: SwitchId,
    /// Always `brief`.
    pub continuity: BriefContinuity,
    /// What was lost: at least the summarized history and the private reasoning.
    pub declared_losses: Vec<DeclaredLossKind>,
}

/// Whether a degraded switch declares a brief's losses.
fn degraded_declares_brief_losses(switch: &DegradedSwitch, _: &()) -> garde::Result {
    declared_losses_match(AgentBindingContinuity::Brief, &switch.declared_losses)
}

/// An accepted switch settled on the held-open request as a failure: a result, not an error,
/// since only its application failed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(failed_switch_states_its_account))]
#[schemars(inline, transform = add_account_state_rule)]
pub struct FailedSwitch {
    /// Always `failed`.
    pub status: FailedSwitchStatus,
    /// The switch.
    pub switch_id: SwitchId,
    /// Why it failed.
    pub reason: AgentBindingSwitchFailureReason,
    /// Why the account cannot carry the run, exactly on `account_unavailable`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentBindingSwitchAccountState")]
    pub account_state: Option<AgentBindingSwitchAccountState>,
}

/// Whether a failed switch states its account exactly on an account failure.
fn failed_switch_states_its_account(switch: &FailedSwitch, _: &()) -> garde::Result {
    account_state_matches_reason(switch.reason, switch.account_state)
}

/// What `agent.configUpdate` answers with. `pending` is the ordinary answer; the other three come
/// only when the caller asked to interrupt and switch. `applied` is exactly a conversation that
/// arrived whole and `degraded` exactly one that did not, so no client re-derives that rule.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum AgentBindingSwitchDisposition {
    /// Accepted, not applied.
    Pending(#[garde(dive)] AgentBindingSwitchPending),
    /// Applied whole.
    Applied(#[garde(dive)] AppliedSwitch),
    /// Applied from a brief.
    Degraded(#[garde(dive)] DegradedSwitch),
    /// Not applied.
    Failed(#[garde(dive)] FailedSwitch),
}

/// The payload of [`AGENT_PROVIDER_BINDING_CHANGED_EVENT`]: a switch that applied. The landed
/// account is kept apart from `to`'s, so an agent that follows the current account is never
/// pinned to it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(changed_payload_losses_match))]
#[schemars(transform = add_declared_losses_rule)]
pub struct AgentProviderBindingChangedPayload {
    /// The switch.
    pub switch_id: SwitchId,
    /// What was lost.
    pub declared_losses: Vec<DeclaredLossKind>,
    /// How the conversation crossed.
    pub continuity: AgentBindingContinuity,
    /// The session.
    pub session_id: SessionId,
    /// The agent.
    pub agent_id: AgentId,
    /// The device whose connection carried the switch, recorded at acceptance so a settlement
    /// after a restart still names it.
    pub actor: DeviceId,
    /// The binding before.
    pub from: AgentProviderBinding,
    /// The binding after.
    pub to: AgentProviderBinding,
    /// The account the switch landed on.
    pub landed_provider_account_id: ProviderAccountId,
}

/// Whether a changed payload's losses agree with its continuity.
fn changed_payload_losses_match(
    payload: &AgentProviderBindingChangedPayload,
    _: &(),
) -> garde::Result {
    declared_losses_match(payload.continuity, &payload.declared_losses)
}

/// The payload of [`AGENT_PROVIDER_BINDING_CHANGE_FAILED_EVENT`]: an accepted switch that could
/// not be applied. The agent stays on `from`; exactly one of the two events ends every switch not
/// replaced.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(failed_payload_states_its_account))]
#[schemars(transform = add_account_state_rule)]
pub struct AgentProviderBindingChangeFailedPayload {
    /// The switch.
    pub switch_id: SwitchId,
    /// Why it failed.
    pub reason: AgentBindingSwitchFailureReason,
    /// Why the account cannot carry the run, exactly on `account_unavailable`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "AgentBindingSwitchAccountState")]
    pub account_state: Option<AgentBindingSwitchAccountState>,
    /// The session.
    pub session_id: SessionId,
    /// The agent.
    pub agent_id: AgentId,
    /// The device whose connection carried the switch.
    pub actor: DeviceId,
    /// The binding the agent stays on.
    pub from: AgentProviderBinding,
    /// What the switch tried to move.
    #[garde(dive)]
    pub attempted: AgentBindingSwitchTarget,
}

/// Whether a failed payload states its account exactly on an account failure.
fn failed_payload_states_its_account(
    payload: &AgentProviderBindingChangeFailedPayload,
    _: &(),
) -> garde::Result {
    account_state_matches_reason(payload.reason, payload.account_state)
}

/// The TypeScript module of the binding switch.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "agent/provider-binding",
    doc: "How a change to an agent's provider binding settles for every client, not only the \
          asker: the switch, its disposition and its two settlement events.",
    definitions: &[
        Definition::read::<AgentBindingContinuity>(),
        Definition::read::<AgentBindingSwitchFailureReason>(),
        Definition::read::<AgentBindingSwitchAccountState>(),
        Definition::read::<AgentBindingSwitchBoundary>(),
        Definition::read::<AgentBindingSwitchTarget>().checked(),
        Definition::read::<AgentBindingSwitchPending>().checked(),
        Definition::read::<AgentBindingSwitchDisposition>().checked(),
        Definition::read::<AgentProviderBindingChangedPayload>().checked(),
        Definition::read::<AgentProviderBindingChangeFailedPayload>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
