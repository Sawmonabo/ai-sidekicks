//! What a conversation's channel records do to its session's running set: a wrapper's start pairs
//! it with its row and is answered `go` at once, the file its command's standard output writes to
//! is tailed as that row's output, its terminal's readings feed the row's waiting checks, its exit
//! settles the row's exit code, and an askpass's prompt opens on the row of the wrapper above it,
//! answered empty at once where no wrapper is.

use std::collections::HashMap;
use std::io::{self, ErrorKind};
use std::path::PathBuf;
use std::sync::Arc;

use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::text::NonEmptyText;
use sidekicks_platforms::{FileAppendWatch, InputTerminal};
use tokio::sync::watch;
use tokio::task::JoinHandle;

use crate::askpass_prompt::is_masked_prompt;
use crate::provider::command::channel::{
    CommandChannel, DaemonRequest, PartyId, PartyRecord, ReceivedRecord,
};
use crate::provider::command::running_set::{RunningCommandSets, WrapperCommand};
use crate::provider::command::waiting_checks::{InputWaitReader, WaitingChecks};
use crate::utf8_stream::Utf8StreamDecoder;

/// What the daemon holds of one wrapper while its command runs.
struct FollowedWrapper {
    /// Set once the command exited, which ends the output's tail after its last bytes.
    exited: watch::Sender<bool>,
    tail: Option<JoinHandle<()>>,
    checks: Option<WaitingChecks>,
    last_output_tail: String,
}

/// Follows `channel`'s records into `session_id`'s rows in `set`, the waiting checks reading
/// through `waits`, until the channel's watch fails, with its error.
#[expect(dead_code, reason = "each driver follows its conversations' channels")]
pub(crate) async fn follow_channel_records(
    session_id: SessionId,
    channel: Arc<CommandChannel>,
    set: Arc<RunningCommandSets>,
    waits: Arc<dyn InputWaitReader>,
) -> io::Result<()> {
    let mut watch = channel.watch().await?;
    let mut wrappers: HashMap<PartyId, FollowedWrapper> = HashMap::new();
    loop {
        for received in channel.next_records(&mut watch).await? {
            take_record(session_id, &channel, &set, &waits, &mut wrappers, received).await;
        }
    }
}

// Applies one record to the set.
async fn take_record(
    session_id: SessionId,
    channel: &Arc<CommandChannel>,
    set: &Arc<RunningCommandSets>,
    waits: &Arc<dyn InputWaitReader>,
    wrappers: &mut HashMap<PartyId, FollowedWrapper>,
    received: ReceivedRecord,
) {
    let party = received.party;
    match received.record {
        PartyRecord::Starting {
            command,
            stdout_path,
            process,
        } => {
            let command = process.map_or(WrapperCommand::Line(command), WrapperCommand::Process);
            set.wrapper_started(session_id, party, command);
            send_request(channel, party, &DaemonRequest::Go {}).await;
            let (exited, ended) = watch::channel(false);
            let tail = stdout_path.map(|path| {
                tokio::spawn(tail_output(path, Arc::clone(set), session_id, party, ended))
            });
            wrappers.insert(
                party,
                FollowedWrapper {
                    exited,
                    tail,
                    checks: None,
                    last_output_tail: String::new(),
                },
            );
        }
        PartyRecord::Terminal {
            device,
            master,
            output_tail,
        } => {
            let Some(wrapper) = wrappers.get_mut(&party) else {
                return;
            };
            let checks = wrapper.checks.get_or_insert_with(|| {
                let set = Arc::clone(set);
                WaitingChecks::start(Arc::clone(waits), move |state| {
                    set.waiting_read(session_id, party, state);
                })
            });
            if output_tail != wrapper.last_output_tail {
                checks.output_printed();
                wrapper.last_output_tail.clone_from(&output_tail);
            }
            checks.terminal_read(InputTerminal { device, master }, output_tail);
        }
        PartyRecord::Exited { exit_code, .. } => {
            let exit_code = exit_code.and_then(|code| SafeSignedInt::new(i64::from(code)));
            set.wrapper_exited(session_id, party, exit_code);
            if let Some(wrapper) = wrappers.remove(&party) {
                wrapper.exited.send_replace(true);
                if let Some(tail) = wrapper.tail
                    && let Err(error) = tail.await
                {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a command's output tail ended abnormally"
                    );
                }
            }
            set.wrapper_ended(session_id, party);
            channel.forget_party(party);
        }
        PartyRecord::Warning { message } => {
            tracing::warn!(
                party,
                message,
                "a command's party could not do what it meant to"
            );
        }
        PartyRecord::Stopped {} => {
            tracing::debug!(
                party,
                "a command wrapper ended its command's terminal session"
            );
        }
        PartyRecord::Asking {} => {
            let prompt = received.first_argument.and_then(NonEmptyText::new);
            let Some((wrapper, prompt)) = received.wrapper.zip(prompt) else {
                let text = String::new();
                send_request(channel, party, &DaemonRequest::Answer { text }).await;
                channel.forget_party(party);
                return;
            };
            let is_masked = is_masked_prompt(prompt.as_str());
            let channel = Arc::clone(channel);
            set.prompt_opened(
                session_id,
                wrapper,
                prompt,
                is_masked,
                Box::new(move |text| {
                    tokio::spawn(async move {
                        send_request(&channel, party, &DaemonRequest::Answer { text }).await;
                        channel.forget_party(party);
                    });
                }),
            );
        }
    }
}

