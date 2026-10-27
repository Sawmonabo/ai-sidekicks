//! A review's end as Codex's `item/autoApprovalReview/completed` sends it, and the same review as
//! the `GuardianAssessmentEvent` Codex's `thread/approveGuardianDeniedAction` takes back: the
//! app-server's `camelCase` members read, Codex's own `snake_case` members written, field by field as
//! Codex's own app builds the event, the reviewed item left out as that app leaves it out.

use serde::{Deserialize, Serialize, Serializer};
use serde_json::Value;
use url::Url;

/// How a review ended, read in the app-server's spelling and written in Codex's own.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
pub(crate) enum GuardianAssessmentStatus {
    /// Still running.
    InProgress,
    /// The action may run.
    Approved,
    /// The action was blocked.
    Denied,
    /// The review ran out of time, which blocks the action.
    TimedOut,
    /// The review was stopped.
    Aborted,
}

impl GuardianAssessmentStatus {
    /// The status a review's wire word names, `None` for a word Codex does not send.
    pub(crate) fn read_wire(word: &str) -> Option<Self> {
        serde_json::from_value(Value::from(word)).ok()
    }

    /// Whether the review blocked the action.
    pub(crate) fn is_block(self) -> bool {
        matches!(self, Self::Denied | Self::TimedOut)
    }

    /// Whether the review settled the action itself, so a warning about it draws no row: an
    /// approval, as in Codex's own app, or a block, whose words the blocked action's row shows.
    pub(crate) fn is_settled_by_review(self) -> bool {
        matches!(self, Self::Approved) || self.is_block()
    }
}

/// The review's risk label.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GuardianRiskLevel {
    /// Low.
    Low,
    /// Medium.
    Medium,
    /// High.
    High,
    /// Critical.
    Critical,
}

/// How directly the conversation authorizes the reviewed action.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub(crate) enum GuardianUserAuthorization {
    /// Unknown.
    Unknown,
    /// Low.
    Low,
    /// Medium.
    Medium,
    /// High.
    High,
}

/// What produced the review's decision.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
pub(crate) enum GuardianAssessmentDecisionSource {
    /// The reviewing agent.
    Agent,
}

/// Which tool ran a reviewed command.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
pub(crate) enum GuardianCommandSource {
    /// The shell tool.
    Shell,
    /// The unified exec tool.
    UnifiedExec,
}

/// The protocol of a reviewed network access.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
pub(crate) enum NetworkApprovalProtocol {
    /// HTTP.
    Http,
    /// HTTPS.
    Https,
    /// SOCKS5 over TCP.
    Socks5Tcp,
    /// SOCKS5 over UDP.
    Socks5Udp,
}

/// The reviewed action, tagged by `type`.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "type",
    rename_all(serialize = "snake_case", deserialize = "camelCase"),
    rename_all_fields(serialize = "snake_case", deserialize = "camelCase")
)]
pub(crate) enum GuardianAssessmentAction {
    /// A shell command.
    Command {
        /// The tool that ran it.
        source: GuardianCommandSource,
        /// The command line.
        command: String,
        /// Where it ran.
        cwd: String,
    },
    /// One program a command executes.
    Execve {
        /// The tool that ran it.
        source: GuardianCommandSource,
        /// The program.
        program: String,
        /// Its arguments.
        argv: Vec<String>,
        /// Where it ran.
        cwd: String,
    },
    /// Input to a command that runs on, whose item is the command's own.
    WriteStdin {
        /// The input's own approval id.
        approval_id: String,
        /// The command's process.
        process_id: String,
        /// The input.
        stdin: String,
        /// The command's launch folder, which Codex takes back as a `file:` address.
        #[serde(serialize_with = "serialize_as_file_address")]
        cwd: String,
    },
    /// A patch.
    ApplyPatch {
        /// Where it applies.
        cwd: String,
        /// The files it touches.
        files: Vec<String>,
    },
    /// A network access a command made, which names no item.
    NetworkAccess {
        /// The address reached.
        target: String,
        /// Its host.
        host: String,
        /// Its protocol.
        protocol: NetworkApprovalProtocol,
        /// Its port.
        port: u16,
    },
    /// A tool server's tool call.
    McpToolCall {
        /// The tool server.
        server: String,
        /// The tool.
        tool_name: String,
        /// The connector's id, where one carries it.
        connector_id: Option<String>,
        /// The connector's name.
        connector_name: Option<String>,
        /// The tool's title.
        tool_title: Option<String>,
    },
    /// A request for more permissions.
    RequestPermissions {
        /// Why they are asked for.
        reason: Option<String>,
        /// The permissions.
        permissions: RequestPermissionProfile,
    },
}

