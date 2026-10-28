//! A shell's output on its way out: the task that takes each running shell's output and exit from
//! its terminal, so the terminal's read never waits on a chunk nobody took, and the output
//! subscriptions that stream it from the scrollback window.

use std::sync::{Arc, Weak};

use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::jsonrpc::streaming::SubscriptionId;
use sidekicks_contracts::terminal::TerminalOutputSubscribeRequest;
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_ipc::registry::{HandlerError, TransportId};
use sidekicks_terminal::{TerminalEvent, TerminalExit, TerminalOutput};

use crate::output::stream::{ShellOutputEnd, ShellOutputSource, ShellOutputStream};
use crate::record::ShellRecord;
use crate::table::end::{close_terminal, let_shell_go};
use crate::table::open::discard_unread_nonce;
use crate::table::{ShellTable, TableShared, log_failure};

#[expect(
    dead_code,
    reason = "the daemon's start builds the shell table and the terminal methods call it"
)]
impl ShellTable {
    /// The feed of a shell's output for `subscription_id` on `transport_id`: its scrollback, then
    /// its output, or only the output after the request's `afterOffset` while the window holds
    /// it. A shell that no longer runs is sent as its scrollback and how it ended. The
    /// subscription counts its connection as a watcher of the shell until it ends. Refuses a shell
    /// the session does not have `terminal.notFound`.
    pub(crate) fn subscribe_output(
        &self,
        request: &TerminalOutputSubscribeRequest,
        subscription_id: SubscriptionId,
        transport_id: TransportId,
    ) -> Result<ShellOutputStream, HandlerError> {
        let shell = self
            .shared
            .find_shell(&request.session_id, &request.terminal_id)?;
        let progress = shell.progress.subscribe();
        if shell.handle().is_some() {
            shell.add_stream(subscription_id, transport_id);
        }
        Ok(ShellOutputStream::new(
            shell as Arc<dyn ShellOutputSource>,
            subscription_id,
            transport_id,
            progress,
            request.after_offset.map(SafeInt::get),
        ))
    }
}

/// Takes a running shell's output until its exit: each chunk wakes its streams, and the first
/// prompt mark carrying its nonce lets its nonce file go. Ends with no exit once the shell's close
/// began, which its close finishes.
pub(super) async fn drain_output(
    table: Weak<TableShared>,
    record: Arc<ShellRecord>,
    mut output: TerminalOutput,
) {
    while let Some(event) = output.next().await {
        match event {
            TerminalEvent::Output(_) => {
                record.progress.send_modify(|_| {});
                if let Some(mark_nonce) = record.take_read_mark_nonce() {
                    discard_unread_nonce(&mark_nonce).await;
                }
            }
            TerminalEvent::Exit(exit) => {
                if let Some(table) = table.upgrade() {
                    table.take_exit(&record, exit).await;
                }
                return;
            }
        }
    }
}

impl TableShared {
    // An exited shell keeps its record: its streams send the exit after its last output, the holds
    // its panes carried are released as closed panes, its child leaves the orphan registry and the
    // terminal lets it go.
    async fn take_exit(&self, record: &Arc<ShellRecord>, exit: TerminalExit) {
        let exit_code = ExitCode::new(exit.exit_code)
            .unwrap_or_else(|| ExitCode::new(1).expect("one is an exit code"));
        let end = ShellOutputEnd::Exited {
            exit_code,
            cursor: record.output_offset(),
        };
        let (handle, mark_nonce, spawn_nonce) = self.record_shell_end(record, end, false);
        self.release_streams(record);
        self.refresh_list(&record.session_id);
        let closing = close_terminal(&self.deps.terminals, handle);
        if let Err(error) =
            let_shell_go(&self.deps.orphan_guard, closing, mark_nonce, spawn_nonce).await
        {
            log_failure(record, "could not let its exited terminal go", &error);
        }
    }

    /// Releases the hold bindings every open output subscription of the shell carried, as closed
    /// panes; a release that cannot be appended goes to the service log.
    pub(super) fn release_streams(&self, record: &Arc<ShellRecord>) {
        let subscriptions: Vec<SubscriptionId> = record
            .streams()
            .into_iter()
            .map(|(subscription_id, _)| subscription_id)
            .collect();
        if subscriptions.is_empty() {
            return;
        }
        let record = Arc::clone(record);
        self.deps.runtime.spawn(async move {
            if let Err(error) = record.lease.release_subscriptions(&subscriptions).await {
                log_failure(
                    &record,
                    "could not release the holds its panes carried",
                    &error,
                );
            }
        });
    }
}
