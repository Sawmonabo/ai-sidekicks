//! Where a driver hands the structured questions a provider asks the person, so the questions card
//! asks them and the answer goes back through the driver's `respond_to_request`; and where the
//! daemon's tool-server client hands the questions a tool server's task asks, whose answer goes
//! back through the client.

#[cfg(test)]
pub(crate) mod test_card;

use std::error::Error;
use std::pin::{Pin, pin};
use std::sync::{Arc, LazyLock};

use futures::FutureExt as _;
use futures::future::BoxFuture;
use sidekicks_contracts::question::{QuestionAnswer, QuestionAskedState, QuestionPrompt};
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use sidekicks_std::error_description::describe_error;
use sidekicks_std::keyed_lock::{KeyHold, KeyWait, KeyedLock};

// Each run's line of questions taken in its turn, which every driver's question and each tool
// server's question taken in its run's turn joins, so they open in the order they came.
static RUN_QUESTION_LINE: LazyLock<KeyedLock<RunId>> = LazyLock::new(KeyedLock::new);

/// The questions one provider request asks, in its order, with the provider's own request id the
/// answer goes back under, and whether the agent waits for the answer.
#[derive(Clone, Debug, PartialEq)]
pub(crate) struct ProviderQuestion {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The run that asks.
    pub(crate) run_id: RunId,
    /// The provider's own request id.
    pub(crate) request_id: String,
    /// The questions, in the request's order.
    pub(crate) questions: Vec<QuestionPrompt>,
    /// False only on a question the agent does not wait for: its run keeps running and the
    /// person's queued message answers it.
    pub(crate) is_agent_waiting: bool,
}

/// A question the provider withdrew before anyone answered it, by the request id it came under.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct ProviderQuestionWithdrawal {
    /// The session.
    pub(crate) session_id: SessionId,
    /// The provider's own request id.
    pub(crate) request_id: String,
}

/// Where the person's answers to a tool server task's question go: the tool-server client, which
/// sends them to the server that asked.
pub(crate) trait ToolServerQuestionAnswer: Send + Sync {
    /// Sends `answers`, one per question in the question's order. An error when the server could
    /// not be sent them.
    fn answer(
        &self,
        answers: Vec<QuestionAnswer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// What an attempt to open a question that waits for its run came to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum WaitingQuestionOpening {
    /// Opened, its run moved to wait on it.
    Opened,
    /// Its run does not read running, so it waits on.
    RunNotRunning,
    /// It no longer waits: withdrawn, or canceled with its run's end.
    Settled,
}

/// How a question taken in its run's turn ended its turn.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum QuestionTurnEnd {
    /// It is open on the card.
    Taken,
    /// It was settled before its turn came: withdrawn, or canceled with its run's end.
    Settled,
    /// Its asker stopped waiting before its turn came, or as it opened; it was withdrawn.
    AskerLeft,
}

/// Why a question taken in its run's turn failed: its take, after which it was withdrawn, or the
/// withdrawal its asker's leaving asked for, so a caller never withdraws it a second time.
#[derive(Debug, thiserror::Error)]
pub(crate) enum QuestionTurnError {
    /// A write or the run's read failed before the question ended its turn; it was then withdrawn
    /// by its request id, or `withdrawal` says why not.
    #[error(
        "the question was not taken in its run's turn{}",
        describe_withdrawal_failure(.withdrawal.as_deref())
    )]
    Take {
        /// Why the take failed.
        #[source]
        take: Box<dyn Error + Send + Sync>,
        /// Why the withdrawal after it failed, when it did.
        withdrawal: Option<Box<dyn Error + Send + Sync>>,
    },
    /// Its asker left and its withdrawal failed.
    #[error("the question its asker left was not withdrawn")]
    Withdrawal(#[source] Box<dyn Error + Send + Sync>),
}

/// A question's place in its run's line, taken where the question arrives, before any await, and
/// handed to [`take_question_in_turn`].
pub(crate) struct QuestionLinePlace(Result<KeyHold<'static, RunId>, KeyWait<'static, RunId>>);

impl QuestionLinePlace {
    /// Takes the place of a question `run_id` asks now, behind every question of the run that
    /// came before it and has not yet opened.
    pub(crate) fn line_up(run_id: RunId) -> Self {
        Self(RUN_QUESTION_LINE.try_acquire(run_id))
    }
}

