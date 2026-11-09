//! Delivering the daemon's text for another session's message, a wake-up or a reminder into a
//! Codex conversation: as the opening of a new turn of the session's own when the conversation is
//! idle; while a turn runs, held by the daemon and steered into that turn at its next tool
//! boundary, or opening the next turn once the session goes idle first; a pause gives the held
//! messages back for the paused session's queue. Each message the conversation is handed is
//! tracked until Codex settles it, so the session's task reads its echo, its prompt hook's refusal
//! or its give-back as the message's own reading. Codex keeps no reply chain, so each session
//! keeps the chain the latest chained message landed with, for the run it lands in, from just
//! before its run starts or its steer goes, the chain before it put back should either fail, and a
//! send that run makes carries it on as received.

use std::collections::{HashMap, HashSet, VecDeque};
use std::error::Error;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::task::TaskTracker;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::intervention::{CodexSteerAcknowledgment, CodexSteerRunRequest};
use crate::driver::codex::messages::{
    CodexArrivalMoment, compose_codex_arrival_text, compose_codex_reminder_text,
    compose_codex_wake_up_text,
};
use crate::driver::codex::run::control::CodexRunControl;
use crate::driver::codex::run::routes::CodexRunRoutes;
use crate::driver::codex::run::start::CodexRunStart;
use crate::driver::codex::run::turn_end_waiters::CodexTurnWait;
use crate::driver::codex::session::calls::{call_codex_session, wait_for_codex_turns};
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::CodexSessionCall;
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{RunOpening, RunOpeningItem, StartRunParams};
use crate::driver::run_control::{
    DaemonTurnBindingResolver, DaemonTurnProcess, RunToolBoundary, SteerTurnEndedError,
};
use crate::driver::session_messages::{
    SessionMessageDelivery, SessionMessageKind, SessionMessageSent,
};
use crate::port::run_host::RunHost;
use crate::port::session_message_reading_publisher::{
    SessionMessageReading, SessionMessageReadingPublisher,
};
use crate::run::start_request::DaemonTurnStartRequest;

/// The text the daemon writes into a Codex conversation, an arrival, a wake-up or a reminder,
/// with what it carries.
pub(crate) struct CodexDaemonMessage {
    /// The id the text goes to Codex under, which its echo carries back; the caller mints it, so
    /// the send can be paired with the echo.
    pub(crate) message_id: QueueItemId,
    /// The framed text.
    pub(crate) content: MessageContent,
    /// The reply chain the message carries on, in the order received; empty for a reminder and
    /// for a message no chain reached.
    pub(crate) reply_chain: Vec<String>,
}

/// The daemon's messages each session's conversation was handed and Codex has yet to settle, so
/// the session's task tells their echoes, refusals and give-backs from the queue's messages.
#[derive(Default)]
pub(crate) struct CodexPeerMessages {
    sent: Mutex<HashMap<SessionId, HashSet<QueueItemId>>>,
}

impl CodexPeerMessages {
    /// Tracks `message_id`, about to be handed to `session_id`'s conversation.
    fn track(&self, session_id: SessionId, message_id: QueueItemId) {
        lock(&self.sent)
            .entry(session_id)
            .or_default()
            .insert(message_id);
    }

    /// Takes `message_id` out of the messages `session_id` was handed, answering whether it was
    /// one of them; a session left with none keeps no entry.
    pub(crate) fn settle(&self, session_id: SessionId, message_id: QueueItemId) -> bool {
        let mut sent = lock(&self.sent);
        let Some(handed) = sent.get_mut(&session_id) else {
            return false;
        };
        let is_handed = handed.remove(&message_id);
        if handed.is_empty() {
            sent.remove(&session_id);
        }
        is_handed
    }

    // Forgets every message a closed session was handed.
    fn forget_session(&self, session_id: SessionId) {
        lock(&self.sent).remove(&session_id);
    }
}

