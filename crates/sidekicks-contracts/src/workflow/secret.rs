//! Workflow secrets: the records a step's Credential chooser lists and manages, the
//! `secret://<scope>/<name>` reference a node's sensitive parameter stores, the `workflow.secret*`
//! methods and the refusals a secret answers with.
//!
//! A secret's value is sealed in the operating system's keychain by the daemon. The value crosses
//! the wire once, inward, as `secretValue` on a create or a replace; it is on no reply, event, log
//! or error, and a document, a step record or a log holds only the reference. A reference resolves
//! only in the step that runs, and only in a parameter its kind marks sensitive.

use std::borrow::Cow;
use std::fmt;
use std::str::FromStr;

use schemars::{JsonSchema, Schema, SchemaGenerator, json_schema};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize, Serializer};

use crate::internal::branded::branded_uuid_id;
use crate::keychain::KeychainRefusalCause;
use crate::method::methods;
use crate::method_descriptor::EmptyPayload;
use crate::project::ProjectId;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::Never;
use crate::wire::text::{FreeFormText, pattern_text};

ts_constants! {
    /// Wire members a request-logging transport redacts before writing a record: the value of a
    /// secret's create or replace.
    pub const WORKFLOW_SECRET_REDACTED_WIRE_MEMBERS: [&str; 1] = ["secretValue"];
}

branded_uuid_id! {
    /// A secret record's id, a UUID the daemon mints.
    WorkflowSecretId
}

/// The secret-name rule, spelled once for the name's pattern and the reference's: lowercase
/// letters, digits and hyphens, starting with a letter or digit, at most 64 characters.
macro_rules! secret_name_rule {
    () => {
        "[a-z0-9][a-z0-9-]{0,63}"
    };
}

pattern_text! {
    /// A secret's name: lowercase letters, digits and hyphens, starting with a letter or digit, at
    /// most 64 characters.
    pub struct WorkflowSecretName(concat!("^", secret_name_rule!(), "$"));
}

/// Where a secret is visible: the runs that work in one project, or every run on this machine.
/// Never a session.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowSecretScope {
    /// The runs that work in one project.
    Project,
    /// Every run on this machine.
    Shared,
}

impl WorkflowSecretScope {
    /// The scope's wire word.
    fn as_str(self) -> &'static str {
        match self {
            Self::Project => "project",
            Self::Shared => "shared",
        }
    }
}

/// What a `secret://<scope>/<name>` reference names: a scope and a name within it. It travels as
/// its text; a `project` reference resolves in the project the run works in, so a run in no
/// project resolves only shared ones.
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub struct WorkflowSecretReference {
    /// The scope the name is looked up in.
    pub scope: WorkflowSecretScope,
    /// The secret's name.
    pub name: WorkflowSecretName,
}

/// Why a text is not a secret reference.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
#[error("a secret is written secret://shared/<name> or secret://project/<name>")]
pub struct WorkflowSecretReferenceError;

impl WorkflowSecretReference {
    /// The reference's pattern: exactly one `secret://` reference, the text [`FromStr`] reads.
    pub const PATTERN: &str = concat!("^secret://(?:project|shared)/", secret_name_rule!(), "$");
}

impl FromStr for WorkflowSecretReference {
    type Err = WorkflowSecretReferenceError;

    /// Reads a reference back from its text; refuses another scheme, a scope other than `project`
    /// or `shared`, and a name that breaks the name rule. The daemon's check at save uses it to
    /// find a reference outside a sensitive parameter.
    fn from_str(text: &str) -> Result<Self, Self::Err> {
        let (scope, name) = text
            .strip_prefix("secret://")
            .and_then(|rest| rest.split_once('/'))
            .ok_or(WorkflowSecretReferenceError)?;
        let scope = match scope {
            "project" => WorkflowSecretScope::Project,
            "shared" => WorkflowSecretScope::Shared,
            _ => return Err(WorkflowSecretReferenceError),
        };
        let name = WorkflowSecretName::new(name.to_owned()).ok_or(WorkflowSecretReferenceError)?;
        Ok(Self { scope, name })
    }
}

