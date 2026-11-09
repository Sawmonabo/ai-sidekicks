//! The cadence a task is polled at: one `tasks/get` at a time, 2 s apart unless the server suggests
//! its own interval, which is held between 250 ms and 30 s. A status notification only wakes the
//! next poll early, never sooner than 250 ms after the last one, so a server flooding
//! notifications cannot drive polls back to back; the poll alone decides the task's state.
//!
//! Each failed poll is read for what it says:
//!
//! - A closed connection ends the follow at once, the task perhaps still running on the server.
//! - A `-32601` or a `-32021` ends it at once, the task's end unknown.
//! - A `-32602` rejects the task's id: the task is polled on through a grace of 300 s on the
//!   answered clock from the first one, then its end reads unknown. A poll that reads the task
//!   clears the grace.
//! - A refused sign-in, an error answer or no answer is polled again at the same cadence, the task
//!   left alone and the contact saying which.
//!
//! The first failed poll since one succeeded is logged at warn and the rest at debug, so an outage
//! grows the log once.
//!
//! The answered clock adds the time between two answered polls with no failed poll between them,
//! a `-32602` counting as answered, so an outage never counts toward the grace. Lost's clock is
//! wall time since the last poll that read the task or answered `-32602`, which resets it, kept
//! on the task's contact so it runs on across a re-bind and the wait before it; once it reaches
//! 300 s the cause that stands picks the contact: a sign-in not accepted, errors that
//! persisted, or contact lost. The next poll that reads the task reads it reached again, or reads
//! the task's standing arm, which says what the task did and so holds to the end, across a
//! re-bind too.

use std::error::Error;
use std::future::Future;
use std::sync::{Arc, Mutex};
use std::time::Duration;

use rmcp::model::{ErrorCode, ErrorData};
use rmcp::service::ServiceError;
use rmcp::transport::DynamicTransportError;
use rmcp::transport::streamable_http_client::StreamableHttpError;
use serde_json::{Map, Value};
use sidekicks_std::failure_episode::FailureEpisode;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::{Notify, watch};
use tokio::time::Instant;

use crate::client::http::McpHttpError;
use crate::client::requests::McpRequestError;
use crate::client::tasks::{McpTaskContact, McpToolCallEnd};
use crate::sign_in::authorizer::SignInAuthorizationError;

/// The interval between polls when the server suggests none.
pub(super) const DEFAULT_POLL_INTERVAL: Duration = Duration::from_secs(2);

/// The shortest interval a server's suggestion is held to.
pub(super) const MIN_POLL_INTERVAL: Duration = Duration::from_millis(250);

/// The longest interval a server's suggestion is held to.
pub(super) const MAX_POLL_INTERVAL: Duration = Duration::from_secs(30);

/// How long no poll may read the task or answer `-32602` before the contact gives up on reaching
/// the server.
pub(super) const CONTACT_LOST_AFTER: Duration = Duration::from_secs(300);

/// How long, on the answered clock, a server may reject a task's id before its end reads unknown.
const TASK_ID_REJECTED_GRACE: Duration = Duration::from_secs(300);

/// What one poll read: wait for the next one, at the interval the server suggested in
/// milliseconds where it did, or the call's end.
pub(super) enum PollStep {
    /// The task is not done.
    Wait {
        /// The server's suggested interval, in milliseconds.
        suggested_interval_ms: Option<u64>,
    },
    /// The task is done.
    End(McpToolCallEnd),
}

/// What a failed poll says about the task.
pub(super) enum PollFailure {
    /// The connection closed under the poll.
    ConnectionClosed,
    /// The server answered `-32602`, rejecting the task's id, with this error object.
    TaskIdRejected {
        /// The JSON-RPC error object, as sent.
        error: Map<String, Value>,
    },
    /// The server answered `-32601` or `-32021`: it can never give the task's end.
    Permanent {
        /// The JSON-RPC error object, as sent.
        error: Map<String, Value>,
    },
    /// The server refused the poll's sign-in.
    SignInRefused,
    /// The server answered, with an error or with something that does not read.
    ErrorAnswer,
    /// No answer came back.
    NoAnswer,
}