// Sends `request` to `party`, logging a failure: the party then waits out its own timeout.
async fn send_request(channel: &CommandChannel, party: PartyId, request: &DaemonRequest) {
    if let Err(error) = channel.send_request(party, request).await {
        tracing::warn!(
            error = &error as &(dyn std::error::Error + 'static),
            "a command channel's request could not be written"
        );
    }
}

// Tails the file at `path` as the wrapper `party`'s output until its command exited and its last
// bytes are read; a file shorter than what was read, after the end, is the end of the output.
async fn tail_output(
    path: PathBuf,
    set: Arc<RunningCommandSets>,
    session_id: SessionId,
    party: PartyId,
    mut ended: watch::Receiver<bool>,
) {
    let mut decoder = Utf8StreamDecoder::default();
    let publish = |bytes: &[u8], decoder: &mut Utf8StreamDecoder| {
        decoder.push(bytes, |text| {
            set.wrapper_output(session_id, party, text);
        });
    };
    let mut file = match FileAppendWatch::watch(&path).await {
        Ok(file) => file,
        Err(error) => {
            tracing::warn!(
                error = &error as &(dyn std::error::Error + 'static),
                "a command's output file could not be watched"
            );
            return;
        }
    };
    loop {
        tokio::select! {
            biased;
            has_exited = async { ended.wait_for(|has_exited| *has_exited).await.is_ok() } => {
                if has_exited {
                    drain(&mut file, &mut decoder, &publish).await;
                }
                break;
            }
            appended = file.next_appended() => match appended {
                Ok(bytes) => publish(&bytes, &mut decoder),
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn std::error::Error + 'static),
                        "a command's output file could not be read"
                    );
                    break;
                }
            },
        }
    }
    decoder.finish(|text| set.wrapper_output(session_id, party, text));
}

// Reads the bytes left in `file` once its writer ended.
async fn drain(
    file: &mut FileAppendWatch,
    decoder: &mut Utf8StreamDecoder,
    publish: &impl Fn(&[u8], &mut Utf8StreamDecoder),
) {
    loop {
        match file.drain().await {
            Ok(bytes) if bytes.is_empty() => return,
            Ok(bytes) => publish(&bytes, decoder),
            Err(error) if error.kind() == ErrorKind::InvalidData => return,
            Err(error) => {
                tracing::warn!(
                    error = &error as &(dyn std::error::Error + 'static),
                    "a command's last output could not be read"
                );
                return;
            }
        }
    }
}