impl fmt::Display for WorkflowSecretReference {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(
            formatter,
            "secret://{}/{}",
            self.scope.as_str(),
            self.name.as_str()
        )
    }
}

impl Serialize for WorkflowSecretReference {
    fn serialize<S: Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.collect_str(self)
    }
}

impl<'de> Deserialize<'de> for WorkflowSecretReference {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        String::deserialize(deserializer)?
            .parse()
            .map_err(D::Error::custom)
    }
}

impl JsonSchema for WorkflowSecretReference {
    fn schema_name() -> Cow<'static, str> {
        "WorkflowSecretReference".into()
    }

    fn json_schema(_generator: &mut SchemaGenerator) -> Schema {
        json_schema!({
            "description": "A string that is exactly one secret reference, \
                            secret://shared/<name> or secret://project/<name>.",
            "type": "string",
            "pattern": Self::PATTERN,
        })
    }
}

/// A secret's value, write-only: it arrives on a create or a replace, is sealed in the keychain,
/// and is on no reply, event, log or error. Its `Debug` form leaves it out.
#[derive(Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct WorkflowSecretValue(FreeFormText<{ usize::MAX }>);

impl WorkflowSecretValue {
    /// The value, for the keychain seal alone.
    pub fn as_str(&self) -> &str {
        self.0.as_str()
    }
}

impl fmt::Debug for WorkflowSecretValue {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("<redacted>")
    }
}

impl JsonSchema for WorkflowSecretValue {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        "WorkflowSecretValue".into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        FreeFormText::<{ usize::MAX }>::json_schema(generator)
    }
}

/// Declares a union over a secret's place, `project` with the project record's id or `shared` with
/// none, the members every place carries spelled once.
macro_rules! workflow_secret_place {
    ($(#[$attribute:meta])+ pub enum $name:ident { $($members:tt)* }) => {
        $(#[$attribute])+
        pub enum $name {
            /// A project's secret, visible to the runs that work in that project.
            Project {
                $($members)*
                /// The project record's id.
                scope_ref: ProjectId,
            },
            /// A shared secret, visible to every run on this machine.
            Shared {
                $($members)*
                /// Never present: a shared secret belongs to no project.
                #[serde(
                    default,
                    skip_serializing_if = "Option::is_none",
                    deserialize_with = "crate::wire::present"
                )]
                #[schemars(with = "Never")]
                scope_ref: Option<Never>,
            },
        }
    };
}

workflow_secret_place! {
    /// One secret as the chooser lists it: its place and name, and never its value.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(
        tag = "scope",
        rename_all = "snake_case",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    #[garde(allow_unvalidated)]
    pub enum WorkflowSecretSummary {
        /// The record's id.
        secret_id: WorkflowSecretId,
        /// The secret's name.
        name: WorkflowSecretName,
    }
}

workflow_secret_place! {
    /// The `workflow.secretCreate` input: the daemon seals `secretValue` in the keychain before it
    /// writes the record, so a keychain that cannot take it leaves no record. A `name` that breaks
    /// the rule or that the place already holds is refused with `workflow.secret_name_invalid`.
    #[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
    #[serde(
        tag = "scope",
        rename_all = "snake_case",
        rename_all_fields = "camelCase",
        deny_unknown_fields
    )]
    #[garde(allow_unvalidated)]
    pub enum WorkflowSecretCreateRequest {
        /// The name asked for, as typed: any text, so a name that breaks the rule reaches the
        /// daemon's own refusal.
        name: String,
        /// The value to seal.
        secret_value: WorkflowSecretValue,
    }
}

/// The `workflow.secretReplace` input: a new value for one secret, sealed before the record's
/// change is written.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowSecretReplaceRequest {
    /// The secret.
    pub secret_id: WorkflowSecretId,
    /// The new value.
    pub secret_value: WorkflowSecretValue,
}

/// The `workflow.secretDelete` input: the daemon records the removal, then removes the keychain
/// entry and the record, so a crash between the two finishes it. A version that still names the
/// secret fails its step with `workflow.secret_not_found`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowSecretDeleteRequest {
    /// The secret.
    pub secret_id: WorkflowSecretId,
}