/// A poll's error, read for what it says about the task.
pub(super) trait PollError: Error + 'static {
    /// What this failed poll says about the task.
    fn poll_failure(&self) -> PollFailure;
}

impl PollError for McpRequestError {
    fn poll_failure(&self) -> PollFailure {
        match self {
            Self::Service(error) => error.poll_failure(),
            Self::Refused { code, error } => read_refusal(*code, error.clone()),
            Self::ReplyNotKept { .. } | Self::Malformed { .. } => PollFailure::ErrorAnswer,
        }
    }
}

impl PollError for ServiceError {
    #[expect(
        clippy::wildcard_enum_match_arm,
        reason = "rmcp's errors are non-exhaustive, so every other kind is named by the wildcard"
    )]
    fn poll_failure(&self) -> PollFailure {
        match self {
            Self::TransportClosed => PollFailure::ConnectionClosed,
            Self::McpError(error) => read_refusal(i64::from(error.code.0), error_object(error)),
            Self::UnexpectedResponse => PollFailure::ErrorAnswer,
            Self::TransportSend(error) => read_transport_failure(error),
            _ => PollFailure::NoAnswer,
        }
    }
}

// Reads a JSON-RPC error the server answered with `code`.
fn read_refusal(code: i64, error: Map<String, Value>) -> PollFailure {
    if code == i64::from(ErrorCode::INVALID_PARAMS.0) {
        PollFailure::TaskIdRejected { error }
    } else if code == i64::from(ErrorCode::METHOD_NOT_FOUND.0)
        || code == i64::from(ErrorCode::MISSING_REQUIRED_CLIENT_CAPABILITY.0)
    {
        PollFailure::Permanent { error }
    } else {
        PollFailure::ErrorAnswer
    }
}

// The error object rmcp read, as the server sent it.
fn error_object(error: &ErrorData) -> Map<String, Value> {
    serde_json::to_value(error)
        .and_then(serde_json::from_value)
        .expect("a JSON-RPC error writes as a JSON object")
}

