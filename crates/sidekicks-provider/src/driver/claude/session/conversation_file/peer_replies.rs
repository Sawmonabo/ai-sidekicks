//! What became of a message the daemon sent a terminal Claude Code session, one the person runs
//! rather than the daemon, read from the receiver's transcript: delivered as soon as the
//! transcript holds the message's record, and at the receiver's idle notice the answer of the turn
//! the message started, nothing more for one that joined a turn under way, or not delivered where
//! no record of it came. One watch per transcript follows its appends while a message is awaited
//! in it, or waits for it to appear in its project folder, for that folder to appear in the config
//! folder's `projects` folder, and for that to appear in the config folder; where none runs, the
//! transcript is read once at the notice.

mod fold;
mod project_key;
#[cfg(test)]
mod tests;

use std::collections::HashMap;
use std::error::Error;
use std::io::{self, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, Weak};

use sidekicks_platforms::{FileAppendWatch, FolderArrivalWatch};
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};
use tokio::sync::{mpsc, oneshot};

use self::fold::{AwaitedMessage, take_transcript_lines};
use self::project_key::claude_project_key;
use crate::driver::claude::live_sessions::ClaudeLiveSession;
use crate::driver::claude::session::conversation_file::find_claude_conversation_file;
use crate::driver::claude::session::conversation_file::lines::ConversationLines;
use crate::port::session_message_reading_publisher::{
    SessionMessageReading, SessionMessageReadingPublisher,
};

/// The size of each chunk a read of the transcript at a notice takes, so a long transcript is read
/// in bounded pieces.
const NOTICE_READ_LIMIT: usize = 64 * 1024;

/// The messages awaited in terminal sessions' transcripts, each until its receiver's idle notice.
pub(crate) struct ClaudePeerReplies {
    readings: Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>>,
    awaited: Mutex<AwaitedReplies>,
}

#[derive(Default)]
struct AwaitedReplies {
    transcripts: HashMap<TranscriptKey, AwaitedTranscript>,
    // Each awaited notice's transcript and message.
    notices: HashMap<String, (TranscriptKey, String)>,
}

// One transcript: the config folder it is kept under, and its session's id, which names it.
#[derive(Clone, PartialEq, Eq, Hash)]
struct TranscriptKey {
    config_folder: PathBuf,
    session_id: String,
}

// The messages awaited in one transcript with their ids, in the order they were awaited, and the
// way to ask its watch to drain, dropped with the last message, which ends the watch.
struct AwaitedTranscript {
    messages: Vec<(String, AwaitedMessage)>,
    drains: Option<mpsc::Sender<oneshot::Sender<()>>>,
}

/// One message's wait for its reply; dropping it stops awaiting the message, as its owner settled
/// the send another way or the idle notice's subscription lapsed, and ends the transcript's watch
/// with its last message.
pub(crate) struct ClaudePeerReplyWait {
    replies: Weak<ClaudePeerReplies>,
    notice_id: String,
}

// Where a watch starts: the transcript, or the project folder it is yet to appear in, inside the
// config folder's `projects` folder, either of which may be yet to appear too.
enum TranscriptSource {
    File(PathBuf),
    Folder {
        projects: PathBuf,
        folder: PathBuf,
        file: PathBuf,
    },
}

// How a wait for a folder or the transcript to appear ended: it came, with the drain asked as a
// look found it, or no message is awaited in the transcript any more.
enum Arrival {
    Arrived {
        drained: Option<oneshot::Sender<()>>,
    },
    Unawaited,
}

impl ClaudePeerReplies {
    /// Publishes what each transcript tells to `readings`, read at each reading; a reading made
    /// before a publisher is registered is dropped.
    pub(crate) fn new(
        readings: Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>>,
    ) -> Self {
        Self {
            readings,
            awaited: Mutex::default(),
        }
    }

