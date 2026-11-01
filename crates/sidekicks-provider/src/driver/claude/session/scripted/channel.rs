//! A scripted Claude Code process: it records everything the driver writes to it and answers each
//! control request as scripted.

use std::collections::{HashMap, VecDeque};
use std::io;
use std::sync::{Arc, Mutex};

use futures::FutureExt;
use futures::future::BoxFuture;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::command::ExitCode;
use sidekicks_contracts::run::control::{ProcessExit, ProcessExitWithCode};
use sidekicks_contracts::wire::text::FreeFormText;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, oneshot};

use crate::driver::claude::session::errors::{ClaudeSessionError, ClaudeUnansweredCause};
use crate::driver::claude::session::process::ClaudeProcessListener;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::control::ClaudeControlRequest;
use crate::driver::claude::session::transport::inbound::ClaudeControlAnswer;
use crate::driver::claude::session::transport::user_message::{
    ClaudeUserFrame, ClaudeWriteAttempt, ClaudeWriteDelivery,
};

/// One thing the driver wrote to the scripted process, in the order written.
#[derive(Clone, Debug, PartialEq)]
pub(crate) enum ScriptedWrite {
    /// A control request, as it serializes on the wire.
    Control(Value),
    /// An answer to a request the process sent.
    Answer {
        /// The request answered.
        request_id: String,
        /// The answer's payload.
        answer: Value,
    },
    /// A user message line, as it serializes on the wire.
    User(Value),
    /// The process was stopped.
    Terminate,
}

impl ScriptedWrite {
    /// The user message's uuid, if this is one.
    pub(crate) fn user_uuid(&self) -> Option<&str> {
        match self {
            Self::User(frame) => frame.get("uuid").and_then(Value::as_str),
            Self::Control(_) | Self::Answer { .. } | Self::Terminate => None,
        }
    }
}

/// How the scripted process answers one control request.
pub(crate) enum ScriptedAnswer {
    /// An answer carrying this response.
    Reply(Value),
    /// Claude Code's refusal.
    Refused,
    /// No answer before the request's deadline.
    Deadline,
    /// The request's write cut after some bytes.
    WriteCut,
}

/// A Claude Code process that records what the driver writes and answers as scripted: a control
/// request with no scripted answer is answered with an empty response, a user line is written
/// unless a hold or a failure was scripted for it, and a close ends the process, whose exit its
/// listener takes as a real reader hands it over.
#[derive(Default)]
pub(crate) struct ScriptedChannel {
    writes: Mutex<Vec<ScriptedWrite>>,
    answers: Mutex<HashMap<String, VecDeque<ScriptedAnswer>>>,
    user_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    user_failures: Mutex<VecDeque<ClaudeWriteDelivery>>,
    close_holds: Mutex<VecDeque<oneshot::Receiver<()>>>,
    listener: Mutex<Option<Arc<dyn ClaudeProcessListener>>>,
    // Wakes a wait for a write on each one recorded.
    written: Notify,
}

impl ScriptedChannel {
    /// Scripts the next answer to a control request of `subtype`.
    pub(crate) fn answer(&self, subtype: &str, answer: ScriptedAnswer) {
        lock(&self.answers)
            .entry(subtype.to_owned())
            .or_default()
            .push_back(answer);
    }

    /// Holds the next user line's write until the returned sender fires or drops; the line is
    /// recorded as its write starts.
    pub(crate) fn hold_next_user_write(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        lock(&self.user_holds).push_back(held);
        release
    }

    /// Holds the next close until the returned sender fires or drops; the stop is recorded as the
    /// close starts.
    pub(crate) fn hold_next_close(&self) -> oneshot::Sender<()> {
        let (release, held) = oneshot::channel();
        lock(&self.close_holds).push_back(held);
        release
    }

    /// Hands the exit of a later close or terminate to `listener`, the listener of the start that
    /// brought the process up; the process exits once.
    pub(super) fn hand_exit_to(&self, listener: Arc<dyn ClaudeProcessListener>) {
        *lock(&self.listener) = Some(listener);
    }

    /// Fails the next user line's write as `delivery`.
    pub(crate) fn fail_next_user_write(&self, delivery: ClaudeWriteDelivery) {
        lock(&self.user_failures).push_back(delivery);
    }

    /// The answer the driver wrote to the request `request_id` the process sent, waiting until it
    /// is written.
    pub(crate) async fn answer_to(&self, request_id: &str) -> Value {
        loop {
            let written = self.written.notified();
            let answer = self.writes().into_iter().find_map(|write| match write {
                ScriptedWrite::Answer {
                    request_id: answered,
                    answer,
                } if answered == request_id => Some(answer),
                ScriptedWrite::Answer { .. }
                | ScriptedWrite::Control(_)
                | ScriptedWrite::User(_)
                | ScriptedWrite::Terminate => None,
            });
            if let Some(answer) = answer {
                return answer;
            }
            written.await;
        }
    }