/// The secret a replace or a delete acted on.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowSecretActResponse {
    /// The secret.
    pub secret_id: WorkflowSecretId,
}

/// The `workflow.secretList` result: every secret by name, shared and each project's, one row
/// each, and no member carries a value. The request names nothing: a workflow belongs to no
/// project, so the chooser lists them all.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct WorkflowSecretListResponse {
    /// The secrets.
    pub secrets: Vec<WorkflowSecretSummary>,
}

/// Why a secret's name was refused.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "snake_case")]
pub enum WorkflowSecretNameInvalidReason {
    /// The name breaks the name rule.
    Pattern,
    /// The place already holds the name.
    Taken,
}

/// The details of `workflow.secret_name_invalid`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSecretNameInvalidDetails {
    /// Why.
    pub reason: WorkflowSecretNameInvalidReason,
}

/// A step's secret the keychain does not hold: only the reference, as the step stored it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSecretReferenceNotFound {
    /// The reference.
    pub reference: WorkflowSecretReference,
    /// Never present: a step names its secret by reference.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub secret_id: Option<Never>,
}

/// A replace or a delete naming a secret no record holds.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSecretRecordNotFound {
    /// Never present: a replace or a delete names its secret by id.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Never")]
    pub reference: Option<Never>,
    /// The id asked for.
    pub secret_id: WorkflowSecretId,
}

/// The details of `workflow.secret_not_found`: the reference a failed step stored, or the id a
/// replace or a delete named, one or the other.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum WorkflowSecretNotFoundDetails {
    /// A step's reference.
    Reference(WorkflowSecretReferenceNotFound),
    /// A replace's or a delete's id.
    Record(WorkflowSecretRecordNotFound),
}

/// The details of `workflow.secret_store_unavailable`: why the keychain could not be used. A create
/// or replace is refused, and a step fails and offers `Retry from this step`, never waiting on the
/// keychain or keeping the value anywhere else.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct WorkflowSecretStoreUnavailableDetails {
    /// Why.
    pub cause: KeychainRefusalCause,
}

methods! {
    /// The workflow secrets' method table.
    pub const WORKFLOW_SECRET_METHOD_DESCRIPTORS = [
        /// Seals a new secret's value and records it under a place and a name.
        WorkflowSecretCreate = mutation "workflow.secretCreate" {
            mutating: true,
            params: WorkflowSecretCreateRequest,
            result: WorkflowSecretSummary,
            refusals: [WorkflowSecretNameInvalid, WorkflowSecretStoreUnavailable],
        },
        /// Replaces a secret's value.
        WorkflowSecretReplace = mutation "workflow.secretReplace" {
            mutating: true,
            params: WorkflowSecretReplaceRequest,
            result: WorkflowSecretActResponse,
            refusals: [WorkflowSecretNotFound, WorkflowSecretStoreUnavailable],
        },
        /// Deletes a secret's record and its stored value.
        WorkflowSecretDelete = mutation "workflow.secretDelete" {
            mutating: true,
            params: WorkflowSecretDeleteRequest,
            result: WorkflowSecretActResponse,
            refusals: [WorkflowSecretNotFound],
        },
        /// Lists every secret by name, never a value.
        WorkflowSecretList = query "workflow.secretList" {
            mutating: false,
            params: EmptyPayload,
            result: WorkflowSecretListResponse,
            refusals: [],
        },
    ];
}

