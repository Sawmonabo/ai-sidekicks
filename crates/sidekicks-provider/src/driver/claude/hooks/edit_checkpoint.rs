//! The copy of the file a Claude Code file-changing call names, kept before its pre-tool hook is
//! answered.

use std::error::Error;
use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::tool_call::ToolCallId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::{PathRules, resolve_path_against};

use crate::driver::claude::delivery::file_tool_writes::ClaudeFileTool;
use crate::driver::claude::hooks::callbacks::answer_claude_request;
use crate::driver::claude::hooks::pause::ClaudeHookAnswer;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::port::edit_checkpoint::{EditCheckpoint, EditCheckpointRequest};
use crate::record_readers::filter_non_empty;

/// The edit a pre-tool hook's call of `tool_name` makes, by the call `tool_use_id`: `None` for a
/// tool that changes no file. The file is a notebook's own `notebook_path`, any other tool's
/// `file_path`; a relative one is joined onto the hook's `cwd`. A call whose file cannot be named
/// absolutely is logged and gets `None`, since that edit runs with no copy.
pub(super) fn read_claude_edit(
    session_id: &SessionId,
    tool_name: &str,
    file_path: Option<&str>,
    notebook_path: Option<&str>,
    cwd: Option<&str>,
    tool_use_id: Option<&str>,
) -> Option<EditCheckpointRequest> {
    let Some(path) = ClaudeFileTool::of(tool_name)?.select_path(file_path, notebook_path) else {
        tracing::warn!(
            %session_id,
            tool_name,
            tool_use_id,
            "a file-changing call names no file, so its edit runs with no copy"
        );
        return None;
    };
    let path = if PathRules::NATIVE.is_absolute(path) {
        path.to_owned()
    } else {
        let Some(cwd) = filter_non_empty(cwd) else {
            tracing::warn!(
                %session_id,
                tool_name,
                tool_use_id,
                "a file-changing call names a relative file and its hook no folder, so its edit \
                 runs with no copy"
            );
            return None;
        };
        match resolve_path_against(cwd, path) {
            Ok(path) => path,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    tool_name,
                    tool_use_id,
                    error = &error as &(dyn Error + 'static),
                    "a file-changing call's relative file could not be joined onto its hook's \
                     folder, so its edit runs with no copy"
                );
                return None;
            }
        }
    };
    Some(EditCheckpointRequest {
        session_id: *session_id,
        path: PathBuf::from(path),
        tool_call_id: tool_use_id.and_then(|id| ToolCallId::new(id.to_owned()).ok()),
    })
}

/// Keeps `edit`'s copy through `edit_checkpoint` where one is registered, then answers the hook
/// `request_id` through `channel` with no decision, so the call runs only once its file is kept.
/// The copy never fails; an answer that cannot be written stops the process, as every answer's.
pub(crate) async fn keep_copy_then_answer(
    edit_checkpoint: Option<&Arc<dyn EditCheckpoint>>,
    channel: &dyn ClaudeProcessChannel,
    provider_account_id: &ProviderAccountId,
    request_id: String,
    edit: EditCheckpointRequest,
) {
    let session_id = edit.session_id;
    if let Some(edit_checkpoint) = edit_checkpoint {
        edit_checkpoint.keep_before_edit(edit).await;
    }
    answer_claude_request(
        channel,
        &session_id,
        provider_account_id,
        request_id,
        &ClaudeHookAnswer::Pass,
    )
    .await;
}

#[cfg(test)]
pub(crate) mod tests {
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex};

    use futures::FutureExt;
    use futures::future::BoxFuture;
    use serde_json::json;
    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::provider::tool_call::ToolCallId;
    use sidekicks_std::mutex_lock::lock;
    use tokio::sync::{Notify, oneshot};

    use super::keep_copy_then_answer;
    use crate::driver::claude::session::scripted::channel::{ScriptedChannel, ScriptedWrite};
    use crate::driver::test_registry::fixed_session_id;
    use crate::port::edit_checkpoint::{EditCheckpoint, EditCheckpointRequest};

    /// A copy service that records each request and holds its answer until its gate opens.
    pub(crate) struct GatedEditCheckpoint {
        requests: Mutex<Vec<EditCheckpointRequest>>,
        gate: Mutex<Option<oneshot::Receiver<()>>>,
        // Wakes a wait for a request on each one recorded.
        recorded: Notify,
    }

    impl GatedEditCheckpoint {
        /// The service, and the gate that lets its copies answer when it fires or drops.
        pub(crate) fn gated() -> (Arc<Self>, oneshot::Sender<()>) {
            let (open, gate) = oneshot::channel();
            let service = Arc::new(Self {
                requests: Mutex::default(),
                gate: Mutex::new(Some(gate)),
                recorded: Notify::new(),
            });
            (service, open)
        }

        /// The requests recorded so far, in order.
        pub(crate) fn requests(&self) -> Vec<EditCheckpointRequest> {
            lock(&self.requests).clone()
        }

        /// Waits until `count` requests are recorded.
        pub(crate) async fn wait_for_requests(&self, count: usize) {
            loop {
                let recorded = self.recorded.notified();
                if lock(&self.requests).len() >= count {
                    return;
                }
                recorded.await;
            }
        }
    }

    impl EditCheckpoint for GatedEditCheckpoint {
        fn keep_before_edit(&self, request: EditCheckpointRequest) -> BoxFuture<'_, ()> {
            lock(&self.requests).push(request);
            self.recorded.notify_waiters();
            let gate = lock(&self.gate).take();
            async move {
                if let Some(gate) = gate {
                    // A dropped sender opens the gate too.
                    gate.await.unwrap_or(());
                }
            }
            .boxed()
        }
    }

    /// Whether `channel` holds an answer to `request_id`.
    pub(crate) fn is_answered(channel: &ScriptedChannel, request_id: &str) -> bool {
        channel.writes().iter().any(|write| {
            matches!(write, ScriptedWrite::Answer { request_id: answered, .. } if answered == request_id)
        })
    }

    // Killed by the answer written before the copy is awaited, and by the path or the tool call
    // altered on the way.
    #[tokio::test]
    async fn an_edit_is_answered_only_after_its_copy() {
        let (edit_checkpoint, open) = GatedEditCheckpoint::gated();
        let channel = Arc::new(ScriptedChannel::default());
        let edit = EditCheckpointRequest {
            session_id: fixed_session_id(),
            path: PathBuf::from("/work/src/main.rs"),
            tool_call_id: Some(ToolCallId::new("toolu_1".to_owned()).expect("a call id")),
        };
        let port: Arc<dyn EditCheckpoint> = Arc::clone(&edit_checkpoint) as _;
        let answering = tokio::spawn({
            let channel = Arc::clone(&channel);
            let edit = edit.clone();
            async move {
                keep_copy_then_answer(
                    Some(&port),
                    &*channel,
                    &ProviderAccountId::new("account-1".to_owned()).expect("an account id"),
                    "r1".to_owned(),
                    edit,
                )
                .await;
            }
        });

        edit_checkpoint.wait_for_requests(1).await;
        assert!(!is_answered(&channel, "r1"));

        open.send(()).expect("the copy waits on its gate");
        answering.await.expect("the answer's task ends");
        assert_eq!(channel.answer_to("r1").await, json!({}));
        assert_eq!(edit_checkpoint.requests(), [edit]);
    }
}