/// What the delivery acts through, all shared by every session of the driver.
pub(crate) struct CodexPeerDeliveryDependencies {
    /// The sessions' slots, which hold each live session's queue.
    pub(crate) slots: Arc<CodexSessionSlots>,
    /// The run engine, which starts the session's own run for an idle conversation's turn.
    pub(crate) engine: Arc<dyn RunHost>,
    /// Opens the binding that run's turn runs on.
    pub(crate) daemon_turn_bindings: Arc<dyn DaemonTurnBindingResolver>,
    /// Starts the run's turn.
    pub(crate) run_start: Arc<CodexRunStart>,
    /// Steers a running turn and interrupts one.
    pub(crate) run_control: Arc<CodexRunControl>,
    /// The session each run's live turns are on.
    pub(crate) run_routes: Arc<CodexRunRoutes>,
    /// The messages each session was handed, which the sessions' tasks settle.
    pub(crate) sent: Arc<CodexPeerMessages>,
    /// Where what became of a held message that could not be handed goes.
    pub(crate) readings: Arc<PortRegistration<Arc<dyn SessionMessageReadingPublisher>>>,
    /// Runs each hand-off of the held messages off the session's task.
    pub(crate) tasks: TaskTracker,
}

/// Hands the daemon's texts to Codex conversations, holds those for a busy one, and keeps each
/// session's reply chain.
pub(crate) struct CodexPeerDelivery {
    dependencies: CodexPeerDeliveryDependencies,
    // One entry per session a chained message reached, holding the chain it was handed.
    reply_chains: Arc<Mutex<HashMap<SessionId, KeptReplyChain>>>,
    // Each busy session's messages, until its turn's next tool boundary or its next idle moment.
    held: Mutex<HashMap<SessionId, CodexHeldMessages>>,
}

// The messages held for one busy session, in send order, and whether a wait for its next idle
// moment is under way.
#[derive(Default)]
struct CodexHeldMessages {
    messages: VecDeque<CodexHeldMessage>,
    is_awaiting_idle: bool,
}

// Where messages held again go among those a session holds.
#[derive(Clone, Copy)]
enum HeldPlace {
    // Ahead of the rest: messages taken to be handed and given back unsent.
    First,
    // Behind the rest: a message newly held.
    Last,
}

// A message the daemon holds for a busy session, framed only as it is handed, for the moment it
// lands at.
struct CodexHeldMessage {
    message_id: QueueItemId,
    sender_session_id: SessionId,
    sender_name: String,
    kind: SessionMessageKind,
}

impl CodexHeldMessage {
    fn new(delivery: SessionMessageDelivery) -> Self {
        Self {
            message_id: delivery.message_id,
            sender_session_id: delivery.sender_session_id,
            sender_name: delivery.sender_name,
            kind: delivery.kind,
        }
    }

    // The text Codex is handed for the message landing at `moment`, with its chain.
    fn compose(&self, moment: CodexArrivalMoment) -> CodexDaemonMessage {
        let (text, reply_chain) = match &self.kind {
            SessionMessageKind::Message {
                body, hop_chain, ..
            } => (
                compose_codex_arrival_text(&self.sender_name, self.sender_session_id, body, moment),
                hop_chain.clone(),
            ),
            SessionMessageKind::WakeUp(end) => (
                compose_codex_wake_up_text(&self.sender_name, self.sender_session_id, end),
                Vec::new(),
            ),
            SessionMessageKind::Reminder {
                set_at,
                due_at,
                note,
            } => (
                compose_codex_reminder_text(set_at, due_at, note, moment),
                Vec::new(),
            ),
        };
        CodexDaemonMessage {
            message_id: self.message_id,
            content: MessageContent::new(text).expect("a framed text is never blank"),
            reply_chain,
        }
    }
}

// The chain the latest chained message arrived with, and the run it landed in.
#[derive(Clone, PartialEq, Eq)]
struct KeptReplyChain {
    run_id: RunId,
    chain: Vec<String>,
}

// A chain kept for a landing still under way, and the one it replaced.
struct ReplacedReplyChain {
    session_id: SessionId,
    kept: KeptReplyChain,
    replaced: Option<KeptReplyChain>,
}

impl CodexPeerDelivery {
    /// The delivery acting through `dependencies`, keeping no chain and holding nothing yet.
    pub(crate) fn new(dependencies: CodexPeerDeliveryDependencies) -> Self {
        Self {
            dependencies,
            reply_chains: Arc::new(Mutex::new(HashMap::new())),
            held: Mutex::new(HashMap::new()),
        }
    }

