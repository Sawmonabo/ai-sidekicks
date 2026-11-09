//! A workflow's form and reply waits as session questions: each wait asked as one question record
//! in its run's session under its workflow's name, a form's pages read from the fields' schema the
//! record keeps, a `path` field's page answered with a folder picked through the platform's
//! chooser, and the card's answers made the wait's answer, a form's checked against its fields,
//! which the engine settles in the write that ends the wait.

#![expect(
    dead_code,
    reason = "the workflow engine's composition, which builds the bridge and registers it"
)]

use std::sync::Arc;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use serde_json::{Map, Value, json};
use sidekicks_contracts::question::{
    QuestionAnswer, QuestionAnswerInvalidReason, QuestionId, QuestionPrompt,
    WaitQuestionAskedPayload,
};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::id::UuidTextForm;
use sidekicks_contracts::wire::list::BoundedVec;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::{ComposedText, NonEmptyText};
use sidekicks_contracts::workflow::definition::document::WorkflowName;
use sidekicks_provider::mcp::elicitation_form::{
    compose_elicitation_content, read_elicitation_field_names, read_elicitation_questions,
};
use sidekicks_session::questions::QuestionSettledState;
use sidekicks_session::questions::service::QuestionsService;
use sidekicks_session::questions::waits::{QuestionWaitAnswer, QuestionWaitError, QuestionWaits};
use sidekicks_workflow::engine::ports::{
    FormQuestionRequest, PersonWaitQuestions, PortError, ReplyQuestionRequest,
};
use sidekicks_workflow::engine::waits::answers::{EngineAnswers, WaitAnswerError};
use sidekicks_workflow::engine::waits::form_check::{FormAnswerCheckError, check_form_answer};
use sidekicks_workflow::engine::waits::{PersonWaitAnswer, PersonWaitRefusal};

/// The pages of a record, from one page up.
type QuestionPages = BoundedVec<QuestionPrompt, 1, { usize::MAX }>;

/// The `format` a form's string field carries when its answer is a folder's path.
const PATH_FIELD_FORMAT: &str = "path";

/// The bridge between the workflow engine's form and reply waits and the session's questions: it
/// asks each wait's question and hands the card's answers to the engine.
pub(crate) struct WorkflowWaitQuestions {
    questions: Arc<QuestionsService>,
    answers: EngineAnswers,
}

impl WorkflowWaitQuestions {
    /// The bridge asking through `questions` and answering through the engine's `answers`.
    pub(crate) fn new(questions: Arc<QuestionsService>, answers: EngineAnswers) -> Self {
        Self { questions, answers }
    }
}

impl PersonWaitQuestions for WorkflowWaitQuestions {
    fn open_form(
        &self,
        request: FormQuestionRequest,
    ) -> BoxFuture<'_, Result<QuestionId, PortError>> {
        async move {
            let (pages, form_schema) = form_question(
                &request.workflow_name,
                &request.prompt,
                request.input_schema,
            )?;
            Ok(self
                .questions
                .ask_for_wait(
                    request.session_id,
                    request.wait_id,
                    pages,
                    Some(form_schema),
                )
                .await?)
        }
        .boxed()
    }

    fn open_reply(
        &self,
        request: ReplyQuestionRequest,
    ) -> BoxFuture<'_, Result<QuestionId, PortError>> {
        async move {
            let pages = reply_question(&request.workflow_name, &request.prompt);
            Ok(self
                .questions
                .ask_for_wait(request.session_id, request.wait_id, pages, None)
                .await?)
        }
        .boxed()
    }

    fn reattach(
        &self,
        session_id: SessionId,
        wait_id: UuidTextForm,
    ) -> BoxFuture<'_, Result<Option<QuestionId>, PortError>> {
        async move {
            Ok(self
                .questions
                .open_wait_question(session_id, wait_id)
                .await?)
        }
        .boxed()
    }
}

