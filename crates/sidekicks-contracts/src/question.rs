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

use crate::internal::branded::branded_uuid_id;
use crate::method::methods;
use crate::run::id::RunId;
use crate::session::id::SessionId;
use crate::typescript::{Definition, TypeScriptModule};
use crate::wire::Never;
use crate::wire::id::UuidTextForm;
use crate::wire::list::BoundedVec;
use crate::wire::number::Number;
use crate::wire::text::NonEmptyText;

branded_uuid_id! {
    /// The daemon-minted id of one question record.
    QuestionId
}

/// One option row; `preview` is present only where the provider attached one to the option.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionOption {
    /// The option's label.
    pub label: NonEmptyText,
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
    Number(Number),
    /// A yes-or-no field's value.
    Flag(bool),
    /// The labels a field of several picks preselects.
    Labels(Vec<NonEmptyText>),
}

/// One question of the record, one page of the card. A secret question takes a masked answer and
/// has no option rows; a numeric field's smallest number is at most its largest; a question with
/// option rows starts from its own options, which the schema states as `defaultAmongOptions`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[schemars(extend(
    "if" = {
        "type": "object",
        "properties": { "secret": { "const": true } },
        "required": ["secret"],
    },
    "then" = { "type": "object", "properties": { "options": { "type": "array", "maxItems": 0 } } },
    "defaultAmongOptions" = true,
))]
pub struct QuestionPrompt {
    /// The agent's own short header, a tool server's name, or a workflow's name.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub header: Option<NonEmptyText>,
    /// The question.
    pub text: NonEmptyText,
    /// The summary line, where the agent sent one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub heading: Option<NonEmptyText>,
    /// The question's own helper line, drawn faint under its text.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub description: Option<NonEmptyText>,
    /// The option rows; empty on a secret question.
    pub options: Vec<QuestionOption>,
    /// The provider's own reading of whether several picks go back together.
    pub several_answers: bool,
    /// Whether the answer is masked and never stored.
    pub secret: bool,
    /// Whether the form must have this field answered. Only a tool server's form field sets it, and
    /// a producer that sets it on an agent's question makes that question refuse typed text.
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
    #[schemars(with = "Number", extend("maximum" = { "$data": "1/maximum" }))]
    pub minimum: Option<Number>,
    /// The largest number a numeric field takes, where the form bounds it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Number")]
    pub maximum: Option<Number>,
    /// How far the arrow keys move a number field, where the question sets it.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Number")]
    pub step: Option<Number>,
    /// A short unit drawn as a suffix inside a number field, where the question sets one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub unit: Option<NonEmptyText>,
    /// A text field's faint hint while it is empty, where the question sets one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "NonEmptyText")]
    pub placeholder: Option<NonEmptyText>,
}

/// Each rule a prompt keeps, reported at the member that breaks it: option rows on a secret
/// question at `options`, a largest number below the smallest at `maximum`, and a default that is
/// not one of the prompt's own options at `default`.
impl garde::Validate for QuestionPrompt {
    type Context = ();

    fn validate_into(
        &self,
        (): &Self::Context,
        parent: &mut dyn FnMut() -> garde::Path,
        report: &mut garde::Report,
    ) {
        if self.secret && !self.options.is_empty() {
            report.append(
                parent().join("options"),
                garde::Error::new("a secret question draws a masked field and no option rows"),
            );
        }
        if let (Some(minimum), Some(maximum)) = (self.minimum, self.maximum)
            && minimum > maximum
        {
            report.append(
                parent().join("maximum"),
                garde::Error::new("a field's largest number is below its smallest"),
            );
        }
        let default_labels: Vec<&str> = match &self.default {
            Some(QuestionDefault::Text(label)) => vec![label.as_str()],
            Some(QuestionDefault::Labels(labels)) => {
                labels.iter().map(NonEmptyText::as_str).collect()
            }
            Some(QuestionDefault::Number(_) | QuestionDefault::Flag(_)) | None => Vec::new(),
        };
        let is_own_option = |label: &&str| {
            self.options
                .iter()
                .any(|option| option.label.as_str() == *label)
        };
        if !self.options.is_empty() && !default_labels.iter().all(is_own_option) {
            report.append(
                parent().join("default"),
                garde::Error::new("a question with option rows starts from one of its own options"),
            );
        }
    }
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
            /// of its own is raised, and the admission of the queued message naming it as
            /// `answersQuestionId` marks it answered.
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

/// Why an open question ended unanswered: its turn was interrupted, its provider withdrew the
/// request, or its run ended, a restart of the background service among the ways a run ends.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum QuestionCanceledReason {
    /// Its turn was interrupted.
    Interrupted,
    /// The provider withdrew the request.
    Withdrawn,
    /// Its run ended.
    RunEnded,
}

