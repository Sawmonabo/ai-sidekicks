//! The commands a conversation left running, and ending them. An interrupt stops the turn but not
//! its commands, and a command outlives its turn until it exits, so the daemon ends them itself on
//! an interrupt and at a session's close, and reads them before it lets go of a conversation.

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::codex::app_server_protocol::{
    ThreadBackgroundTerminalsCleanParams, ThreadBackgroundTerminalsListParams,
    ThreadBackgroundTerminalsTerminateParams,
};
use crate::codex::session::errors::CodexError;
use crate::codex::transport::connection::{CodexAppServerConnection, read_codex_object};
use crate::codex::transport::diagnostics::{CodexTeardownStep, CodexTransportDiagnostic};

const BACKGROUND_TERMINALS_LIST_METHOD: &str = "thread/backgroundTerminals/list";

const BACKGROUND_TERMINALS_TERMINATE_METHOD: &str = "thread/backgroundTerminals/terminate";

const BACKGROUND_TERMINALS_CLEAN_METHOD: &str = "thread/backgroundTerminals/clean";

/// The most pages one list read follows, so a cursor that never ends cannot spin the read.
const BACKGROUND_TERMINALS_PAGE_LIMIT: usize = 20;

// The members of a list page the read reads; an absent or empty `nextCursor` ends the paging.
#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TerminalsPage {
    data: Vec<Box<RawValue>>,
    next_cursor: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ListedTerminal {
    process_id: Option<Box<RawValue>>,
}

/// The process id of every command `thread_id` still runs, as Codex's schema types it, text,
/// read page by page within twenty pages. Fails as a page's request fails, and with
/// `CodexError::Transport` for a reply that is not a page or a cursor past the page bound.
pub(crate) async fn list_codex_running_commands(
    connection: &CodexAppServerConnection,
    thread_id: &str,
) -> Result<Vec<String>, CodexError> {
    let mut process_ids = Vec::new();
    let mut cursor: Option<String> = None;
    for _page in 0..BACKGROUND_TERMINALS_PAGE_LIMIT {
        let reply = connection
            .request(
                BACKGROUND_TERMINALS_LIST_METHOD,
                &ThreadBackgroundTerminalsListParams {
                    cursor: cursor.take(),
                    limit: None,
                    thread_id: thread_id.to_owned(),
                },
            )
            .await?;
        let page = read_codex_object::<TerminalsPage>(reply.get()).ok_or_else(|| {
            CodexError::Transport {
                detail: format!(
                    "The Codex service's \"{BACKGROUND_TERMINALS_LIST_METHOD}\" reply is not a page."
                ),
                cause: None,
            }
        })?;
        process_ids.extend(page.data.iter().filter_map(|entry| {
            read_codex_object::<ListedTerminal>(entry.get())?
                .process_id
                .and_then(|id| serde_json::from_str::<String>(id.get()).ok())
                .filter(|id| !id.is_empty())
        }));
        match page.next_cursor.filter(|next| !next.is_empty()) {
            Some(next) => cursor = Some(next),
            None => return Ok(process_ids),
        }
    }
    Err(CodexError::Transport {
        detail: format!(
            "The Codex service's \"{BACKGROUND_TERMINALS_LIST_METHOD}\" kept naming another page \
             past {BACKGROUND_TERMINALS_PAGE_LIMIT}."
        ),
        cause: None,
    })
}

/// Terminates every command `thread_id` still runs; with `is_cleaned`, also has Codex drop their
/// records, as a session's close does. A step that fails is reported and the rest still run,
/// since the caller's own outcome must stand; whether the conversation may be let go is the next
/// list read's to say.
pub(crate) async fn end_codex_running_commands(
    connection: &CodexAppServerConnection,
    thread_id: &str,
    is_cleaned: bool,
) {
    let process_ids = match list_codex_running_commands(connection, thread_id).await {
        Ok(process_ids) => process_ids,
        Err(error) => {
            report_step_failed(CodexTeardownStep::BackgroundTerminalList, error);
            Vec::new()
        }
    };
    for process_id in process_ids {
        let terminated = connection
            .request(
                BACKGROUND_TERMINALS_TERMINATE_METHOD,
                &ThreadBackgroundTerminalsTerminateParams {
                    process_id,
                    thread_id: thread_id.to_owned(),
                },
            )
            .await;
        if let Err(error) = terminated {
            report_step_failed(CodexTeardownStep::BackgroundTerminalTerminate, error);
        }
    }
    if !is_cleaned {
        return;
    }
    let cleaned = connection
        .request(
            BACKGROUND_TERMINALS_CLEAN_METHOD,
            &ThreadBackgroundTerminalsCleanParams {
                thread_id: thread_id.to_owned(),
            },
        )
        .await;
    if let Err(error) = cleaned {
        report_step_failed(CodexTeardownStep::BackgroundTerminalClean, error);
    }
}

fn report_step_failed(step: CodexTeardownStep, error: CodexError) {
    CodexTransportDiagnostic::TeardownStepFailed {
        step,
        error: Box::new(error),
    }
    .report();
}