/// Permissions a request asks for, read in the app-server's spelling and written in Codex's own.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
pub(crate) struct RequestPermissionProfile {
    /// Network access.
    network: Option<NetworkPermissions>,
    /// Folders to read and write.
    file_system: Option<FileSystemPermissions>,
}

/// Network access a request asks for.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct NetworkPermissions {
    /// Whether the network is on.
    enabled: Option<bool>,
}

/// Folders a request asks to read and write, as roots or as Codex's sandbox entries, each kept as
/// sent.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all(serialize = "snake_case", deserialize = "camelCase"))]
pub(crate) struct FileSystemPermissions {
    /// Folders to read.
    #[serde(skip_serializing_if = "Option::is_none")]
    read: Option<Vec<String>>,
    /// Folders to write.
    #[serde(skip_serializing_if = "Option::is_none")]
    write: Option<Vec<String>>,
    /// How deep a pattern is scanned.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    glob_scan_max_depth: Option<u64>,
    /// Codex's sandbox entries.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    entries: Option<Vec<Value>>,
}

/// The review's outcome inside the completion frame.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct GuardianApprovalReview {
    /// How it ended.
    pub(crate) status: GuardianAssessmentStatus,
    /// Its risk label.
    pub(crate) risk_level: Option<GuardianRiskLevel>,
    /// How directly the conversation authorizes the action.
    pub(crate) user_authorization: Option<GuardianUserAuthorization>,
    /// The reviewer's explanation.
    pub(crate) rationale: Option<String>,
}

/// The members of `item/autoApprovalReview/completed` a block is built from.
#[derive(Clone, Debug, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct ReviewCompletedParams {
    /// The conversation.
    pub(crate) thread_id: String,
    /// The turn.
    pub(crate) turn_id: String,
    /// When the review started, in Unix milliseconds.
    pub(crate) started_at_ms: i64,
    /// When it ended, in Unix milliseconds.
    pub(crate) completed_at_ms: i64,
    /// The review's own id.
    pub(crate) review_id: String,
    /// The reviewed item; `None` for a network access, which names none.
    pub(crate) target_item_id: Option<String>,
    /// What decided it.
    pub(crate) decision_source: GuardianAssessmentDecisionSource,
    /// Its outcome.
    pub(crate) review: GuardianApprovalReview,
    /// The reviewed action.
    pub(crate) action: GuardianAssessmentAction,
}

/// A review as Codex's own event, which `thread/approveGuardianDeniedAction` reads back.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub(crate) struct GuardianAssessmentEvent {
    /// The review's id.
    id: String,
    /// The turn.
    turn_id: String,
    /// When it started, in Unix milliseconds.
    started_at_ms: i64,
    /// When it ended, in Unix milliseconds.
    #[serde(skip_serializing_if = "Option::is_none")]
    completed_at_ms: Option<i64>,
    /// How it ended.
    status: GuardianAssessmentStatus,
    /// Its risk label.
    #[serde(skip_serializing_if = "Option::is_none")]
    risk_level: Option<GuardianRiskLevel>,
    /// How directly the conversation authorizes the action.
    #[serde(skip_serializing_if = "Option::is_none")]
    user_authorization: Option<GuardianUserAuthorization>,
    /// The reviewer's explanation.
    #[serde(skip_serializing_if = "Option::is_none")]
    rationale: Option<String>,
    /// What decided it.
    #[serde(skip_serializing_if = "Option::is_none")]
    decision_source: Option<GuardianAssessmentDecisionSource>,
    /// The reviewed action.
    action: GuardianAssessmentAction,
}

impl From<ReviewCompletedParams> for GuardianAssessmentEvent {
    fn from(completed: ReviewCompletedParams) -> Self {
        Self {
            id: completed.review_id,
            turn_id: completed.turn_id,
            started_at_ms: completed.started_at_ms,
            completed_at_ms: Some(completed.completed_at_ms),
            status: completed.review.status,
            risk_level: completed.review.risk_level,
            user_authorization: completed.review.user_authorization,
            rationale: completed.review.rationale,
            decision_source: Some(completed.decision_source),
            action: completed.action,
        }
    }
}

// A command's launch folder as the `file:` address Codex's event holds; a folder that is no
// absolute path stays as sent.
fn serialize_as_file_address<S: Serializer>(cwd: &str, serializer: S) -> Result<S::Ok, S::Error> {
    match Url::from_file_path(cwd) {
        Ok(address) => serializer.serialize_str(address.as_str()),
        Err(()) => serializer.serialize_str(cwd),
    }
}
