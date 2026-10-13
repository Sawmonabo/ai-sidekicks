//! A question record and the one call that answers it. An agent's held question on either
//! provider, a tool server's question and a workflow step waiting for a chat reply all become one
//! question record the screen renders (`question.asked`), answered by one call
//! (`question.resolve`). The daemon holds the question with no timer and rebuilds its card on a
//! reload and on every linked device; the first answer settles it everywhere, and a later answer
//! reads back the settled state rather than applying again.
//!
//! A secret answer is delivered and never stored: it reaches no event payload, no projection and
//! no artifact, and the person's turn records only that a secret was answered.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::internal::branded::{UuidTextForm, branded_uuid_id};
use crate::method::methods;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::list::BoundedVec;
use crate::wire::text::BoundedText;

branded_uuid_id! {
    /// The daemon-minted id of one question record.
    QuestionId
}

/// Text a question carries that is never empty: a label, a header, the question itself.
pub type QuestionText = BoundedText<1, { usize::MAX }>;

/// One option row; `preview` is present only where the provider attached one to the option.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionOption {
    /// The option's label.
    pub label: QuestionText,
    /// What it means.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub description: Option<String>,
    /// What picking it would look like.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "String")]
    pub preview: Option<String>,
}

/// The answer a form field starts from, as the form declared it: the label of the option it
/// preselects (several labels on a field of several picks), or a typed field's value in its own
/// type.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum QuestionDefault {
    /// One option's label, or a text field's value.
    Text(String),
    /// A number field's value.
    Number(f64),
    /// A yes-or-no field's value.
    Flag(bool),
    /// The labels a field of several picks preselects.
    Labels(Vec<QuestionText>),
}

/// One question of the record, one page of the card. A secret question takes a masked answer and
/// has no option rows; a numeric field's smallest number is at most its largest; a question with
/// option rows starts from its own options.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
#[garde(custom(prompt_is_answerable))]
#[schemars(transform = add_secret_has_no_options_rule)]
pub struct QuestionPrompt {
    /// The agent's own short header, a tool server's name, or a workflow's name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QuestionText")]
    pub header: Option<QuestionText>,
    /// The question.
    pub text: QuestionText,
    /// The summary line, where the agent sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QuestionText")]
    pub heading: Option<QuestionText>,
    /// The option rows; empty on a secret question.
    pub options: Vec<QuestionOption>,
    /// The provider's own reading of whether several picks go back together.
    pub several_answers: bool,
    /// Whether the answer is masked and never stored.
    pub secret: bool,
    /// Whether the form must have this field answered; present only on a tool server's form field.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "bool")]
    pub required: Option<bool>,
    /// The answer the field starts from, present only where the form declared one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "QuestionDefault")]
    pub default: Option<QuestionDefault>,
    /// The smallest number a numeric field takes, where the form bounds it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "f64", extend("maximum" = { "$data": "1/maximum" }))]
    pub minimum: Option<f64>,
    /// The largest number a numeric field takes, where the form bounds it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "f64")]
    pub maximum: Option<f64>,
}

fn prompt_is_answerable(prompt: &QuestionPrompt, (): &()) -> garde::Result {
    if prompt.secret && !prompt.options.is_empty() {
        return Err(garde::Error::new(
            "a secret question draws a masked field and no option rows",
        ));
    }
    if let (Some(minimum), Some(maximum)) = (prompt.minimum, prompt.maximum)
        && minimum > maximum
    {
        return Err(garde::Error::new(
            "a field's largest number is below its smallest",
        ));
    }
    let default_labels: Vec<&str> = match &prompt.default {
        Some(QuestionDefault::Text(label)) => vec![label.as_str()],
        Some(QuestionDefault::Labels(labels)) => labels.iter().map(BoundedText::as_str).collect(),
        Some(QuestionDefault::Number(_) | QuestionDefault::Flag(_)) | None => Vec::new(),
    };
    let is_own_option = |label: &&str| {
        prompt
            .options
            .iter()
            .any(|option| option.label.as_str() == *label)
    };
    if !prompt.options.is_empty() && !default_labels.iter().all(is_own_option) {
        return Err(garde::Error::new(
            "a question with option rows starts from one of its own options",
        ));
    }
    Ok(())
}

