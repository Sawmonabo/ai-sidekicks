//! The status file the service writes in its run folder, on every operating system, holding one of
//! three facts: why its last start failed, the stop under way, or why its last stop failed. The
//! desktop's main process and `sidekicks daemon status` read it while the service is not answering.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use strum::VariantArray;

use crate::free_form_string::FilesystemPath;
use crate::process_identity::ProcessIdentity;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::instant::WireInstant;

ts_constants! {
    /// Each stop step's words after `The background service is still`, keyed by the step's wire
    /// name.
    DAEMON_STOP_STEP_PHRASES = DaemonStopStep::VARIANTS
        .iter()
        .map(|step| {
            let name = serde_json::from_value::<String>(serde_json::to_value(step)?)?;
            Ok((name, serde_json::Value::from(step.phrase())))
        })
        .collect::<serde_json::Result<serde_json::Map<String, serde_json::Value>>>()?;
}

/// Why the service cannot start, in `reason`, with the folder a damaged store's copy sits in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum DaemonCannotStart {
    /// Another account's process holds the service's connection name: Windows.
    ConnectionNameTaken {},
    /// The service is turned off in Login Items: macOS.
    TurnedOffInLoginItems {},
    /// The saved sessions are damaged and their repair could not heal them; nothing was changed.
    SavedSessionsUnrepaired {
        /// The folder the damaged saved sessions are copied aside in.
        aside_folder: FilesystemPath,
    },
    /// The saved sessions are from another version of the service, which this one never migrates.
    SavedSessionsFromAnotherVersion {},
}

/// A step of the service's stop that a `stopping` record names while its wait runs.
#[derive(
    Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema, VariantArray,
)]
#[serde(rename_all = "camelCase")]
pub enum DaemonStopStep {
    /// The serving socket closing.
    Gateway,
    /// The providers' capability refresh ending.
    CapabilityRefresh,
    /// The tool servers' connections closing.
    ToolServers,
    /// The run queue ending, so no run is admitted or delivered.
    RunQueue,
    /// The repository services' background work ending.
    RepositoryAttachments,
    /// The attention service's decision task ending, a write under way waited out.
    AttentionDecisions,
    /// The web address's sender ending, a write under way waited out.
    WebAddressSender,
    /// The price list's fetch and the held requests' repricing ending, a write under way waited
    /// out.
    Pricing,
    /// The session services' follows of the log ending with the chats' write watch.
    SessionFollows,
    /// The chats' file recount ending, where no session services ran.
    ChatsRecount,
    /// The chats' change feed ending.
    ChatsChanges,
    /// The terminals draining, a shell that ignores its stop ended at the drain's own bound.
    Terminals,
    /// The provider accounts' sign-ins settling, then the sweep of new accounts' homes.
    SignIns,
    /// The background jobs' scheduler ending.
    Scheduler,
    /// The repositories' folder watch ending.
    FolderWatch,
    /// The session search index closing.
    SearchIndex,
    /// The MCP binding edits' settle pass ending, dropped past the bound and run again at the next
    /// start.
    McpSettle,
    /// The MCP server sign-ins ending: every attempt and its listener closing, every provider's
    /// flow and revocation canceled.
    McpSignIns,
    /// The providers' services ending, each told why the service stops.
    Providers,
    /// The person's Stop ending the runs still live.
    LiveRunsDrain,
    /// The turn-end captures under way, each waited out whole.
    TurnCaptures,
    /// The trees of git's failed calls ending.
    GitTrees,
    /// The workspace services' work settling, so nothing writes once the work's stop ends.
    WorkspaceWorkSettle,
    /// Everything that holds a file in the data folder closing, the saved sessions' file last.
    DataFolderClose,
}