    /// Awaits the reply to message `message_id`, which the daemon is about to send `receiver` and
    /// whose idle notice is `notice_id`, so call it before the message is written. Fails with
    /// `InvalidInput` where the receiver's registry file names no session id or sits in no config
    /// folder, and as the transcript cannot be searched for or measured.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the Claude driver's send to a terminal session awaits its reply"
        )
    )]
    pub(crate) async fn await_reply(
        self: &Arc<Self>,
        receiver: &ClaudeLiveSession,
        message_id: String,
        notice_id: String,
    ) -> io::Result<ClaudePeerReplyWait> {
        let session_id = receiver.session_id.clone().ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidInput,
                "the receiver's registry file names no session id",
            )
        })?;
        let config_folder = receiver
            .registry_file
            .parent()
            .and_then(Path::parent)
            .ok_or_else(|| {
                io::Error::new(
                    io::ErrorKind::InvalidInput,
                    "the receiver's registry file sits in no config folder",
                )
            })?
            .to_path_buf();
        let (start_offset, source) =
            if let Some(file) = find_claude_conversation_file(&config_folder, &session_id).await? {
                (
                    tokio::fs::metadata(&file).await?.len(),
                    Some(TranscriptSource::File(file)),
                )
            } else {
                let source = receiver.working_folder.as_deref().map(|working_folder| {
                    let projects = config_folder.join("projects");
                    let folder = projects.join(claude_project_key(working_folder));
                    TranscriptSource::Folder {
                        file: folder.join(format!("{session_id}.jsonl")),
                        folder,
                        projects,
                    }
                });
                (0, source)
            };
        let key = TranscriptKey {
            config_folder,
            session_id,
        };
        let mut awaited = lock(&self.awaited);
        let transcript =
            awaited
                .transcripts
                .entry(key.clone())
                .or_insert_with(|| AwaitedTranscript {
                    messages: Vec::new(),
                    drains: None,
                });
        transcript
            .messages
            .push((message_id.clone(), AwaitedMessage::new(start_offset)));
        if transcript
            .drains
            .as_ref()
            .is_none_or(mpsc::Sender::is_closed)
            && let Some(source) = source
        {
            // The new watch reads every message's lines again from the lowest start, the bytes
            // before it never read.
            let mut watch_start = start_offset;
            for (_, message) in &mut transcript.messages {
                message.reread();
                watch_start = watch_start.min(message.start_offset);
            }
            let (drains, drain_requests) = mpsc::channel(1);
            tokio::spawn(watch_transcript(
                Arc::downgrade(self),
                key.clone(),
                source,
                watch_start,
                drain_requests,
            ));
            transcript.drains = Some(drains);
        }
        awaited.notices.insert(notice_id.clone(), (key, message_id));
        Ok(ClaudePeerReplyWait {
            replies: Arc::downgrade(self),
            notice_id,
        })
    }

    /// Settles the wait the idle notice of message `orig_msg_id` ends, whichever state the notice
    /// gives: the transcript is read to its end, the turn's answer or `NotDelivered` published,
    /// and the message no longer awaited. `false` where no wait awaits the notice.
    pub(crate) async fn take_idle_notice(&self, orig_msg_id: &str) -> bool {
        let found = {
            let awaited = lock(&self.awaited);
            awaited.notices.get(orig_msg_id).map(|(key, message_id)| {
                let drains = awaited
                    .transcripts
                    .get(key)
                    .and_then(|transcript| transcript.drains.clone());
                (key.clone(), message_id.clone(), drains)
            })
        };
        let Some((key, message_id, drains)) = found else {
            return false;
        };
        if !drain_watch(drains).await {
            self.read_once(&key, &message_id).await;
        }
        let settled = {
            let mut awaited = lock(&self.awaited);
            awaited.notices.remove(orig_msg_id);
            remove_message(&mut awaited, &key, &message_id)
        };
        self.publish(settled.and_then(|message| message.settle(message_id)));
        true
    }

    // Reads the transcript once from the message's start offset into the message, for a message
    // no watch follows; a failed read is logged, and what it read before failing stands.
    async fn read_once(&self, key: &TranscriptKey, message_id: &str) {
        let start_offset = self.with_message(key, message_id, |message| {
            message.reread();
            message.start_offset
        });
        let Some(start_offset) = start_offset else {
            return;
        };
        if let Err(error) = self.read_transcript(key, message_id, start_offset).await {
            tracing::warn!(
                error = &error as &(dyn Error + 'static),
                "a terminal session's transcript could not be read at its idle notice",
            );
        }
    }

    // Folds the transcript from `start_offset` into the message, chunk by chunk; a transcript not
    // there reads as empty.
    async fn read_transcript(
        &self,
        key: &TranscriptKey,
        message_id: &str,
        start_offset: u64,
    ) -> io::Result<()> {
        let Some(file) = find_claude_conversation_file(&key.config_folder, &key.session_id).await?
        else {
            return Ok(());
        };
        let mut reader = tokio::fs::File::open(&file).await?;
        reader.seek(SeekFrom::Start(start_offset)).await?;
        let mut lines = ConversationLines::new(&file, start_offset);
        let mut buffer = vec![0_u8; NOTICE_READ_LIMIT];
        loop {
            let count = reader.read(&mut buffer).await?;
            if count == 0 {
                return Ok(());
            }
            let read = take_transcript_lines(&mut lines, &buffer[..count], start_offset);
            let delivered = self.with_message(key, message_id, |message| {
                read.iter()
                    .filter_map(|line| message.fold(message_id, line))
                    .collect::<Vec<_>>()
            });
            self.publish(delivered.into_iter().flatten());
        }
    }

    // Runs `visit` on the awaited message, `None` where it is no longer awaited.
    fn with_message<T>(
        &self,
        key: &TranscriptKey,
        message_id: &str,
        visit: impl FnOnce(&mut AwaitedMessage) -> T,
    ) -> Option<T> {
        lock(&self.awaited)
            .transcripts
            .get_mut(key)
            .and_then(|transcript| {
                transcript
                    .messages
                    .iter_mut()
                    .find(|(awaited_id, _)| awaited_id == message_id)
            })
            .map(|(_, message)| visit(message))
    }

    // The lowest start offset of the messages awaited in the transcript, past every byte where
    // none is.
    fn lowest_start(&self, key: &TranscriptKey) -> u64 {
        lock(&self.awaited)
            .transcripts
            .get(key)
            .and_then(|transcript| {
                transcript
                    .messages
                    .iter()
                    .map(|(_, message)| message.start_offset)
                    .min()
            })
            .unwrap_or(u64::MAX)
    }

    // Publishes each reading, read from the registration at the call.
    fn publish(&self, readings: impl IntoIterator<Item = SessionMessageReading>) {
        if let Some(publisher) = self.readings.port() {
            for reading in readings {
                publisher.publish(reading);
            }
        }
    }

    // Stops awaiting the notice's message.
    fn forget(&self, notice_id: &str) {
        let mut awaited = lock(&self.awaited);
        if let Some((key, message_id)) = awaited.notices.remove(notice_id) {
            remove_message(&mut awaited, &key, &message_id);
        }
    }
}