    /// Delivers `delivery` into the session `session_id` hosts: a new turn of the session's own
    /// when its conversation is idle, else held for the running turn's next tool boundary, or for
    /// the session to go idle, when it opens the next turn. Answers `Sent` either way. Fails as the
    /// session's slot and reading fail and as the turn's start fails.
    pub(crate) async fn deliver(
        self: &Arc<Self>,
        session_id: SessionId,
        delivery: SessionMessageDelivery,
    ) -> Result<SessionMessageSent, DriverError> {
        let message = CodexHeldMessage::new(delivery);
        match self.open_turn(session_id, &message).await {
            Ok(_run_id) => Ok(SessionMessageSent::Sent),
            Err(CodexError::SessionTurnInFlight { .. }) => {
                self.hold(session_id, VecDeque::from([message]), HeldPlace::Last);
                Ok(SessionMessageSent::Sent)
            }
            Err(error) => Err(error.into()),
        }
    }

    /// Steers every message held for the boundary's session into the boundary's run, in send
    /// order, off the caller's task; a steer whose turn ended holds the rest again, first.
    pub(crate) fn steer_held_at(self: &Arc<Self>, boundary: &RunToolBoundary) {
        let RunToolBoundary { session_id, run_id } = *boundary;
        let mut held = self.take_held(session_id);
        if held.is_empty() {
            return;
        }
        let delivery = Arc::clone(self);
        self.dependencies.tasks.spawn(async move {
            while let Some(message) = held.pop_front() {
                let sent = &delivery.dependencies.sent;
                sent.track(session_id, message.message_id);
                let steered = delivery
                    .deliver_to_run(run_id, message.compose(CodexArrivalMoment::MidTurn))
                    .await;
                let Err(error) = steered else {
                    continue;
                };
                sent.settle(session_id, message.message_id);
                if matches!(error, DriverError::SteerTurnEnded(_)) {
                    held.push_front(message);
                    delivery.hold(session_id, held, HeldPlace::First);
                    return;
                }
                delivery.publish_unhanded(message.message_id, error);
            }
        });
    }

    /// Gives back every message held for `session_id`, whose turn a pause stopped, for the paused
    /// session's queue.
    pub(crate) fn give_back_held(&self, session_id: SessionId) {
        for message in self.take_held(session_id) {
            self.publish(SessionMessageReading::GivenBack {
                message_id: message.message_id.to_string(),
            });
        }
    }

    // Holds `messages` for the session, at `place` among those it holds, and has the session's
    // next idle moment open a turn with the first, unless a wait for it is already under way.
    fn hold(
        self: &Arc<Self>,
        session_id: SessionId,
        mut messages: VecDeque<CodexHeldMessage>,
        place: HeldPlace,
    ) {
        let is_wait_owed = {
            let mut held = lock(&self.held);
            let session = held.entry(session_id).or_default();
            match place {
                HeldPlace::First => {
                    messages.append(&mut session.messages);
                    session.messages = messages;
                }
                HeldPlace::Last => session.messages.append(&mut messages),
            }
            !std::mem::replace(&mut session.is_awaiting_idle, true)
        };
        if is_wait_owed {
            let delivery = Arc::clone(self);
            self.dependencies
                .tasks
                .spawn(async move { delivery.open_turn_when_idle(session_id).await });
        }
    }