/// `question.canceled`: an open question ended unanswered, so its card stays closed after a
/// reload and on every device, and no `user.message.sent` is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct QuestionCanceledPayload {
    /// The session.
    pub session_id: SessionId,
    /// The question.
    pub question_id: QuestionId,
    /// Why it ended.
    pub reason: QuestionCanceledReason,
}

/// The answer to one question: the picked labels, typed text, a secret, or a skip; each question
/// takes exactly one.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum QuestionAnswer {
    /// The picked options.
    Picked {
        /// Their labels.
        labels: BoundedVec<NonEmptyText, 1, { usize::MAX }>,
    },
    /// Typed text.
    Typed {
        /// The text.
        text: NonEmptyText,
    },
    /// A secret, delivered and never stored.
    Secret {
        /// The secret.
        value: NonEmptyText,
    },
    /// Skipped.
    Skipped {},
}

/// `question.resolve`: every answer at once, one per question in the record's own order. The
/// daemon refuses a list that does not answer every question rather than applying half of it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct QuestionResolveRequest {
    /// The question.
    pub question_id: QuestionId,
    /// The answers.
    pub answers: BoundedVec<QuestionAnswer, 1, { usize::MAX }>,
}

/// A settled question's state: answered, or canceled with the turn that held it.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum QuestionSettledState {
    /// Answered.
    Answered,
    /// Canceled with its turn.
    Canceled,
}

/// The `question.resolve` result: the record's settled state.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct QuestionResolveResponse {
    /// The question.
    pub question_id: QuestionId,
    /// Its state.
    pub state: QuestionSettledState,
}

/// Why `question.answerInvalid` refused one answer, carried as its `reason`: a secret for a plain
/// question, a label the question does not offer, several labels for a question that takes one,
/// or typed text for a question that takes only its options.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum QuestionAnswerInvalidReason {
    /// A secret for a question that is not secret, or anything but a secret or a skip for one that
    /// is.
    SecretOnPlain,
    /// A label the question does not offer.
    LabelNotOffered,
    /// Several labels for a question that takes one.
    SeveralOnSingle,
    /// Typed text for a question that takes only its options.
    TextOnChoice,
}

methods! {
    /// The `question.*` methods a client calls.
    pub const QUESTION_METHOD_DESCRIPTORS = [
        /// Answers every question of one record.
        QuestionResolve = mutation "question.resolve" {
            mutating: true,
            params: QuestionResolveRequest,
            result: QuestionResolveResponse,
            refusals: [
                QuestionNotFound,
                QuestionNotWaiting,
                QuestionAnswersIncomplete,
                QuestionAnswerInvalid,
            ],
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
        Definition::read::<QuestionCanceledReason>(),
        Definition::read::<QuestionCanceledPayload>().checked(),
        Definition::read::<QuestionAnswer>(),
        Definition::read::<QuestionAnswerInvalidReason>(),
        Definition::read::<QuestionResolveRequest>().checked(),
        Definition::read::<QuestionSettledState>(),
        Definition::read::<QuestionResolveResponse>(),
    ],
    constants: &[],
    method_tables: &[&QUESTION_METHOD_DESCRIPTORS],
};