    /// Everything written so far, in order.
    pub(crate) fn writes(&self) -> Vec<ScriptedWrite> {
        lock(&self.writes).clone()
    }

    /// The control requests written so far, in order.
    pub(crate) fn control_requests(&self) -> Vec<Value> {
        self.writes()
            .into_iter()
            .filter_map(|write| match write {
                ScriptedWrite::Control(request) => Some(request),
                ScriptedWrite::Answer { .. }
                | ScriptedWrite::User(_)
                | ScriptedWrite::Terminate => None,
            })
            .collect()
    }

    /// The user lines written so far, in order.
    pub(crate) fn user_frames(&self) -> Vec<Value> {
        self.writes()
            .into_iter()
            .filter_map(|write| match write {
                ScriptedWrite::User(frame) => Some(frame),
                ScriptedWrite::Control(_)
                | ScriptedWrite::Answer { .. }
                | ScriptedWrite::Terminate => None,
            })
            .collect()
    }

    fn record(&self, write: ScriptedWrite) {
        lock(&self.writes).push(write);
        self.written.notify_waiters();
    }
}

impl ClaudeProcessChannel for ScriptedChannel {
    fn send_control_request(
        &self,
        request: ClaudeControlRequest,
    ) -> BoxFuture<'_, Result<ClaudeControlAnswer, ClaudeSessionError>> {
        let wire = serde_json::to_value(&request).expect("a control request serializes");
        let subtype = wire
            .get("subtype")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        self.record(ScriptedWrite::Control(wire));
        let answer = lock(&self.answers)
            .get_mut(&subtype)
            .and_then(VecDeque::pop_front);
        let control_subtype = request.subtype();
        async move {
            match answer {
                None => Ok(ClaudeControlAnswer::default()),
                Some(ScriptedAnswer::Reply(response)) => Ok(ClaudeControlAnswer {
                    response: Some(
                        serde_json::value::to_raw_value(&response)
                            .expect("a scripted response serializes"),
                    ),
                    pending_user_dialog_requests: None,
                }),
                Some(ScriptedAnswer::Refused) => Err(ClaudeSessionError::ControlRequestRefused {
                    subtype: control_subtype,
                    provider_error: "refused".to_owned(),
                }),
                Some(ScriptedAnswer::Deadline) => Err(ClaudeSessionError::Unanswered {
                    subtype: control_subtype,
                    cause: ClaudeUnansweredCause::Deadline,
                }),
                Some(ScriptedAnswer::WriteCut) => Err(ClaudeSessionError::Unanswered {
                    subtype: control_subtype,
                    cause: ClaudeUnansweredCause::WriteCut,
                }),
            }
        }
        .boxed()
    }

    fn answer_inbound_request(
        &self,
        request_id: String,
        answer: Box<RawValue>,
    ) -> BoxFuture<'_, ClaudeWriteAttempt> {
        let answer = serde_json::from_str(answer.get()).expect("an answer is JSON");
        self.record(ScriptedWrite::Answer { request_id, answer });
        async { ClaudeWriteAttempt::Written }.boxed()
    }

    fn write_user_frame(&self, frame: ClaudeUserFrame) -> BoxFuture<'_, ClaudeWriteAttempt> {
        self.record(ScriptedWrite::User(
            serde_json::to_value(&frame).expect("a user frame serializes"),
        ));
        let hold = lock(&self.user_holds).pop_front();
        let failure = lock(&self.user_failures).pop_front();
        async move {
            if let Some(hold) = hold {
                // A dropped sender releases the write too.
                hold.await.unwrap_or(());
            }
            match failure {
                None => ClaudeWriteAttempt::Written,
                Some(delivery) => ClaudeWriteAttempt::Failed {
                    delivery,
                    cause: io::Error::from(io::ErrorKind::BrokenPipe),
                },
            }
        }
        .boxed()
    }

    fn terminate(&self) -> BoxFuture<'_, ()> {
        self.record(ScriptedWrite::Terminate);
        self.exit("terminated");
        async {}.boxed()
    }

    fn close(&self) -> BoxFuture<'_, ()> {
        self.record(ScriptedWrite::Terminate);
        let hold = lock(&self.close_holds).pop_front();
        async move {
            if let Some(hold) = hold {
                drop(hold.await);
            }
            self.exit("closed");
        }
        .boxed()
    }
}

impl ScriptedChannel {
    // Hands the process's code-0 exit, with `output_tail`, to the start's listener, as a real
    // reader does after its last frame; a process already exited hands nothing.
    fn exit(&self, output_tail: &str) {
        let listener = lock(&self.listener).take();
        if let Some(listener) = listener {
            listener.take_exit(Ok(ProcessExit::Code(ProcessExitWithCode {
                exit_code: ExitCode::new(0).expect("zero is a safe integer"),
                signal: None,
                silent_seconds: None,
                output_tail: FreeFormText::new(output_tail.to_owned()).expect("the tail fits"),
            })));
        }
    }
}