/// The questions card's intake, registered through a `PortRegistration`. Until it is registered, a
/// question stays pending at the provider: nothing answers it.
pub(crate) trait QuestionPort: Send + Sync {
    /// Records `question`, asked by a tool server's task during the run, whose answer goes to
    /// `answer` rather than the run's driver. An error when it could not be recorded.
    fn take_tool_server_question(
        &self,
        question: ProviderQuestion,
        answer: Arc<dyn ToolServerQuestionAnswer>,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Records `question` as [`take_question_in_turn`] needs it: open when `may_open` and its run
    /// reads running, else waiting for its run; answered through `answer`, or through the run's
    /// driver when `None`. An error when it could not be recorded.
    fn record_question_in_turn(
        &self,
        question: ProviderQuestion,
        answer: Option<Arc<dyn ToolServerQuestionAnswer>>,
        may_open: bool,
    ) -> BoxFuture<'_, Result<QuestionAskedState, Box<dyn Error + Send + Sync>>>;

    /// Opens the question of `session_id` recorded under `request_id` that waits for its run, in
    /// the write that moves its run from `running` to wait on it; one whose run has ended is
    /// canceled. An error when the write failed for another reason.
    fn open_waiting_question(
        &self,
        session_id: SessionId,
        request_id: String,
    ) -> BoxFuture<'_, Result<WaitingQuestionOpening, Box<dyn Error + Send + Sync>>>;

    /// Waits, with no timer, until `run_id` reads running or has ended, or a question waiting for
    /// it settled; the caller reads again what it waits on. An error when the run has no row or
    /// its read fails.
    fn wait_for_running_wake(
        &self,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;

    /// Waits, with no timer, for the next wake of `run_id`'s waiters while the question of
    /// `session_id` recorded under `request_id` still waits for its run, read once the wait is
    /// armed; answers whether it waited, false at once for a question withdrawn or settled. An
    /// error when its read fails.
    fn wait_while_question_waits(
        &self,
        session_id: SessionId,
        request_id: String,
        run_id: RunId,
    ) -> BoxFuture<'_, Result<bool, Box<dyn Error + Send + Sync>>>;

    /// Settles a withdrawn question's card canceled. An error when it could not be settled.
    fn withdraw_question(
        &self,
        withdrawal: ProviderQuestionWithdrawal,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>>;
}

/// Takes `question` through `port` in its run's turn, answered through `answer`, or the run's
/// driver when `None`. It is recorded at once: open when no question is ahead of `place`, its place
/// in its run's line, its run reads running and its asker has not left, else waiting for its run,
/// then taken in the line's order once the run reads running, never refused for asking while the
/// run waits on something else. When `asker_left` resolves before its turn, or by the time it
/// opened, it is withdrawn in this same task, after its record's write, so no record lands after
/// its withdrawal. Fails with [`QuestionTurnError::Take`] when a write or the run's read fails,
/// the question then withdrawn so no record is left with no take to open it, and with
/// [`QuestionTurnError::Withdrawal`] when its asker's withdrawal fails.
pub(crate) async fn take_question_in_turn(
    port: &dyn QuestionPort,
    question: ProviderQuestion,
    answer: Option<Arc<dyn ToolServerQuestionAnswer>>,
    place: QuestionLinePlace,
    asker_left: impl Future<Output = ()>,
) -> Result<QuestionTurnEnd, QuestionTurnError> {
    let mut asker_left = pin!(asker_left);
    let withdrawal = ProviderQuestionWithdrawal {
        session_id: question.session_id,
        request_id: question.request_id.clone(),
    };
    let mut ended = match take_in_turn(port, question, answer, place, asker_left.as_mut()).await {
        Ok(ended) => ended,
        Err(take) => {
            let withdrawal = port.withdraw_question(withdrawal).await.err();
            return Err(QuestionTurnError::Take { take, withdrawal });
        }
    };
    if ended == QuestionTurnEnd::Taken && asker_left.as_mut().now_or_never().is_some() {
        ended = QuestionTurnEnd::AskerLeft;
    }
    if ended == QuestionTurnEnd::AskerLeft {
        port.withdraw_question(withdrawal)
            .await
            .map_err(QuestionTurnError::Withdrawal)?;
    }
    Ok(ended)
}

// Records `question` and takes it in its run's turn, as [`take_question_in_turn`] says, short of
// the withdrawal its asker's leaving asks for.
async fn take_in_turn(
    port: &dyn QuestionPort,
    question: ProviderQuestion,
    answer: Option<Arc<dyn ToolServerQuestionAnswer>>,
    QuestionLinePlace(place): QuestionLinePlace,
    mut asker_left: Pin<&mut impl Future<Output = ()>>,
) -> Result<QuestionTurnEnd, Box<dyn Error + Send + Sync>> {
    let (session_id, run_id) = (question.session_id, question.run_id);
    let request_id = question.request_id.clone();
    // Read once: a finished asker future is never polled again.
    let has_asker_left = asker_left.as_mut().now_or_never().is_some();
    let recorded = port
        .record_question_in_turn(question, answer, place.is_ok() && !has_asker_left)
        .await?;
    if has_asker_left {
        return Ok(QuestionTurnEnd::AskerLeft);
    }
    if recorded == QuestionAskedState::Open {
        return Ok(QuestionTurnEnd::Taken);
    }
    // Held across every wait and the opening, so the questions behind it wait their turn. Its
    // asker's leaving is read first throughout, so a question never opens once its asker has left;
    // one withdrawn or settled behind the head of the line ends its turn at its run's wake.
    let _held = match place {
        Ok(hold) => hold,
        Err(mut wait) => loop {
            tokio::select! {
                biased;
                () = &mut asker_left => return Ok(QuestionTurnEnd::AskerLeft),
                hold = &mut wait => break hold,
                waited = port.wait_while_question_waits(session_id, request_id.clone(), run_id) => {
                    if !waited? {
                        return Ok(QuestionTurnEnd::Settled);
                    }
                }
            }
        },
    };
    loop {
        if asker_left.as_mut().now_or_never().is_some() {
            return Ok(QuestionTurnEnd::AskerLeft);
        }
        match port
            .open_waiting_question(session_id, request_id.clone())
            .await?
        {
            WaitingQuestionOpening::Opened => return Ok(QuestionTurnEnd::Taken),
            WaitingQuestionOpening::Settled => return Ok(QuestionTurnEnd::Settled),
            WaitingQuestionOpening::RunNotRunning => tokio::select! {
                biased;
                () = &mut asker_left => return Ok(QuestionTurnEnd::AskerLeft),
                waited = port.wait_for_running_wake(run_id) => waited?,
            },
        }
    }
}

// The words a take's error adds when the withdrawal after it failed too.
fn describe_withdrawal_failure(withdrawal: Option<&(dyn Error + Send + Sync + 'static)>) -> String {
    withdrawal
        .map(|error| format!(", nor withdrawn: {}", describe_error(error)))
        .unwrap_or_default()
}