impl QuestionWaits for WorkflowWaitQuestions {
    fn answer_wait(
        &self,
        answer: QuestionWaitAnswer,
    ) -> BoxFuture<'_, Result<QuestionSettledState, QuestionWaitError>> {
        async move {
            let wait_answer = wait_answer(&answer.asked, &answer.answers)?;
            match self.answers.answer_wait(answer.wait_id, wait_answer).await {
                // A wait no longer waiting was settled by the step panel's answer or by a write
                // ending it that is in flight; the card follows that write's mark either way.
                Ok(()) | Err(WaitAnswerError::Refused(PersonWaitRefusal::NotWaiting)) => {
                    Ok(QuestionSettledState::Answered)
                }
                Err(closed @ WaitAnswerError::Closed) => {
                    Err(QuestionWaitError::Failed(Box::new(closed)))
                }
            }
        }
        .boxed()
    }
}

/// The card's chip: the workflow's name.
fn workflow_header(workflow_name: &WorkflowName) -> NonEmptyText {
    NonEmptyText::new(workflow_name.as_str().to_owned()).expect("a workflow's name is never empty")
}

/// The elicitation form a form wait asks: `prompt` as its message over the fields of
/// `form_schema`, the one value its pages and its answers are both read from.
fn form_params(prompt: &str, form_schema: &JsonRecord) -> Value {
    json!({ "mode": "form", "message": prompt, "requestedSchema": form_schema })
}

/// The pages a form wait asks, one per field of `input_schema` in its order under the workflow's
/// name, a string field of `format: "path"` asked as a path page, and the schema as the record
/// keeps it. Fails when the schema holds a member no record takes.
fn form_question(
    workflow_name: &WorkflowName,
    prompt: &ComposedText,
    input_schema: Map<String, Value>,
) -> Result<(QuestionPages, JsonRecord), serde_json::Error> {
    let form_schema: JsonRecord = serde_json::from_value(Value::Object(input_schema))?;
    let params = form_params(prompt.as_str(), &form_schema);
    let mut pages = read_elicitation_questions(&params, Some(workflow_header(workflow_name)));
    let properties = &params["requestedSchema"]["properties"];
    for (page, field) in pages.iter_mut().zip(read_elicitation_field_names(&params)) {
        if properties[field]["format"] == PATH_FIELD_FORMAT {
            page.path = Some(true);
        }
    }
    let pages = BoundedVec::new(pages).expect("a form with a message asks at least its message");
    Ok((pages, form_schema))
}

/// The one page a reply wait asks: its prompt as free text under the workflow's name, required,
/// so it takes no skip.
fn reply_question(workflow_name: &WorkflowName, prompt: &ComposedText) -> QuestionPages {
    let page = QuestionPrompt {
        header: Some(workflow_header(workflow_name)),
        text: NonEmptyText::new(prompt.as_str().to_owned()).expect("a prompt is never empty"),
        heading: None,
        description: None,
        options: Vec::new(),
        several_answers: false,
        secret: false,
        path: None,
        required: Some(true),
        default: None,
        minimum: None,
        maximum: None,
        step: None,
        unit: None,
        placeholder: None,
    };
    BoundedVec::new(vec![page]).expect("a reply asks one page")
}