// Reads a failed send from its source chain: a refused sign-in, an answer that came back as an
// error, else no answer. rmcp's HTTP error carries our client's error without naming it as its
// source, so the walk steps into it. A renewal that failed reads as no answer unless the server
// refused the sign-in, which the authorizer reports as `SignInRequired`.
#[expect(
    clippy::wildcard_enum_match_arm,
    reason = "rmcp's errors are non-exhaustive, so every other kind is named by the wildcard"
)]
fn read_transport_failure(error: &DynamicTransportError) -> PollFailure {
    let mut cause: Option<&(dyn Error + 'static)> = Some(&*error.error);
    while let Some(current) = cause {
        if matches!(
            current.downcast_ref::<SignInAuthorizationError>(),
            Some(SignInAuthorizationError::SignInRequired)
        ) {
            return PollFailure::SignInRefused;
        }
        cause = current.source();
        let Some(http) = current.downcast_ref::<StreamableHttpError<McpHttpError>>() else {
            continue;
        };
        match http {
            StreamableHttpError::AuthRequired(_) | StreamableHttpError::InsufficientScope(_) => {
                return PollFailure::SignInRefused;
            }
            StreamableHttpError::HttpStatus(_)
            | StreamableHttpError::UnexpectedServerResponse(_)
            | StreamableHttpError::UnexpectedContentType(_)
            | StreamableHttpError::Deserialize(_)
            | StreamableHttpError::SessionExpired
            | StreamableHttpError::ReinitializationFailed(_) => return PollFailure::ErrorAnswer,
            StreamableHttpError::Client(client) => cause = Some(client),
            _ => {}
        }
    }
    PollFailure::NoAnswer
}

/// The time a server answered a task's polls: the time between two answered polls with no failed
/// poll between them, so an outage never counts.
#[derive(Clone, Copy, Default)]
pub(super) struct AnsweredClock {
    /// The time counted so far.
    counted: Duration,
    /// When the last answered poll came back, while no failed poll followed it.
    last_answered: Option<Instant>,
}

impl AnsweredClock {
    /// Counts a poll answered at `now`, adding the time since the last one when none failed
    /// between them.
    pub(super) fn answer(&mut self, now: Instant) {
        if let Some(last_answered) = self.last_answered {
            self.counted += now - last_answered;
        }
        self.last_answered = Some(now);
    }

    /// Breaks the chain at a failed poll, so the time until the next answered poll is not counted.
    pub(super) fn break_chain(&mut self) {
        self.last_answered = None;
    }

    /// The time counted so far.
    pub(super) fn counted(&self) -> Duration {
        self.counted
    }

    /// The time counted once a poll answered at `now` is counted.
    pub(super) fn counted_at(&self, now: Instant) -> Duration {
        self.last_answered.map_or(self.counted, |last_answered| {
            self.counted + (now - last_answered)
        })
    }
}

/// A followed task's contact with its standing arm and Lost's clock, kept on the task's watch, so
/// every writer shares them and a follow re-bound after its connection's close shows the arm the
/// last follow held and counts from the poll it last answered. Every clone writes the same contact.
#[derive(Clone)]
pub(super) struct TaskContact {
    sender: watch::Sender<McpTaskContact>,
    /// The standing arm, which stands in for `Reached`; `Reached` while none stands.
    standing: Arc<Mutex<McpTaskContact>>,
    /// Lost's clock: when a poll last read the task or answered `-32602`; `None` before any did.
    answered_at: Arc<Mutex<Option<Instant>>>,
}

impl TaskContact {
    /// The contact `sender` carries, a standing arm it shows taken as the task's.
    pub(super) fn new(sender: watch::Sender<McpTaskContact>) -> Self {
        let shown = *sender.borrow();
        let standing = if shown.is_standing() {
            shown
        } else {
            McpTaskContact::Reached
        };
        Self {
            sender,
            standing: Arc::new(Mutex::new(standing)),
            answered_at: Arc::new(Mutex::new(None)),
        }
    }

    /// When a poll last read the task or answered `-32602`, the time Lost's clock counts from;
    /// `None` before any did.
    pub(super) fn answered_at(&self) -> Option<Instant> {
        *lock(&self.answered_at)
    }

    // Starts Lost's clock again at `now`, when a poll read the task or answered `-32602`.
    fn mark_answered(&self, now: Instant) {
        *lock(&self.answered_at) = Some(now);
    }

    /// The arm the contact shows.
    pub(super) fn shown(&self) -> McpTaskContact {
        *self.sender.borrow()
    }

    /// Shows `arm`, what a poll read, telling the readers only when it changed; `Reached` shows
    /// the standing arm in its place.
    pub(super) fn write_reading(&self, arm: McpTaskContact) {
        let standing = lock(&self.standing);
        let arm = if arm == McpTaskContact::Reached {
            *standing
        } else {
            arm
        };
        self.sender
            .send_if_modified(|state| replace_arm(state, arm));
    }

    /// Takes `arm` as the task's standing arm, the latest winning, except that a refused cancel
    /// no stop asked for never replaces one a stop asked for. It shows at once unless a poll's
    /// cause shows, which the next poll that reads the task replaces with it.
    pub(super) fn write_standing(&self, arm: McpTaskContact) {
        let mut standing = lock(&self.standing);
        let is_stop_refusal_kept =
            arm == (McpTaskContact::CancelRefused {
                is_from_stop: false,
            }) && *standing == (McpTaskContact::CancelRefused { is_from_stop: true });
        if is_stop_refusal_kept {
            return;
        }
        *standing = arm;
        self.sender.send_if_modified(|state| {
            (*state == McpTaskContact::Reached || state.is_standing()) && replace_arm(state, arm)
        });
    }
}

// Puts `arm` in `state`; true when it changed.
fn replace_arm(state: &mut McpTaskContact, arm: McpTaskContact) -> bool {
    let is_new = *state != arm;
    *state = arm;
    is_new
}

/// The wait before the next poll: the server's suggestion held between the bounds, else the
/// default.
pub(super) fn poll_interval(suggested_interval_ms: Option<u64>) -> Duration {
    suggested_interval_ms.map_or(DEFAULT_POLL_INTERVAL, |milliseconds| {
        Duration::from_millis(milliseconds).clamp(MIN_POLL_INTERVAL, MAX_POLL_INTERVAL)
    })
}

/// Polls with `poll`, handed the answered clock as each poll starts, until it reads the end,
/// waiting the held interval between polls, or less when `wake` is notified but at least
/// [`MIN_POLL_INTERVAL`] from the last poll, and keeping `contact` to why the server is not
/// reached, if it is not, its standing arm shown once a poll reads the task. The first poll runs
/// at once. A closed connection ends `ConnectionClosed`; a `-32601`, a `-32021`,
/// or a `-32602` past its grace, ends `TaskUnknown` with the server's error.
pub(super) async fn follow_task<Error, Poll, Polled>(
    wake: &Notify,
    contact: &TaskContact,
    mut poll: Poll,
) -> McpToolCallEnd
where
    Error: PollError,
    Poll: FnMut(AnsweredClock) -> Polled,
    Polled: Future<Output = Result<PollStep, Error>>,
{
    // Lost's clock counts from the follow's start until a poll is answered.
    let started = Instant::now();
    let mut answered = AnsweredClock::default();
    // The answered clock's reading at the first `-32602` since a poll last read the task.
    let mut grace_start: Option<Duration> = None;
    let mut interval = DEFAULT_POLL_INTERVAL;
    let failure_episode = FailureEpisode::default();
    loop {
        let polled_at = Instant::now();
        let polled = poll(answered).await;
        let now = Instant::now();
        match polled {
            Ok(PollStep::End(end)) => {
                contact.write_reading(McpTaskContact::Reached);
                return end;
            }
            Ok(PollStep::Wait {
                suggested_interval_ms,
            }) => {
                failure_episode.mark_succeeded();
                contact.mark_answered(now);
                answered.answer(now);
                grace_start = None;
                contact.write_reading(McpTaskContact::Reached);
                interval = poll_interval(suggested_interval_ms);
            }
            Err(error) => {
                log_failed_poll(&failure_episode, &error);
                let cause = match error.poll_failure() {
                    PollFailure::ConnectionClosed => return McpToolCallEnd::ConnectionClosed,
                    PollFailure::Permanent { error } => {
                        return McpToolCallEnd::TaskUnknown { error };
                    }
                    PollFailure::TaskIdRejected { error } => {
                        contact.mark_answered(now);
                        answered.answer(now);
                        let started = *grace_start.get_or_insert(answered.counted());
                        if answered.counted().saturating_sub(started) >= TASK_ID_REJECTED_GRACE {
                            return McpToolCallEnd::TaskUnknown { error };
                        }
                        contact.write_reading(McpTaskContact::TaskIdRejected);
                        None
                    }
                    PollFailure::SignInRefused => Some(McpTaskContact::NeedsSignIn),
                    PollFailure::ErrorAnswer => Some(McpTaskContact::AnsweredWithErrors),
                    PollFailure::NoAnswer => Some(contact.shown()),
                };
                if let Some(cause) = cause {
                    answered.break_chain();
                    let last_answered = contact.answered_at().unwrap_or(started);
                    let arm = if now - last_answered >= CONTACT_LOST_AFTER {
                        cause_at_contact_lost(cause)
                    } else {
                        cause
                    };
                    contact.write_reading(arm);
                }
            }
        }
        tokio::select! {
            () = tokio::time::sleep(interval) => {}
            () = wake.notified() => {
                tokio::time::sleep_until(polled_at + MIN_POLL_INTERVAL).await;
            }
        }
    }
}

// Logs a failed poll's `error`, at warn the first failure of `failure_episode` and at debug after.
fn log_failed_poll(failure_episode: &FailureEpisode, error: &(dyn Error + 'static)) {
    if failure_episode.is_first_failure() {
        tracing::warn!(error, "a tool server task poll failed");
    } else {
        tracing::debug!(error, "a tool server task poll failed again");
    }
}

/// The arm a standing `cause` turns into once Lost's clock reaches 300 s: a refused sign-in and
/// error answers keep their own reason, and every other cause reads `Lost`.
pub(super) fn cause_at_contact_lost(cause: McpTaskContact) -> McpTaskContact {
    match cause {
        McpTaskContact::NeedsSignIn | McpTaskContact::SignInNotAccepted => {
            McpTaskContact::SignInNotAccepted
        }
        McpTaskContact::AnsweredWithErrors | McpTaskContact::ErrorsPersisted => {
            McpTaskContact::ErrorsPersisted
        }
        McpTaskContact::Reached
        | McpTaskContact::Lost
        | McpTaskContact::TaskIdRejected
        | McpTaskContact::NotConfigured
        | McpTaskContact::Reconfigured
        | McpTaskContact::DidNotAskAgain { .. }
        | McpTaskContact::CancelRefused { .. } => McpTaskContact::Lost,
    }
}

#[cfg(test)]
mod tests {
    use std::any::TypeId;
    use std::time::Duration;

    use rmcp::model::{ErrorCode, ErrorData};
    use rmcp::service::ServiceError;
    use rmcp::transport::DynamicTransportError;
    use rmcp::transport::auth::AuthError;
    use rmcp::transport::streamable_http_client::{
        AuthRequiredError, HttpStatusError, StreamableHttpError,
    };
    use rstest::rstest;
    use serde_json::{Map, Value, json};
    use tokio::sync::{Notify, watch};
    use tokio::time::Instant;

    use self::Reply::{
        AuthorizerSignInRequired, Closed, Completed, McpError, Refused, RenewalFailed,
        SignInRefused, Silent, Unavailable, Working,
    };
    use super::{DEFAULT_POLL_INTERVAL, PollStep, TaskContact, follow_task, poll_interval};
    use crate::client::http::McpHttpError;
    use crate::client::requests::McpRequestError;
    use crate::client::tasks::McpTaskContact::{
        AnsweredWithErrors, CancelRefused, DidNotAskAgain, ErrorsPersisted, Lost, NeedsSignIn,
        Reached, SignInNotAccepted, TaskIdRejected,
    };
    use crate::client::tasks::{McpTaskContact, McpToolCallEnd};
    use crate::sign_in::authorizer::SignInAuthorizationError;

    // Fails when the server's suggestion is taken unbounded (a removed clamp) or the default is
    // not 2 s.
    #[rstest]
    #[case::none(None, DEFAULT_POLL_INTERVAL)]
    #[case::below_the_floor(Some(10), Duration::from_millis(250))]
    #[case::inside(Some(5_000), Duration::from_secs(5))]
    #[case::past_the_ceiling(Some(120_000), Duration::from_secs(30))]
    fn the_servers_interval_is_held_between_250_ms_and_30_s(
        #[case] suggested: Option<u64>,
        #[case] expected: Duration,
    ) {
        assert_eq!(poll_interval(suggested), expected);
    }

    /// What a scripted poll answers.
    #[derive(Clone, Copy)]
    enum Reply {
        /// `working`.
        Working,
        /// `completed`, with the result inline.
        Completed,
        /// The connection closed.
        Closed,
        /// A JSON-RPC error with this code, read raw as a 2025-11-25 poll reads it.
        Refused(i32),
        /// A JSON-RPC error with this code, read through rmcp as a 2026-07-28 poll reads it.
        McpError(i32),
        /// An HTTP 503.
        Unavailable,
        /// A 401 asking for a sign-in.
        SignInRefused,
        /// The authorizer holds no sign-in the server accepts.
        AuthorizerSignInRequired,
        /// A refused request whose token's renewal failed on the network, the sign-in kept.
        RenewalFailed,
        /// No answer within the request's bound.
        Silent,
    }

    fn object(value: Value) -> Map<String, Value> {
        let Value::Object(object) = value else {
            panic!("an object");
        };
        object
    }

    fn refused_error(code: i32) -> Map<String, Value> {
        object(json!({ "code": code, "message": "refused" }))
    }

    fn mcp_error(code: i32) -> Map<String, Value> {
        object(json!({ "code": code, "message": "refused", "data": { "taskId": "task-1" } }))
    }

    fn result() -> Map<String, Value> {
        object(json!({ "content": [] }))
    }

    fn transport_failure(error: StreamableHttpError<McpHttpError>) -> McpRequestError {
        McpRequestError::Service(ServiceError::TransportSend(
            DynamicTransportError::from_parts("test", TypeId::of::<()>(), Box::new(error)),
        ))
    }

    fn poll_reply(reply: Reply) -> Result<PollStep, McpRequestError> {
        match reply {
            Working => Ok(PollStep::Wait {
                suggested_interval_ms: None,
            }),
            Completed => Ok(PollStep::End(McpToolCallEnd::Answered { result: result() })),
            Closed => Err(McpRequestError::Service(ServiceError::TransportClosed)),
            Refused(code) => Err(McpRequestError::Refused {
                code: i64::from(code),
                error: refused_error(code),
            }),
            McpError(code) => Err(McpRequestError::Service(ServiceError::McpError(
                ErrorData::new(
                    ErrorCode(code),
                    "refused",
                    Some(json!({ "taskId": "task-1" })),
                ),
            ))),
            Unavailable => Err(transport_failure(StreamableHttpError::HttpStatus(
                HttpStatusError::new(503, None),
            ))),
            SignInRefused => Err(transport_failure(StreamableHttpError::AuthRequired(
                AuthRequiredError::new(r#"Bearer error="invalid_token""#.to_owned()),
            ))),
            AuthorizerSignInRequired => Err(transport_failure(StreamableHttpError::Client(
                McpHttpError::Authorize(Box::new(SignInAuthorizationError::SignInRequired)),
            ))),
            RenewalFailed => Err(transport_failure(StreamableHttpError::Client(
                McpHttpError::Renewal(Box::new(SignInAuthorizationError::Renewal(
                    AuthError::TokenRefreshFailed("error sending request".to_owned()),
                ))),
            ))),
            Silent => Err(McpRequestError::Service(ServiceError::Timeout {
                timeout: Duration::from_secs(60),
            })),
        }
    }

    // Each case polls every 2 s, `script` answering by the second since the follow began, and
    // reads the follow's end, the second it ended at and each contact change with its second.
    // Mutations, each failing a case: in `follow_task`, end on any error (the no-answer, 503 and
    // sign-in cases); poll on at `ConnectionClosed` (closed); poll on at a permanent code (the
    // `-32601` and `-32021` cases); never clear the grace at a reading poll (reading clears the
    // grace); measure the grace on wall time, or leave `break_chain` out (an outage before the
    // second `-32602`); reset the answered clock at a failed poll (a failed poll in every 300 s);
    // write `Lost` or nothing for a sign-in, a rejected id or an error answer (the 503, sign-in
    // and rejected cases); leave Lost's clock running at a `-32602`, or keep `Lost` over it (lost,
    // then rejected); or pick the 300 s arm from the wrong cause (the 503 and sign-in cases). In
    // `read_transport_failure`, read every failed renewal as a refused sign-in (a renewal failed
    // on the network), or stop at rmcp's client error instead of stepping into it (the
    // authorizer's sign-in required). In `poll_failure`, read any row of its table as another.
    #[rstest]
    #[case::closed(|_| Closed, McpToolCallEnd::ConnectionClosed, 0, vec![])]
    #[case::rejected_on_every_poll(
        |_| Refused(-32_602),
        McpToolCallEnd::TaskUnknown { error: refused_error(-32_602) },
        300,
        vec![(0, TaskIdRejected)],
    )]
    #[case::reading_clears_the_grace(
        |at| if at == 202 { Working } else { McpError(-32_602) },
        McpToolCallEnd::TaskUnknown { error: mcp_error(-32_602) },
        504,
        vec![(0, TaskIdRejected), (202, Reached), (204, TaskIdRejected)],
    )]
    #[case::an_outage_then_rejected(
        |at| if at < 600 { Silent } else { McpError(-32_602) },
        McpToolCallEnd::TaskUnknown { error: mcp_error(-32_602) },
        900,
        vec![(300, Lost), (600, TaskIdRejected)],
    )]
    #[case::an_outage_before_the_second_rejection(
        |at| if at == 0 || at >= 600 { McpError(-32_602) } else { Silent },
        McpToolCallEnd::TaskUnknown { error: mcp_error(-32_602) },
        900,
        vec![(0, TaskIdRejected), (300, Lost), (600, TaskIdRejected)],
    )]
    #[case::a_failed_poll_in_every_300_s(
        |at| if at % 300 == 150 { Silent } else { McpError(-32_602) },
        McpToolCallEnd::TaskUnknown { error: mcp_error(-32_602) },
        304,
        vec![(0, TaskIdRejected)],
    )]
    #[case::method_not_found_raw(
        |_| Refused(-32_601),
        McpToolCallEnd::TaskUnknown { error: refused_error(-32_601) },
        0,
        vec![],
    )]
    #[case::method_not_found(
        |_| McpError(-32_601),
        McpToolCallEnd::TaskUnknown { error: mcp_error(-32_601) },
        0,
        vec![],
    )]
    #[case::missing_capability(
        |_| McpError(-32_021),
        McpToolCallEnd::TaskUnknown { error: mcp_error(-32_021) },
        0,
        vec![],
    )]
    #[case::no_answer(
        |at| match at { 0..310 => Silent, 310 => Working, _ => Completed },
        McpToolCallEnd::Answered { result: result() },
        312,
        vec![(300, Lost), (310, Reached)],
    )]
    #[case::service_unavailable(
        |at| match at { 10 | 312 => Working, 314.. => Completed, _ => Unavailable },
        McpToolCallEnd::Answered { result: result() },
        314,
        vec![
            (0, AnsweredWithErrors),
            (10, Reached),
            (12, AnsweredWithErrors),
            (310, ErrorsPersisted),
            (312, Reached),
        ],
    )]
    #[case::lost_then_rejected(
        |at| match at { 302 => McpError(-32_602), 604 => Working, 606.. => Completed, _ => Silent },
        McpToolCallEnd::Answered { result: result() },
        606,
        vec![(300, Lost), (302, TaskIdRejected), (602, Lost), (604, Reached)],
    )]
    #[case::sign_in_refused(
        |at| match at { 10 | 312 => Working, 314.. => Completed, _ => SignInRefused },
        McpToolCallEnd::Answered { result: result() },
        314,
        vec![
            (0, NeedsSignIn),
            (10, Reached),
            (12, NeedsSignIn),
            (310, SignInNotAccepted),
            (312, Reached),
        ],
    )]
    #[case::the_authorizers_sign_in_required(
        |at| match at { 0..10 => AuthorizerSignInRequired, 10 => Working, _ => Completed },
        McpToolCallEnd::Answered { result: result() },
        12,
        vec![(0, NeedsSignIn), (10, Reached)],
    )]
    #[case::a_renewal_failed_on_the_network(
        |at| match at { 0..310 => RenewalFailed, 310 => Working, _ => Completed },
        McpToolCallEnd::Answered { result: result() },
        312,
        vec![(300, Lost), (310, Reached)],
    )]
    #[tokio::test(start_paused = true)]
    async fn each_failed_poll_is_read_for_what_it_says(
        #[case] script: fn(u64) -> Reply,
        #[case] expected_end: McpToolCallEnd,
        #[case] expected_ended_at: u64,
        #[case] expected_contacts: Vec<(u64, McpTaskContact)>,
    ) {
        let (end, ended_at, contacts) = follow_script(Reached, script).await;

        assert_eq!(end, Some(expected_end));
        assert_eq!(ended_at, expected_ended_at);
        assert_eq!(contacts, expected_contacts);
    }

    // Mutations: write `Reached` at an answered poll in place of the task's standing arm; or leave
    // either arm out of `is_standing`.
    #[rstest]
    #[case::a_refused_cancel(CancelRefused { is_from_stop: true })]
    #[case::a_question_not_asked_again(DidNotAskAgain { has_undelivered_answer: true })]
    #[tokio::test(start_paused = true)]
    async fn an_answered_poll_after_an_outage_restores_the_standing_arm(
        #[case] standing: McpTaskContact,
    ) {
        let (end, ended_at, contacts) = follow_script(standing, |at| match at {
            0..310 => Silent,
            310 => Working,
            _ => Completed,
        })
        .await;

        assert_eq!(end, Some(McpToolCallEnd::Answered { result: result() }));
        assert_eq!(ended_at, 312);
        assert_eq!(contacts, [(300, Lost), (310, standing)]);
    }

    // Mutations: in `TaskContact::write_standing`, show the arm over a poll's cause, or let a
    // refused cancel no stop asked for replace one a stop asked for.
    #[test]
    fn a_standing_arm_waits_behind_a_shown_cause_and_a_stops_refusal_stands() {
        let contact = TaskContact::new(watch::Sender::new(Reached));
        contact.write_reading(Lost);

        contact.write_standing(CancelRefused { is_from_stop: true });
        assert_eq!(contact.shown(), Lost, "the cause keeps showing");
        contact.write_standing(CancelRefused {
            is_from_stop: false,
        });
        contact.write_reading(Reached);

        assert_eq!(contact.shown(), CancelRefused { is_from_stop: true });
    }

    // Follows a task polled every 2 s from the contact `initial`, `script` answering by the second
    // since the follow began, and gives its end, the second it ended at and each contact change
    // with its second; `None` for a follow still running after 50 minutes.
    async fn follow_script(
        initial: McpTaskContact,
        script: fn(u64) -> Reply,
    ) -> (Option<McpToolCallEnd>, u64, Vec<(u64, McpTaskContact)>) {
        let wake = Notify::new();
        let sender = watch::Sender::new(initial);
        let mut seen = sender.subscribe();
        let contact = TaskContact::new(sender);
        let started = Instant::now();
        let follow = follow_task(&wake, &contact, |_| {
            std::future::ready(poll_reply(script(started.elapsed().as_secs())))
        });
        tokio::pin!(follow);
        let mut contacts = Vec::new();
        // Bounded so a mutant that never ends fails here, not at the runner's kill.
        let end = loop {
            tokio::select! {
                end = &mut follow => break Some(end),
                changed = seen.changed() => {
                    changed.expect("the contact is kept");
                    contacts.push((started.elapsed().as_secs(), *seen.borrow_and_update()));
                }
                () = tokio::time::sleep_until(started + Duration::from_mins(50)) => break None,
            }
        };
        // A `Reached` written by the poll that read the end loses the race to the end.
        if seen.has_changed().expect("the contact is kept") {
            contacts.push((started.elapsed().as_secs(), *seen.borrow_and_update()));
        }
        (end, started.elapsed().as_secs(), contacts)
    }
}