/// The TypeScript module of the workflow secrets.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "workflow/secret",
    doc: "Workflow secrets: the records a step's Credential chooser lists and manages, the \
          `secret://<scope>/<name>` reference a node's sensitive parameter stores, the \
          `workflow.secret*` methods and the refusals a secret answers with.",
    definitions: &[
        Definition::read::<WorkflowSecretId>().checked(),
        Definition::read::<WorkflowSecretName>(),
        Definition::read::<WorkflowSecretScope>(),
        Definition::read::<WorkflowSecretReference>(),
        Definition::read::<WorkflowSecretSummary>().checked(),
        Definition::read::<WorkflowSecretCreateRequest>().checked(),
        Definition::read::<WorkflowSecretReplaceRequest>().checked(),
        Definition::read::<WorkflowSecretDeleteRequest>().checked(),
        Definition::read::<WorkflowSecretActResponse>().checked(),
        Definition::read::<WorkflowSecretListResponse>().checked(),
        Definition::read::<WorkflowSecretNameInvalidReason>(),
        Definition::read::<WorkflowSecretNameInvalidDetails>().checked(),
        Definition::read::<WorkflowSecretReferenceNotFound>(),
        Definition::read::<WorkflowSecretRecordNotFound>(),
        Definition::read::<WorkflowSecretNotFoundDetails>().checked(),
        Definition::read::<WorkflowSecretStoreUnavailableDetails>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[&WORKFLOW_SECRET_METHOD_DESCRIPTORS],
};

#[cfg(test)]
mod tests {
    use regex::Regex;
    use rstest::rstest;
    use serde::de::DeserializeOwned;
    use serde_json::{Value, json};

    use super::{
        WorkflowSecretCreateRequest, WorkflowSecretReference, WorkflowSecretReplaceRequest,
    };
    use crate::repo::clone::RepoCloneAnswerRequest;
    use crate::workflow::definition::builder::WorkflowWebhookTokenRotateResponse;

    /// The secret every leak case carries.
    const SECRET: &str = "hunter2-do-not-print";

    /// The record and workflow id the leak cases name.
    const RECORD_ID: &str = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e";

    #[rstest]
    #[case::shared("secret://shared/github-read", true)]
    #[case::project("secret://project/0-api-key", true)]
    #[case::a_64_character_name(&format!("secret://shared/{}", "a".repeat(64)), true)]
    #[case::trailing_line_break("secret://shared/github-read\n", false)]
    #[case::second_segment("secret://shared/github/read", false)]
    #[case::uppercase("secret://shared/GitHub-read", false)]
    #[case::a_65_character_name(&format!("secret://shared/{}", "a".repeat(65)), false)]
    #[case::leading_hyphen("secret://shared/-read", false)]
    #[case::session_scope("secret://session/github-read", false)]
    #[case::other_scheme("vault://shared/github-read", false)]
    fn a_reference_reads_where_its_pattern_matches_and_prints_back(
        #[case] text: &str,
        #[case] is_reference: bool,
    ) {
        let pattern = Regex::new(WorkflowSecretReference::PATTERN).expect("the pattern compiles");
        let parsed = text.parse::<WorkflowSecretReference>().ok();
        assert_eq!(pattern.is_match(text), is_reference);
        assert_eq!(parsed.is_some(), is_reference);
        if let Some(reference) = parsed {
            assert_eq!(reference.to_string(), text);
        }
    }

    /// The `Debug` form of `T` read from `message`.
    fn debug_of<T: DeserializeOwned + std::fmt::Debug>(message: Value) -> String {
        format!(
            "{:?}",
            serde_json::from_value::<T>(message).expect("the message reads")
        )
    }

    #[rstest]
    #[case::create(&debug_of::<WorkflowSecretCreateRequest>(json!({
        "scope": "shared",
        "name": "github-read",
        "secretValue": SECRET,
    })))]
    #[case::replace(&debug_of::<WorkflowSecretReplaceRequest>(json!({
        "secretId": RECORD_ID,
        "secretValue": SECRET,
    })))]
    #[case::token_rotate(&debug_of::<WorkflowWebhookTokenRotateResponse>(json!({
        "definitionId": RECORD_ID,
        "token": SECRET,
        "createdAt": "2026-10-13T12:00:00.000Z",
    })))]
    #[case::clone_answer(&debug_of::<RepoCloneAnswerRequest>(json!({
        "projectId": RECORD_ID,
        "questionId": RECORD_ID,
        "answer": SECRET,
    })))]
    fn a_write_only_value_never_reaches_a_debug_form(#[case] debug: &str) {
        assert!(!debug.contains(SECRET), "{debug}");
        assert!(debug.contains("<redacted>"), "{debug}");
    }
}