    // Waits for the session to go idle, then opens a turn of its own with the first message it
    // holds, the message held again, first, should another turn be in flight by then; one that
    // fails otherwise reads as its failure says. A session gone meanwhile leaves its messages to
    // its close.
    async fn open_turn_when_idle(self: &Arc<Self>, session_id: SessionId) {
        let is_idle = match self.dependencies.slots.require_live(session_id) {
            Ok(inbound) => wait_for_codex_turns(&inbound, CodexTurnWait::Idle, None)
                .await
                .unwrap_or_else(|error| {
                    tracing::debug!(
                        error = &error as &(dyn Error + 'static),
                        %session_id,
                        "a codex session holding messages went before it was idle"
                    );
                    false
                }),
            Err(_gone) => false,
        };
        let first = {
            let mut held = lock(&self.held);
            let Some(session) = held.get_mut(&session_id) else {
                return;
            };
            session.is_awaiting_idle = false;
            let first = if is_idle {
                session.messages.pop_front()
            } else {
                None
            };
            if session.messages.is_empty() {
                held.remove(&session_id);
            }
            first
        };
        let Some(message) = first else {
            return;
        };
        match self.open_turn(session_id, &message).await {
            Ok(_run_id) => {}
            Err(CodexError::SessionTurnInFlight { .. }) => {
                self.hold(session_id, VecDeque::from([message]), HeldPlace::First);
            }
            Err(error) => self.publish_unhanded(message.message_id, error.into()),
        }
    }

    // Takes every message held for the session, keeping its entry while a wait for its idle
    // moment is under way.
    fn take_held(&self, session_id: SessionId) -> VecDeque<CodexHeldMessage> {
        let mut held = lock(&self.held);
        let Some(session) = held.get_mut(&session_id) else {
            return VecDeque::new();
        };
        let taken = std::mem::take(&mut session.messages);
        if !session.is_awaiting_idle {
            held.remove(&session_id);
        }
        taken
    }

    // Opens a turn of the session's own with `message` framed for an idle conversation, the
    // message tracked from before its start goes, since Codex can echo it before it answers.
    async fn open_turn(
        &self,
        session_id: SessionId,
        message: &CodexHeldMessage,
    ) -> Result<RunId, CodexError> {
        let sent = &self.dependencies.sent;
        sent.track(session_id, message.message_id);
        let opened = self
            .deliver_to_idle(session_id, message.compose(CodexArrivalMoment::Idle))
            .await;
        if opened.is_err() {
            sent.settle(session_id, message.message_id);
        }
        opened
    }

    // Reads a held message the conversation could not be handed: refused with the provider's
    // words where it refused it, else not delivered.
    fn publish_unhanded(&self, message_id: QueueItemId, error: DriverError) {
        tracing::warn!(
            error = &error as &(dyn Error + 'static),
            %message_id,
            "a message the daemon held for a codex session could not be handed"
        );
        let message_id = message_id.to_string();
        self.publish(if let DriverError::Refused(refusal) = error {
            SessionMessageReading::Refused {
                message_id,
                reason: Some(refusal.to_string()),
                drop_reason: None,
            }
        } else {
            SessionMessageReading::NotDelivered { message_id }
        });
    }

    // Publishes `reading`; one made before the readings are registered is dropped.
    fn publish(&self, reading: SessionMessageReading) {
        if let Some(publisher) = self.dependencies.readings.port() {
            publisher.publish(reading);
        }
    }

    /// Opens a new turn of the session's own with `message`, as a run the engine starts at the
    /// session's posture on the account its process was admitted against, and answers the run's
    /// id. Fails with `CodexError::SessionTurnInFlight`, before any run exists, while a turn of
    /// the session runs, starts or still ends, or the engine holds the session's turn for another
    /// run; as the session's slot and reading fail; and as the engine's start fails, the run then
    /// ended `failed` by the engine.
    async fn deliver_to_idle(
        &self,
        session_id: SessionId,
        message: CodexDaemonMessage,
    ) -> Result<RunId, CodexError> {
        let inbound = self.dependencies.slots.require_live(session_id)?;
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        if reading.is_turn_in_flight {
            return Err(CodexError::SessionTurnInFlight { session_id });
        }
        let message = Arc::new(Mutex::new(Some(message)));
        let bindings = Arc::clone(&self.dependencies.daemon_turn_bindings);
        let run_start = Arc::clone(&self.dependencies.run_start);
        let reply_chains = Arc::clone(&self.reply_chains);
        let run_control = Arc::clone(&self.dependencies.run_control);
        let execution_posture = reading.execution_posture.clone();
        let request = DaemonTurnStartRequest {
            session_id,
            provider: DESCRIPTOR.provider_id(),
            admitted_provider_account_id: reading.provider_account_id,
            execution_posture: reading.execution_posture,
            is_provider_started: false,
            start_turn: Box::new(move |run_id| {
                let bindings = Arc::clone(&bindings);
                let run_start = Arc::clone(&run_start);
                let reply_chains = Arc::clone(&reply_chains);
                let execution_posture = execution_posture.clone();
                let message = lock(&message).take();
                async move {
                    // The engine starts each run's turn once.
                    let Some(message) = message else {
                        return Ok(());
                    };
                    let binding = bindings
                        .open_daemon_turn_binding(
                            run_id,
                            session_id,
                            DaemonTurnProcess::OpenWhenAbsent,
                        )
                        .await?;
                    let kept =
                        keep_reply_chain(&reply_chains, session_id, run_id, message.reply_chain);
                    run_start
                        .start_run(StartRunParams {
                            run_id,
                            opening: RunOpening {
                                session_id,
                                binding_id: binding.binding_id,
                                agent_id: binding.agent_id,
                                message_id: message.message_id,
                                item: RunOpeningItem::Message {
                                    content: message.content,
                                    attachments: Vec::new(),
                                    skills: Vec::new(),
                                },
                            },
                            conversation_history: None,
                            output_speed: None,
                            options: Vec::new(),
                            output_speed_for_turn: None,
                            execution_posture: Some(execution_posture),
                            output_schema: None,
                            step_bound: binding.step_bound,
                        })
                        .await
                        .inspect_err(|_| put_back_reply_chain(&reply_chains, kept))?;
                    Ok(())
                }
                .boxed()
            }),
            interrupt_turn: Box::new(move |run_id| {
                let run_control = Arc::clone(&run_control);
                async move {
                    // A turn this start opened carries no steers, so none is answered.
                    run_control.interrupt_run(run_id).await?;
                    Ok(())
                }
                .boxed()
            }),
        };
        self.dependencies
            .engine
            .start_daemon_turn(request)
            .await
            .map_err(|error| CodexError::from_daemon_turn_start(session_id, error))
    }

    /// Steers `message` into `run_id`'s running turn as soon as the steer before it was answered,
    /// keeping its chain for that run from just before the steer goes. Fails with `SteerTurnEnded`
    /// when the run has no live turn, and as [`CodexRunControl::steer_run`] fails, the chain kept
    /// before it then put back.
    async fn deliver_to_run(
        &self,
        run_id: RunId,
        message: CodexDaemonMessage,
    ) -> Result<CodexSteerAcknowledgment, DriverError> {
        let Some(session_id) = self.dependencies.run_routes.session_id_for(run_id) else {
            return Err(SteerTurnEndedError { run_id }.into());
        };
        let kept = keep_reply_chain(&self.reply_chains, session_id, run_id, message.reply_chain);
        self.dependencies
            .run_control
            .steer_run(CodexSteerRunRequest {
                run_id,
                content: message.content,
                skills: Vec::new(),
                attachments: Vec::new(),
                expected_turn_id: None,
                client_idempotency_key: message.message_id,
            })
            .await
            .inspect_err(|_| put_back_reply_chain(&self.reply_chains, kept))
    }

    /// The chain a send `run_id` makes in `session_id` carries on: the one the latest chained
    /// message that landed in that run arrived with, and none for any other run of the session.
    #[cfg_attr(
        not(test),
        expect(
            dead_code,
            reason = "the send of another session's message reads the chain its run carries on"
        )
    )]
    pub(crate) fn reply_chain(&self, session_id: SessionId, run_id: RunId) -> Vec<String> {
        lock(&self.reply_chains)
            .get(&session_id)
            .filter(|kept| kept.run_id == run_id)
            .map(|kept| kept.chain.clone())
            .unwrap_or_default()
    }