/// States in the schema that a secret question has no option rows.
fn add_secret_has_no_options_rule(schema: &mut schemars::Schema) {
    schema.insert(
        "if".into(),
        serde_json::json!({
            "type": "object",
            "properties": { "secret": { "const": true } },
            "required": ["secret"],
        }),
    );
    schema.insert(
        "then".into(),
        serde_json::json!({
            "type": "object",
            "properties": { "options": { "type": "array", "maxItems": 0 } },
        }),
    );
}

/// Declares one form of the `question.asked` payload: what it waits on, then the members both
/// forms share.
macro_rules! question_asked {
    ($(#[doc = $doc:literal])+ pub struct $name:ident { $($own:tt)* }) => {
        $(#[doc = $doc])+
        #[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
        #[serde(rename_all = "camelCase", deny_unknown_fields)]
        #[schemars(inline)]
        #[garde(allow_unvalidated)]
        pub struct $name {
            /// The question.
            pub question_id: QuestionId,
            /// The session.
            pub session_id: SessionId,
            $($own)*
            /// False only on a question the agent does not wait for: its run keeps running, no card
            /// of its own is raised, and the `user.message` naming it as `answersQuestionId` marks
            /// it answered.
            pub is_agent_waiting: bool,
            /// Every question of the record in page order, so a rebuilt card pages through them
            /// with no further read.
            #[garde(dive)]
            pub questions: BoundedVec<QuestionPrompt, 1, { usize::MAX }>,
        }
    };
}

question_asked! {
    /// An agent's or a tool server's question, held by its run.
    pub struct RunQuestionAskedPayload {
        /// The run that waits.
        pub run_id: RunId,
        /// Only a workflow step's question names a wait.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub wait_id: Option<Never>,
    }
}

question_asked! {
    /// A workflow step's question, held by its wait.
    pub struct WaitQuestionAskedPayload {
        /// Only an agent's or a tool server's question names a run.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "Never")]
        pub run_id: Option<Never>,
        /// The workflow wait.
        pub wait_id: UuidTextForm,
    }
}

/// The `question.asked` payload: exactly one of `runId` and `waitId` names what is waiting.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(untagged)]
pub enum QuestionAskedPayload {
    /// Held by a run.
    Run(#[garde(dive)] RunQuestionAskedPayload),
    /// Held by a workflow wait.
    Wait(#[garde(dive)] WaitQuestionAskedPayload),
}

/// The answer to one question: the picked labels, typed text, a secret, or a skip; each question
/// takes exactly one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "snake_case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QuestionAnswer {
    /// The picked options.
    Picked {
        /// Their labels.
        labels: BoundedVec<QuestionText, 1, { usize::MAX }>,
    },
    /// Typed text.
    Typed {
        /// The text.
        text: QuestionText,
    },
    /// A secret, delivered and never stored.
    Secret {
        /// The secret.
        value: QuestionText,
    },
    /// Skipped.
    Skipped {},
}

/// `question.resolve`: every answer at once, one per question in the record's own order. The
/// daemon refuses a list that does not answer every question rather than applying half of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionResolveRequest {
    /// The question.
    pub question_id: QuestionId,
    /// The answers.
    pub answers: BoundedVec<QuestionAnswer, 1, { usize::MAX }>,
}

/// A settled question's state: answered, or canceled with the turn that held it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum QuestionSettledState {
    /// Answered.
    Answered,
    /// Canceled with its turn.
    Canceled,
}

/// The `question.resolve` result: the record's settled state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionResolveResponse {
    /// The question.
    pub question_id: QuestionId,
    /// Its state.
    pub state: QuestionSettledState,
}

methods! {
    /// The `question.*` methods a client calls.
    pub const QUESTION_METHOD_DESCRIPTORS = [
        /// Answers every question of one record.
        QuestionResolve = mutation "question.resolve" {
            mutating: true,
            params: QuestionResolveRequest,
            result: QuestionResolveResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the question record.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "question",
    doc: "A question record and the one call that answers it.",
    definitions: &[
        Definition::read::<QuestionId>().checked(),
        Definition::read::<QuestionOption>(),
        Definition::read::<QuestionDefault>(),
        Definition::read::<QuestionPrompt>(),
        Definition::read::<QuestionAskedPayload>().checked(),
        Definition::read::<QuestionAnswer>(),
        Definition::read::<QuestionResolveRequest>().checked(),
        Definition::read::<QuestionSettledState>(),
        Definition::read::<QuestionResolveResponse>(),
    ],
    constants: &[],
    method_tables: &[&QUESTION_METHOD_DESCRIPTORS],
};