impl Drop for ClaudePeerReplyWait {
    fn drop(&mut self) {
        if let Some(replies) = self.replies.upgrade() {
            replies.forget(&self.notice_id);
        }
    }
}

// Removes the message from its transcript, and the transcript, its watch's drains with it, once
// no message is awaited in it.
fn remove_message(
    awaited: &mut AwaitedReplies,
    key: &TranscriptKey,
    message_id: &str,
) -> Option<AwaitedMessage> {
    let transcript = awaited.transcripts.get_mut(key)?;
    let position = transcript
        .messages
        .iter()
        .position(|(awaited_id, _)| awaited_id == message_id);
    let message = position.map(|position| transcript.messages.remove(position).1);
    if transcript.messages.is_empty() {
        awaited.transcripts.remove(key);
    }
    message
}

// Asks the transcript's watch to fold everything appended so far; `false` where no watch runs or
// it ended before answering.
async fn drain_watch(drains: Option<mpsc::Sender<oneshot::Sender<()>>>) -> bool {
    let Some(drains) = drains else {
        return false;
    };
    let (drained, answer) = oneshot::channel();
    drains.send(drained).await.is_ok() && answer.await.is_ok()
}

// Follows one transcript from byte `start` while a message is awaited in it. A missing config
// folder and a platform with no watch end it quietly, any other failure is logged; its messages
// are then read once at their notices.
async fn watch_transcript(
    replies: Weak<ClaudePeerReplies>,
    key: TranscriptKey,
    source: TranscriptSource,
    start: u64,
    mut drain_requests: mpsc::Receiver<oneshot::Sender<()>>,
) {
    if let Err(error) = follow_transcript(&replies, &key, source, start, &mut drain_requests).await
        && !matches!(
            error.kind(),
            io::ErrorKind::NotFound | io::ErrorKind::Unsupported
        )
    {
        tracing::warn!(
            session_id = %key.session_id,
            error = &error as &(dyn Error + 'static),
            "a terminal session's transcript watch failed, so its messages are read at their \
             notices",
        );
    }
}

// Folds each chunk appended to the transcript from byte `start`, waiting for it to appear first
// where it is not there yet, and at each drain asked folds everything appended so far before
// answering. Ends once no message is awaited in it; fails as the folder or the file cannot be
// watched or read.
async fn follow_transcript(
    replies: &Weak<ClaudePeerReplies>,
    key: &TranscriptKey,
    source: TranscriptSource,
    start: u64,
    drain_requests: &mut mpsc::Receiver<oneshot::Sender<()>>,
) -> io::Result<()> {
    let (file, mut pending) = match source {
        TranscriptSource::File(file) => (file, None),
        TranscriptSource::Folder {
            projects,
            folder,
            file,
        } => match await_transcript(
            [&key.config_folder, &projects, &folder, &file],
            drain_requests,
        )
        .await?
        {
            Arrival::Arrived { drained } => (file, drained),
            Arrival::Unawaited => return Ok(()),
        },
    };
    let mut watch = FileAppendWatch::watch_from(&file, start).await?;
    let mut lines = ConversationLines::new(&file, start);
    loop {
        let drained = if let Some(drained) = pending.take() {
            drained
        } else {
            tokio::select! {
                request = drain_requests.recv() => match request {
                    Some(drained) => drained,
                    None => return Ok(()),
                },
                appended = watch.next_appended() => {
                    if !fold_chunk(replies, key, &mut lines, &appended?) {
                        return Ok(());
                    }
                    continue;
                }
            }
        };
        loop {
            let chunk = watch.drain().await?;
            if chunk.is_empty() {
                break;
            }
            if !fold_chunk(replies, key, &mut lines, &chunk) {
                return Ok(());
            }
        }
        // A notice that stopped waiting needs no answer.
        let _unheard = drained.send(());
    }
}

// Waits for the transcript to appear, `path` naming the config folder, its `projects` folder, the
// project folder and the transcript, each inside the one before: each missing entry is awaited in
// its parent, the outermost first. Fails as a folder cannot be watched or listed.
async fn await_transcript(
    path: [&Path; 4],
    drain_requests: &mut mpsc::Receiver<oneshot::Sender<()>>,
) -> io::Result<Arrival> {
    let mut drained = None;
    for [watched, wanted] in path.array_windows() {
        if tokio::fs::try_exists(wanted).await? {
            continue;
        }
        match await_arrival(watched, wanted, drained.take(), drain_requests).await? {
            Arrival::Arrived {
                drained: arrival_drained,
            } => drained = arrival_drained,
            Arrival::Unawaited => return Ok(Arrival::Unawaited),
        }
    }
    Ok(Arrival::Arrived { drained })
}

// Waits for `wanted` to appear in the folder `watched`, `drained` handed on where it is already
// there. It is looked for once the watch is set, as it may have come since the last look, and at
// each drain asked, since on Linux an entry created in place rather than renamed in wakes no folder
// watch. A drain asked while it is still missing is dropped unanswered, so the notice searches
// every project folder for the transcript, as it may sit in another. Fails as the folder cannot be
// watched or listed.
async fn await_arrival(
    watched: &Path,
    wanted: &Path,
    drained: Option<oneshot::Sender<()>>,
    drain_requests: &mut mpsc::Receiver<oneshot::Sender<()>>,
) -> io::Result<Arrival> {
    let mut arrivals = FolderArrivalWatch::watch(watched).await?;
    if tokio::fs::try_exists(wanted).await? {
        return Ok(Arrival::Arrived { drained });
    }
    drop(drained);
    loop {
        tokio::select! {
            request = drain_requests.recv() => {
                let Some(drained) = request else {
                    return Ok(Arrival::Unawaited);
                };
                if tokio::fs::try_exists(wanted).await? {
                    return Ok(Arrival::Arrived { drained: Some(drained) });
                }
                drop(drained);
            }
            arrived = arrivals.next_arrivals() => {
                if arrived?.iter().any(|arrival| arrival == wanted) {
                    return Ok(Arrival::Arrived { drained: None });
                }
            }
        }
    }
}

// Folds the lines `chunk` completes into each message awaited in the transcript and publishes the
// `Delivered` they show; `false` once the replies are gone.
fn fold_chunk(
    replies: &Weak<ClaudePeerReplies>,
    key: &TranscriptKey,
    lines: &mut ConversationLines,
    chunk: &[u8],
) -> bool {
    let Some(replies) = replies.upgrade() else {
        return false;
    };
    let read = take_transcript_lines(lines, chunk, replies.lowest_start(key));
    if read.is_empty() {
        return true;
    }
    let delivered: Vec<SessionMessageReading> = {
        let mut awaited = lock(&replies.awaited);
        let Some(transcript) = awaited.transcripts.get_mut(key) else {
            return true;
        };
        let mut delivered = Vec::new();
        for line in &read {
            for (message_id, message) in &mut transcript.messages {
                delivered.extend(message.fold(message_id, line));
            }
        }
        delivered
    };
    replies.publish(delivered);
    true
}