/// The wait's answer the card's `answers` make for the record `asked`: a form's fields keyed by
/// each field's id, refused at the page of the first field its schema does not take, or a reply's
/// one typed text. Fails when the form's schema does not compile or a reply's answers are not one
/// typed text, which the session's check of a required free-text page lets through.
fn wait_answer(
    asked: &WaitQuestionAskedPayload,
    answers: &[QuestionAnswer],
) -> Result<PersonWaitAnswer, QuestionWaitError> {
    let Some(form_schema) = &asked.form_schema else {
        return match answers {
            [QuestionAnswer::Typed { text }] => Ok(PersonWaitAnswer::Reply(text.clone())),
            _ => Err(QuestionWaitError::Failed(
                "a reply takes one typed answer".into(),
            )),
        };
    };
    // A form with fields carries its message as each page's heading; one with none asks it alone.
    let first = &asked.questions.as_slice()[0];
    let message = first.heading.as_ref().unwrap_or(&first.text);
    let params = form_params(message.as_str(), form_schema);
    let fields = compose_elicitation_content(&params, answers);
    let schema = params["requestedSchema"]
        .as_object()
        .expect("a record writes as a JSON object");
    match check_form_answer(schema, &fields) {
        Ok(()) => Ok(PersonWaitAnswer::Form(fields)),
        Err(FormAnswerCheckError::FieldValueInvalid { field }) => {
            let page = field
                .and_then(|field| {
                    read_elicitation_field_names(&params)
                        .iter()
                        .position(|name| *name == field)
                })
                .unwrap_or(0);
            Err(QuestionWaitError::Refused {
                page,
                reason: QuestionAnswerInvalidReason::FieldValueInvalid,
            })
        }
        Err(invalid @ FormAnswerCheckError::SchemaInvalid(_)) => {
            Err(QuestionWaitError::Failed(Box::new(invalid)))
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::{Map, Value, json};
    use sidekicks_contracts::question::{
        QuestionAnswer, QuestionAnswerInvalidReason, QuestionId, WaitQuestionAskedPayload,
    };
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_contracts::wire::id::{UuidTextForm, mint_uuid_v7};
    use sidekicks_contracts::wire::text::{BoundedText, ComposedText};
    use sidekicks_contracts::workflow::definition::document::WorkflowName;
    use sidekicks_session::questions::waits::QuestionWaitError;
    use sidekicks_workflow::engine::waits::PersonWaitAnswer;

    use super::{QuestionPages, form_question, reply_question, wait_answer};

    /// The workflow the tests' waits belong to.
    fn workflow_name() -> WorkflowName {
        WorkflowName::new("Release notes".to_owned()).expect("a workflow's name")
    }

    /// What the tests' waits ask.
    fn prompt() -> ComposedText {
        ComposedText::new("Fill in the release".to_owned()).expect("a prompt")
    }

    /// The record a wait asked with `pages` and, for a form, `form_schema`.
    fn asked(pages: QuestionPages, form_schema: Option<Value>) -> WaitQuestionAskedPayload {
        WaitQuestionAskedPayload {
            question_id: QuestionId::try_from(mint_uuid_v7()).expect("a minted UUID"),
            session_id: SessionId::try_from(mint_uuid_v7()).expect("a minted UUID"),
            run_id: None,
            wait_id: UuidTextForm::from(mint_uuid_v7()),
            state: None,
            form_schema: form_schema
                .map(|schema| serde_json::from_value(schema).expect("a record")),
            is_agent_waiting: true,
            questions: pages,
        }
    }

    /// `schema` as the form kind hands it.
    fn input_schema(schema: Value) -> Map<String, Value> {
        let Value::Object(schema) = schema else {
            unreachable!("the test's schema is an object");
        };
        schema
    }

    /// A form's answers become one map keyed by each field's id, on a schema whose fields' titles
    /// differ from their ids and run out of alphabetical order: a picked label as its option's
    /// value and typed text in its field's type. Kills: fields keyed by title; the content composed
    /// from a re-sorted copy of the schema.
    #[test]
    fn a_forms_answers_are_keyed_by_field_id() {
        let schema = json!({
            "type": "object",
            "properties": {
                "zone": {
                    "type": "string",
                    "title": "Region",
                    "oneOf": [
                        { "const": "eu-west", "title": "Europe" },
                        { "const": "us-east", "title": "America" },
                    ],
                },
                "amount": { "type": "integer", "title": "How many" },
            },
            "required": ["zone", "amount"],
        });
        let (pages, _) = form_question(&workflow_name(), &prompt(), input_schema(schema.clone()))
            .expect("the schema is a record");
        let answers: Vec<QuestionAnswer> = serde_json::from_value(json!([
            { "kind": "picked", "labels": ["America"] },
            { "kind": "typed", "text": "3" },
        ]))
        .expect("the test's answers");

        let answered = wait_answer(&asked(pages, Some(schema)), &answers);

        let Ok(PersonWaitAnswer::Form(fields)) = answered else {
            panic!("a fitting form answer is taken: {answered:?}");
        };
        assert_eq!(
            Value::Object(fields),
            json!({ "zone": "us-east", "amount": 3 })
        );
    }

    /// A string field of `format: "path"` is asked as a path page and no other field is, and the
    /// folder picked on it becomes that field's value, the path as text. Kills: the format not
    /// read; every page marked; the marks paired with the schema's fields rather than the pages'.
    #[test]
    fn a_path_field_is_asked_as_a_path_page_and_answered_with_the_path() {
        let schema = json!({
            "type": "object",
            "properties": {
                "unasked": true,
                "note": { "type": "string", "title": "Note" },
                "where": { "type": "string", "format": "path", "title": "Folder" },
            },
            "required": ["where"],
        });
        let (pages, _) = form_question(&workflow_name(), &prompt(), input_schema(schema.clone()))
            .expect("the schema is a record");
        assert_eq!(
            pages
                .as_slice()
                .iter()
                .map(|page| page.path)
                .collect::<Vec<_>>(),
            [None, Some(true)]
        );
        let answers: Vec<QuestionAnswer> = serde_json::from_value(json!([
            { "kind": "skipped" },
            { "kind": "path", "path": "/Users/person/app" },
        ]))
        .expect("the test's answers");

        let answered = wait_answer(&asked(pages, Some(schema)), &answers);

        let Ok(PersonWaitAnswer::Form(fields)) = answered else {
            panic!("a picked folder is taken: {answered:?}");
        };
        assert_eq!(
            Value::Object(fields),
            json!({ "where": "/Users/person/app" })
        );
    }

    /// Text that is no number in an integer field is refused `fieldValueInvalid` at that field's
    /// page among the pages asked, with nothing handed to the engine. Kills: the check skipped;
    /// the page taken from the schema's properties, where a property the reader leaves out comes
    /// first.
    #[test]
    fn a_value_its_field_does_not_take_is_refused_at_its_page() {
        let schema = json!({
            "type": "object",
            "properties": {
                "unasked": true,
                "count": { "type": "integer", "title": "Count" },
            },
        });
        let (pages, _) = form_question(&workflow_name(), &prompt(), input_schema(schema.clone()))
            .expect("the schema is a record");
        let answers: Vec<QuestionAnswer> =
            serde_json::from_value(json!([{ "kind": "typed", "text": "abc" }]))
                .expect("the test's answers");

        let refused = wait_answer(&asked(pages, Some(schema)), &answers);

        let Err(QuestionWaitError::Refused { page, reason }) = refused else {
            panic!("the answer is refused: {refused:?}");
        };
        assert_eq!(
            (page, reason),
            (0, QuestionAnswerInvalidReason::FieldValueInvalid)
        );
    }

    /// A reply's one page is required, so it takes no skip, carries the workflow's name as its
    /// chip, and its one typed answer becomes the reply's text. Kills: the page not required.
    #[test]
    fn a_reply_is_one_required_page_whose_text_is_the_reply() {
        let pages = reply_question(&workflow_name(), &prompt());
        let page = &pages.as_slice()[0];
        assert_eq!(page.required, Some(true));
        assert_eq!(
            page.header.as_ref().map(BoundedText::as_str),
            Some("Release notes")
        );
        let answers: Vec<QuestionAnswer> =
            serde_json::from_value(json!([{ "kind": "typed", "text": "Ship it" }]))
                .expect("the test's answers");

        let answered = wait_answer(&asked(pages, None), &answers);

        let Ok(PersonWaitAnswer::Reply(text)) = answered else {
            panic!("a reply's text is taken: {answered:?}");
        };
        assert_eq!(text.as_str(), "Ship it");
    }
}