    /// Drops what is kept for a session that closed: its chain, the messages it was handed, and
    /// the messages held for it, each of which reads not delivered.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.reply_chains).remove(&session_id);
        self.dependencies.sent.forget_session(session_id);
        let held = lock(&self.held)
            .remove(&session_id)
            .map(|session| session.messages)
            .unwrap_or_default();
        for message in held {
            self.publish(SessionMessageReading::NotDelivered {
                message_id: message.message_id.to_string(),
            });
        }
    }
}

// Keeps `chain` as received for the run it is landing in, answering what
// `put_back_reply_chain` needs should the landing fail; an empty chain leaves the kept one alone.
fn keep_reply_chain(
    reply_chains: &Mutex<HashMap<SessionId, KeptReplyChain>>,
    session_id: SessionId,
    run_id: RunId,
    chain: Vec<String>,
) -> Option<ReplacedReplyChain> {
    if chain.is_empty() {
        return None;
    }
    let kept = KeptReplyChain { run_id, chain };
    let replaced = lock(reply_chains).insert(session_id, kept.clone());
    Some(ReplacedReplyChain {
        session_id,
        kept,
        replaced,
    })
}

// Puts back the chain a landing that failed replaced, unless a later landing replaced its own.
fn put_back_reply_chain(
    reply_chains: &Mutex<HashMap<SessionId, KeptReplyChain>>,
    kept: Option<ReplacedReplyChain>,
) {
    let Some(ReplacedReplyChain {
        session_id,
        kept,
        replaced,
    }) = kept
    else {
        return;
    };
    let mut reply_chains = lock(reply_chains);
    if reply_chains.get(&session_id) != Some(&kept) {
        return;
    }
    match replaced {
        Some(replaced) => reply_chains.insert(session_id, replaced),
        None => reply_chains.remove(&session_id),
    };
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::time::Duration;

    use serde_json::json;
    use sidekicks_contracts::run::queue::MessageContent;
    use tokio_util::task::TaskTracker;

    use super::{CodexDaemonMessage, CodexPeerDelivery, CodexPeerDeliveryDependencies};
    use crate::driver::codex::messages::{CodexArrivalMoment, compose_codex_arrival_text};
    use crate::driver::codex::session::test_fixture::{TestCodexSession, turn_reply};
    use crate::driver::run_control::DaemonTurnBindingResolver;
    use crate::driver::test_registry::{new_message_id, new_run_id, new_session_id};
    use crate::port::run_host::RunHost;

    /// How long the test waits before it counts a hold on the session's task as a deadlock.
    const DEADLOCK_BOUND: Duration = Duration::from_secs(10);

    // Kills: the sender's name written where its id goes, in the element or the reply line; a
    // name holding a quote ending its attribute; the chain dropped on its way through the Codex
    // session; the session's own id added to the chain; the chain kept per session rather than
    // per run; the chain kept on the idle path only; a steered arrival told its answer goes back
    // on its own; and a refused start's or a refused steer's chain left kept, not put back.
    #[tokio::test]
    async fn an_arrival_names_its_sender_by_id_and_its_chain_crosses_the_codex_session() {
        let mut session = TestCodexSession::start().await;
        let binding_id = session.record_binding().await;
        session.daemon_turn_bindings.open_on(binding_id);
        let session_id = session.task.record.session_id;
        let delivery = CodexPeerDelivery::new(CodexPeerDeliveryDependencies {
            slots: Arc::clone(&session.slots),
            engine: Arc::clone(&session.engine) as Arc<dyn RunHost>,
            daemon_turn_bindings: Arc::clone(&session.daemon_turn_bindings)
                as Arc<dyn DaemonTurnBindingResolver>,
            run_start: Arc::clone(&session.run_start),
            run_control: Arc::clone(&session.task.run_control),
            run_routes: Arc::clone(&session.task.run_routes),
            sent: Arc::clone(&session.task.peer_messages),
            readings: Arc::clone(&session.task.ports.session_message_readings),
            tasks: TaskTracker::new(),
        });
        let sender_id = new_session_id();
        let [first_link, second_link, third_link] = [
            "0123456789abcdef01234567",
            "89abcdef0123456789abcdef",
            "fedcba9876543210fedcba98",
        ]
        .map(str::to_owned);
        let arrival = |moment, reply_chain| CodexDaemonMessage {
            message_id: new_message_id(),
            content: MessageContent::new(compose_codex_arrival_text(
                "planner",
                sender_id,
                "Use the new Money type in checkout.",
                moment,
            ))
            .expect("the framed text is a message"),
            reply_chain,
        };

        let quoted = compose_codex_arrival_text(
            "plan \"b\" & co",
            sender_id,
            "hi",
            CodexArrivalMoment::Idle,
        );
        assert!(
            quoted.contains(&format!(
                "from=\"plan &quot;b&quot; &amp; co\" session=\"{sender_id}\">"
            )),
            "a quote in the name stays inside its attribute: {quoted}"
        );

        let opening = arrival(
            CodexArrivalMoment::Idle,
            vec![first_link.clone(), second_link.clone()],
        );
        let task = &mut session.task;
        let script = &mut session.scripted.script;

        let refused_start = arrival(CodexArrivalMoment::Idle, vec![second_link.clone()]);
        let service = async {
            let sent = script.next_sent().await;
            assert_eq!(sent["method"], "turn/start");
            script.send(&json!({"jsonrpc": "2.0", "id": sent["id"],
                "error": {"code": -32600, "message": "the turn cannot start"}}));
        };
        let (start_refusal, ()) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async {
                tokio::join!(
                    task.drive(delivery.deliver_to_idle(session_id, refused_start)),
                    service
                )
            }),
        )
        .await
        .expect("the refused start settles");
        start_refusal.expect_err("a start Codex refuses fails");
        let refused_run = session
            .engine
            .first_daemon_turn_run()
            .expect("the refused start had its run");
        assert_eq!(
            delivery.reply_chain(session_id, refused_run),
            Vec::<String>::new()
        );

        let service = async {
            let sent = script.next_sent().await;
            assert_eq!(sent["method"], "turn/start");
            let text = sent["params"]["input"][0]["text"]
                .as_str()
                .expect("the turn opens with the framed text")
                .to_owned();
            script.answer(&sent, &turn_reply("turn-1"));
            text
        };
        let (delivered, text) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async {
                tokio::join!(
                    task.drive(delivery.deliver_to_idle(session_id, opening)),
                    service
                )
            }),
        )
        .await
        .expect("the idle delivery settles");
        let run_id = delivered.expect("the arrival opens a turn");
        assert_eq!(
            text.matches(&sender_id.to_string()).count(),
            2,
            "the element and the reply line each name the sender by id: {text}"
        );
        assert_eq!(
            delivery.reply_chain(session_id, run_id),
            [first_link.clone(), second_link]
        );
        assert_eq!(
            delivery.reply_chain(session_id, new_run_id()),
            Vec::<String>::new()
        );

        let steered = arrival(CodexArrivalMoment::MidTurn, vec![third_link.clone()]);
        let steered_id = steered.message_id;
        let service = async {
            let sent = script.next_sent().await;
            assert_eq!(sent["method"], "turn/steer");
            assert_eq!(
                sent["params"]["clientUserMessageId"],
                steered_id.to_string()
            );
            let text = sent["params"]["input"][0]["text"]
                .as_str()
                .expect("the steer carries the framed text")
                .to_owned();
            script.answer(&sent, &json!({"turnId": "turn-1"}));
            text
        };
        let (acknowledged, steered_text) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async {
                tokio::join!(
                    task.drive(delivery.deliver_to_run(run_id, steered)),
                    service
                )
            }),
        )
        .await
        .expect("the steer settles");
        acknowledged.expect("the arrival is steered into the running turn");
        assert!(
            steered_text.contains(&format!(
                "To answer planner, use session_send {{\"to\": \"{sender_id}\"}}."
            )) && !steered_text.contains("goes back"),
            "a steered arrival's answer goes nowhere on its own: {steered_text}"
        );
        assert_eq!(
            delivery.reply_chain(session_id, run_id),
            std::slice::from_ref(&third_link)
        );

        let refused = arrival(CodexArrivalMoment::MidTurn, vec![first_link]);
        let service = async {
            let sent = script.next_sent().await;
            assert_eq!(sent["method"], "turn/steer");
            script.send(&json!({"jsonrpc": "2.0", "id": sent["id"],
                "error": {"code": -32600, "message": "no active turn to steer"}}));
        };
        let (refusal, ()) = tokio::time::timeout(
            DEADLOCK_BOUND,
            Box::pin(async {
                tokio::join!(
                    task.drive(delivery.deliver_to_run(run_id, refused)),
                    service
                )
            }),
        )
        .await
        .expect("the refused steer settles");
        refusal.expect_err("a steer into no turn is refused");
        assert_eq!(delivery.reply_chain(session_id, run_id), [third_link]);
    }
}
