//! What a transcript operation could not carry, named so a client shows the loss rather than a
//! silent gap.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::typescript::{Definition, TypeScriptModule, ts_constants};

/// One thing a transcript operation could not carry. A new kind is a deliberate addition; an empty
/// list claims nothing was dropped, so a driver that does not know what it lost may not send one.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum DeclaredLossKind {
    /// The provider's private reasoning, which neither provider lets travel and which is never
    /// translated; stripped even on a same-provider replay.
    ProviderPrivateReasoning,
    /// The brief's budget evicted older exchanges, whole exchanges only.
    ContextTruncated,
    /// An unpaired tool call took a synthetic error result rather than being dropped.
    ToolCallHistoryRepaired,
    /// Verbatim exchanges were replaced by a bounded prose rendering.
    ConversationHistorySummarized,
    /// The old provider's helper conversations: their conclusions survive in the transcript, the
    /// conversations themselves do not.
    HelperConversations,
    /// Earlier steps travel as one-line notes, so the bodies of their output do not; files touched
    /// on disk are unchanged.
    ToolOutputBodies,
    /// Tool calls arrive as history, never as work in flight; a call about to run does not run.
    LiveToolCalls,
    /// The old provider's own skills and commands name nothing on the new one.
    ProviderSkillAndCommandNames,
    /// A logged turn's body could not be read, so the turn is carried with its position and an
    /// empty body.
    TurnContentUnavailable,
}

ts_constants! {
    /// Every declared loss kind.
    DECLARED_LOSS_KINDS = DeclaredLossKind::VARIANTS;
}

/// The TypeScript module of the declared losses.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/driver/declared-loss",
    doc: "What a transcript operation could not carry, named so a client shows the loss rather \
          than a silent gap.",
    definitions: &[Definition::read::<DeclaredLossKind>().checked()],
    constants: TS_CONSTANTS,
    method_tables: &[],
};
