//! Handing the text the daemon writes for another session's message, a wake-up or a reminder to a
//! Codex conversation: as the opening of a new turn of the session's own when the conversation is
//! idle, or steered into the run that is working. Codex keeps no reply chain, so each session keeps
//! the chain the latest chained message landed with, for the run it lands in, from just before its
//! run starts or its steer goes, the chain before it put back should either fail, and a send that
//! run makes carries it on as received.

#![expect(
    dead_code,
    reason = "the driver method that delivers another session's message, wake-up or reminder \
              calls these steps and drops a closed session's chain"
)]

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use futures::FutureExt as _;
use sidekicks_contracts::artifacts::id::ArtifactId;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::{MessageContent, QueueItemId};
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::intervention::{CodexSteerAcknowledgment, CodexSteerRunRequest};
use crate::driver::codex::run::control::CodexRunControl;
use crate::driver::codex::run::routes::CodexRunRoutes;
use crate::driver::codex::run::start::CodexRunStart;
use crate::driver::codex::session::calls::call_codex_session;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::CodexSessionCall;
use crate::driver::codex::session::slots::CodexSessionSlots;
use crate::driver::contract::error::DriverError;
use crate::driver::contract::params_and_results::{RunOpening, RunOpeningItem, StartRunParams};
use crate::driver::run_control::{
    DaemonTurnBindingResolver, DaemonTurnProcess, SteerTurnEndedError,
};
use crate::port::run_host::RunHost;
use crate::run::start_request::DaemonTurnStartRequest;

/// The text the daemon writes into a Codex conversation, an arrival, a wake-up or a reminder,
/// with what it carries.
pub(crate) struct CodexDaemonMessage {
    /// The id the text goes to Codex under, which its echo carries back; the caller mints it, so
    /// the send can be paired with the echo.
    pub(crate) message_id: QueueItemId,
    /// The framed text.
    pub(crate) content: MessageContent,
    /// The files staged into the receiving session, in staging order.
    pub(crate) attachments: Vec<ArtifactId>,
    /// The reply chain the message carries on, in the order received; empty for a reminder and
    /// for a message no chain reached.
    pub(crate) reply_chain: Vec<String>,
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
}

/// Hands the daemon's texts to Codex conversations and keeps each session's reply chain.
pub(crate) struct CodexPeerDelivery {
    dependencies: CodexPeerDeliveryDependencies,
    // One entry per session a chained message reached, holding the chain it was handed.
    reply_chains: Arc<Mutex<HashMap<SessionId, KeptReplyChain>>>,
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
    /// The delivery acting through `dependencies`, keeping no chain yet.
    pub(crate) fn new(dependencies: CodexPeerDeliveryDependencies) -> Self {
        Self {
            dependencies,
            reply_chains: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    /// Opens a new turn of the session's own with `message`, as a run the engine starts at the
    /// session's posture on the account its process was admitted against, and answers the run's
    /// id. Fails with `CodexError::SessionTurnInFlight`, before any run exists, while a turn of
    /// the session runs, starts or still ends, or the engine holds the session's turn for another
    /// run; as the session's slot and reading fail; and as the engine's start fails, the run then
    /// ended `failed` by the engine.
    pub(crate) async fn deliver_to_idle(
        &self,
        session_id: SessionId,
        message: CodexDaemonMessage,
    ) -> Result<RunId, DriverError> {
        let inbound = self.dependencies.slots.require_live(session_id)?;
        let reading = call_codex_session(&inbound, |reply| CodexSessionCall::ReadSession {
            thread_id: None,
            reply,
        })
        .await?;
        if reading.is_turn_in_flight {
            return Err(CodexError::SessionTurnInFlight { session_id }.into());
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
                                    content: message.content.into(),
                                    attachments: message.attachments,
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
            .map_err(|error| CodexError::from_daemon_turn_start(session_id, error).into())
    }

    /// Steers `message` into `run_id`'s running turn as soon as the steer before it was answered,
    /// keeping its chain for that run from just before the steer goes. Fails with `SteerTurnEnded`
    /// when the run has no live turn, and as [`CodexRunControl::steer_run`] fails, the chain kept
    /// before it then put back.
    pub(crate) async fn deliver_to_run(
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
                content: message.content.into(),
                skills: Vec::new(),
                attachments: message.attachments,
                expected_turn_id: None,
                client_idempotency_key: message.message_id,
            })
            .await
            .inspect_err(|_| put_back_reply_chain(&self.reply_chains, kept))
    }

    /// The chain a send `run_id` makes in `session_id` carries on: the one the latest chained
    /// message that landed in that run arrived with, and none for any other run of the session.
    pub(crate) fn reply_chain(&self, session_id: SessionId, run_id: RunId) -> Vec<String> {
        lock(&self.reply_chains)
            .get(&session_id)
            .filter(|kept| kept.run_id == run_id)
            .map(|kept| kept.chain.clone())
            .unwrap_or_default()
    }

    /// Drops the chain kept for a session that closed.
    pub(crate) fn forget_session(&self, session_id: SessionId) {
        lock(&self.reply_chains).remove(&session_id);
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
            attachments: Vec::new(),
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