impl DaemonStopStep {
    /// The step in a person's words, which follow `The background service is still`.
    pub const fn phrase(self) -> &'static str {
        match self {
            Self::Gateway => "closing the connection to the app",
            Self::CapabilityRefresh => "finishing a check of what the sidekicks can do",
            Self::ToolServers => "disconnecting the MCP servers",
            Self::RunQueue => "pausing the queued messages",
            Self::RepositoryAttachments => "ending the repositories' background work",
            Self::AttentionDecisions => "finishing the notifications under way",
            Self::WebAddressSender => "sending the last message to the web address",
            Self::Pricing => "finishing the price updates",
            Self::SessionFollows | Self::ChatsRecount | Self::ChatsChanges => {
                "finishing the chats' updates"
            }
            Self::Terminals => "closing the terminals",
            Self::SignIns => "ending the sign-ins under way",
            Self::Scheduler => "stopping the background jobs",
            Self::FolderWatch => "stopping the watch on the repositories' folders",
            Self::SearchIndex => "closing the search index",
            Self::McpSettle => "finishing the MCP server changes",
            Self::McpSignIns => "ending the MCP server sign-ins under way",
            Self::Providers => "stopping the sidekicks",
            Self::LiveRunsDrain => "ending the turns still running",
            Self::TurnCaptures => "saving the file changes of the last turns",
            Self::GitTrees => "cleaning up after git",
            Self::WorkspaceWorkSettle => "finishing the workspace cleanup",
            Self::DataFolderClose => "closing the saved sessions",
        }
    }
}

/// The stop under way: the step it waits on, when it began and the service's own process.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub struct DaemonStopping {
    /// The step under way.
    pub step: DaemonStopStep,
    /// When the stop began, on the wall clock.
    #[garde(dive)]
    pub stop_started: WireInstant,
    /// The service's own process, so a reader knows the record is stale once that process is gone.
    pub process: ProcessIdentity,
}

/// Why the service's last stop failed, in `reason`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(
    tag = "reason",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
#[garde(allow_unvalidated)]
pub enum DaemonCannotStop {
    /// The person's Stop could not be kept on disk, so the next start would resume what was
    /// stopped.
    StopIntent {},
}

/// The status file's content: one of three facts, keyed by its name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema, garde::Validate)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
#[garde(allow_unvalidated)]
pub enum ServiceStatusFile {
    /// Why the last start failed.
    CannotStart(#[garde(dive)] DaemonCannotStart),
    /// The stop under way.
    Stopping(#[garde(dive)] DaemonStopping),
    /// Why the last stop failed.
    CannotStop(#[garde(dive)] DaemonCannotStop),
}

/// The module's TypeScript face.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "daemon/service-status",
    doc: "The status file the service writes in its run folder: why it cannot start, the stop \
          under way, or why it cannot stop.",
    definitions: &[
        Definition::read::<DaemonCannotStart>(),
        Definition::read::<DaemonStopStep>(),
        Definition::read::<DaemonStopping>(),
        Definition::read::<DaemonCannotStop>(),
        Definition::read::<ServiceStatusFile>().checked(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;

    use super::ServiceStatusFile;

    /// Each of the three facts reads and writes back byte for byte; a file holding two facts and a
    /// `stopping` with a member it does not declare are refused. Mutation: drop
    /// `deny_unknown_fields` from `DaemonStopping`, so the unknown member reads; the two facts are
    /// refused by the one-key shape of the file itself.
    #[rstest]
    #[case::cannot_start(
        r#"{"cannotStart":{"reason":"savedSessionsFromAnotherVersion"}}"#,
        true
    )]
    #[case::stopping(
        concat!(
            r#"{"stopping":{"step":"scheduler","stopStarted":"2026-11-03T23:00:00.000Z","#,
            r#""process":{"processId":4242,"bootId":"boot","processStartTime":"1730674800"}}}"#
        ),
        true
    )]
    #[case::cannot_stop(r#"{"cannotStop":{"reason":"stopIntent"}}"#, true)]
    #[case::two_facts(
        concat!(
            r#"{"cannotStart":{"reason":"savedSessionsFromAnotherVersion"},"#,
            r#""cannotStop":{"reason":"stopIntent"}}"#
        ),
        false
    )]
    #[case::stopping_with_an_unknown_member(
        concat!(
            r#"{"stopping":{"step":"scheduler","stopStarted":"2026-11-03T23:00:00.000Z","#,
            r#""process":{"processId":4242,"bootId":"boot","processStartTime":"1730674800"},"#,
            r#""exitCode":1}}"#
        ),
        false
    )]
    fn the_status_file_holds_exactly_one_fact(#[case] text: &str, #[case] is_accepted: bool) {
        let parsed = serde_json::from_str::<ServiceStatusFile>(text);

        assert_eq!(parsed.is_ok(), is_accepted, "{text}");
        if let Ok(file) = parsed {
            assert_eq!(serde_json::to_string(&file).expect("the file writes"), text);
        }
    }
}
