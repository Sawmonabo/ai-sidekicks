//! A session's spend: the committed figure and each agent's share of it, and the cost receipt the
//! inspector reads by provider and account.
//!
//! Every amount is whole micro-dollars. Each request is priced once, when it completes, and never
//! repriced, so small requests add up exactly and a figure is rounded once, where it is drawn. The
//! budget read and the receipt come from one fold over the per-turn usage rows, so the two cannot
//! disagree.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::agent::tree::AgentTreeMember;
use crate::provider::account::record::{BillingMode, ProviderAccountId};
use crate::provider::name::ProviderName;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::integer::SafeInt;
use crate::wire::named_scalar;

named_scalar! {
    /// A cost in whole micro-dollars, the one money unit on the wire.
    UsdMicros(SafeInt<0>)
}

named_scalar! {
    /// A `Tokens per run` limit: input and output tokens together, for one run; at least one.
    TokensPerRun(SafeInt<1>)
}

/// One agent's spend in the session's tree, the lead included: `own_usd_micros` is what its own
/// requests cost, and `subtree_usd_micros` that plus every descendant's at any depth. A helper
/// request, such as a reviewer's, counts on the agent it belongs to.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct AgentSpend {
    /// The agent.
    pub agent: AgentTreeMember,
    /// What the agent's own requests cost.
    pub own_usd_micros: UsdMicros,
    /// The agent's own spend plus every descendant's; never less than its own.
    #[garde(custom(|subtree: &UsdMicros, (): &()| {
        if subtree.0 >= self.own_usd_micros.0 {
            Ok(())
        } else {
            Err(garde::Error::new("a subtree's spend includes its own agent's"))
        }
    }))]
    // `type` beside the reference keeps Ajv's strict types satisfied for `minimum`.
    #[schemars(extend("type" = "integer", "minimum" = { "$data": "1/ownUsdMicros" }))]
    pub subtree_usd_micros: UsdMicros,
}

/// The session's two limits, its committed spend and each agent's share of it. A limit of `null`
/// is `Unlimited`. The committed figure is the one session cost every screen shows, never a sum a
/// client takes over the rows it holds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct OrchestrationBudgetState {
    /// The session.
    pub session_id: SessionId,
    /// The spend limit, or `null` for `Unlimited`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<UsdMicros>")]
    pub spend_limit_usd_micros: Option<UsdMicros>,
    /// The `Tokens per run` limit, or `null` for `Unlimited`.
    #[serde(deserialize_with = "crate::wire::nullable")]
    #[schemars(with = "crate::wire::NullableSchema<TokensPerRun>")]
    pub tokens_per_run: Option<TokensPerRun>,
    /// The session's committed spend.
    pub committed_spend_usd_micros: UsdMicros,
    /// Each agent's spend.
    #[garde(dive)]
    pub agent_spend: Vec<AgentSpend>,
}

/// The session whose spend `orchestration.budgetRead` answers with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OrchestrationBudgetReadRequest {
    /// The session.
    pub session_id: SessionId,
}

/// The session whose cost receipt `orchestration.costReceiptRead` answers with.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCostReceiptRequest {
    /// The session.
    pub session_id: SessionId,
}

/// One provider account's spend: its tokens and its dollars. `billing_mode` labels the figure and
/// never changes how it is derived; `unknown` is never presented as billed dollars.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCostReceiptAccountRow {
    /// The account.
    pub provider_account_id: ProviderAccountId,
    /// How the account is charged.
    pub billing_mode: BillingMode,
    /// The tokens the session spent on the account.
    pub tokens: SafeInt<0>,
    /// What those tokens cost.
    pub usd_micros: UsdMicros,
}

/// A provider's voice calls: their length and their cost at the voice model's price.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCostReceiptVoiceRow {
    /// How long the calls ran, in seconds.
    pub seconds: SafeInt<0>,
    /// What the calls cost.
    pub usd_micros: UsdMicros,
}

/// One provider the session spent on: a row per account it spent on, its voice row where the
/// session made voice calls on it, and a subtotal the daemon computes.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCostReceiptProvider {
    /// The provider.
    pub driver_name: ProviderName,
    /// A row per account the session spent on.
    pub accounts: Vec<SessionCostReceiptAccountRow>,
    /// The provider's voice calls, where the session made any.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "SessionCostReceiptVoiceRow")]
    pub voice: Option<SessionCostReceiptVoiceRow>,
    /// The provider's subtotal.
    pub subtotal_usd_micros: UsdMicros,
}

/// The session's spend, decomposed by provider and account, beside the committed figure it adds up
/// to. Providers are in the order the session first spent on them, the session's own provider
/// first; a session that has spent nothing has none.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct SessionCostReceipt {
    /// The session's committed spend and limits.
    #[garde(dive)]
    pub session_total: OrchestrationBudgetState,
    /// The providers the session spent on.
    pub providers: Vec<SessionCostReceiptProvider>,
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "session/cost",
    doc: "A session's spend: the committed figure and each agent's share of it, and the cost \
          receipt the inspector reads by provider and account, all in whole micro-dollars.",
    definitions: &[
        Definition::read::<UsdMicros>().checked(),
        Definition::read::<TokensPerRun>().checked(),
        Definition::read::<AgentSpend>().checked(),
        Definition::read::<OrchestrationBudgetState>().checked(),
        Definition::read::<OrchestrationBudgetReadRequest>(),
        Definition::read::<SessionCostReceiptRequest>(),
        Definition::read::<SessionCostReceiptAccountRow>(),
        Definition::read::<SessionCostReceiptVoiceRow>(),
        Definition::read::<SessionCostReceiptProvider>(),
        Definition::read::<SessionCostReceipt>(),
    ],
    constants: &[],
    method_tables: &[],
};
