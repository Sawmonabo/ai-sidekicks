//! A steer's write: in the order handed over, after the choice its run is held on is settled, into
//! the run's running turn or, when settling the choice ended the run, as the session's next turn.
//! A person's `Send now` is written with Claude Code's `now` mark, and held while Claude Code holds
//! an ask open, since `now` would cancel the open card; a helper's steer waits for its hooks.

use std::sync::Arc;

use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::run::queue::QueueItemId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use tokio::sync::oneshot;

use super::held_steers::ClaudeSteer;
use super::{ClaudeInterventions, ClaudeSteerWriter, applied, no_live_run, turn_in_flight};
use crate::driver::attachments::{compose_message_text, resolve_message_attachments};
use crate::driver::claude::attachments::compose_claude_attachment_blocks;
use crate::driver::claude::run::controls::{ClaudeChoiceSettling, settle_claude_choice};
use crate::driver::claude::run::routes::{ClaudeChildRunRoute, ClaudeRunRoute};
use crate::driver::claude::run::start::ClaudeDaemonTurnOpening;
use crate::driver::claude::session::errors::ClaudeSessionError;
use crate::driver::claude::session::state::LiveClaudeSession;
use crate::driver::claude::session::transport::CLAUDE_REQUEST_DEADLINE;
use crate::driver::claude::session::transport::user_message::{
    ClaudeMessagePriority, ClaudeWriteAttempt, ClaudeWriteDelivery, compose_claude_user_frame,
};
use crate::driver::contract::error::DriverError;
use crate::driver::run_control::{ApplyInterventionResponse, SteerPayload, SteerTurnEndedError};
use crate::outbound_text::{OutboundText, OutboundTextOrigin};

impl ClaudeInterventions {
    // A steer's place is taken before anything is awaited: the session's fair lock is asked for
    // first and its files read beside it, so steers keep the order they were handed over in.
    pub(super) async fn steer(
        &self,
        run_id: RunId,
        message_id: QueueItemId,
        payload: SteerPayload,
    ) -> Result<ApplyInterventionResponse, DriverError> {
        let start = &self.writer.start;
        let session_id = match start.routes.route_of(run_id) {
            Some(ClaudeRunRoute::Lead { session_id, .. }) => session_id,
            Some(ClaudeRunRoute::Child(route)) => return self.steer_helper(route, payload).await,
            Some(ClaudeRunRoute::Apart) | None => return Err(no_live_run(run_id).into()),
        };
        let live = start
            .slots
            .live_session(session_id)
            .ok_or_else(|| no_live_run(run_id))?;
        let order = self.steer_order_for(session_id);
        let (place, attachment_blocks) = futures::join!(
            Arc::clone(&order).lock_owned(),
            compose_claude_attachment_blocks(
                &*start.attachments,
                &session_id,
                &payload.attachments
            )
        );
        let steer = ClaudeSteer {
            run_id,
            message_id,
            content: payload.content.as_str().to_owned(),
            attachment_blocks: attachment_blocks
                .map_err(|error| DriverError::Internal(Box::new(error)))?,
            is_priority: payload.is_priority,
        };
        let asks_closed = if steer.is_priority {
            self.requests.wait_asks_closed(session_id)
        } else {
            None
        };
        let steer = {
            let mut held = lock(&self.writer.held);
            if asks_closed.is_some() || held.is_holding(session_id) {
                if let (Some(hold), Some(closed)) = (held.hold(session_id, steer), asks_closed) {
                    self.writer.release_held_on_close(live, hold, closed, order);
                }
                return Ok(applied());
            }
            steer
        };
        let written = self.writer.write_steer(&live, steer).await;
        drop(place);
        written
    }

    // A helper's steer waits for the helper's next tool call or its finish, where the daemon's
    // hooks hand it over; its files reach it as lines naming their paths.
    async fn steer_helper(
        &self,
        route: ClaudeChildRunRoute,
        payload: SteerPayload,
    ) -> Result<ApplyInterventionResponse, DriverError> {
        let order = self.steer_order_for(route.session_id);
        let (place, attachments) = futures::join!(
            order.lock_owned(),
            resolve_message_attachments(
                &*self.writer.start.attachments,
                &route.session_id,
                &payload.attachments
            )
        );
        let words = compose_message_text(
            payload.content.as_str(),
            &attachments.map_err(DriverError::Internal)?,
        );
        lock(&self.helper_steers).push(route.session_id, &route.agent_id, words);
        drop(place);
        Ok(applied())
    }

    fn steer_order_for(&self, session_id: SessionId) -> Arc<tokio::sync::Mutex<()>> {
        Arc::clone(lock(&self.steer_order).entry(session_id).or_default())
    }
}

impl ClaudeSteerWriter {
    // Writes the rows a `Send now` held once the open asks close, in order, the first with its
    // `now` mark, after any steer already writing; dropped unwritten when the process ends first.
    fn release_held_on_close(
        &self,
        live: Arc<LiveClaudeSession>,
        hold: u64,
        closed: oneshot::Receiver<()>,
        order: Arc<tokio::sync::Mutex<()>>,
    ) {
        let writer = self.clone();
        tokio::spawn(async move {
            let is_closed = closed.await.is_ok();
            let place = order.lock_owned().await;
            let rows = lock(&writer.held).take_released(live.session_id, hold);
            if is_closed {
                writer.write_released(&live, rows, true).await;
            }
            drop(place);
        });
    }

    // Writes rows no caller waits on, in order, only the first keeping its `now` mark where
    // `keeps_priority`, since a later `now` would cut short the turn the first one starts; a row
    // whose run's turn ended meanwhile starts the session's next turn, and a failure is recorded.
    pub(super) async fn write_released(
        &self,
        live: &Arc<LiveClaudeSession>,
        rows: Vec<ClaudeSteer>,
        keeps_priority: bool,
    ) {
        for (index, mut row) in rows.into_iter().enumerate() {
            row.is_priority &= keeps_priority && index == 0;
            let message_id = row.message_id;
            let written = match self.write_steer(live, row.clone()).await {
                // No caller can take the row back for the run's next turn, so it opens one.
                Err(DriverError::SteerTurnEnded(_)) => {
                    self.send_as_next_turn(live.session_id, row).await.map(drop)
                }
                written => written.map(drop),
            };
            if let Err(error) = written {
                tracing::warn!(
                    session_id = %live.session_id,
                    %message_id,
                    error = &error as &(dyn std::error::Error + 'static),
                    "a held Claude Code steer could not be written"
                );
            }
        }
    }

    // Writes one steer into its run's turn, or sends it as the session's next turn when settling
    // the choice the run was held on ended the run.
    pub(super) async fn write_steer(
        &self,
        live: &Arc<LiveClaudeSession>,
        steer: ClaudeSteer,
    ) -> Result<ApplyInterventionResponse, DriverError> {
        let start = &self.start;
        let session_id = live.session_id;
        let stream = start.streams.get(session_id);
        if settle_claude_choice(
            &self.dialogs,
            live,
            steer.run_id,
            ClaudeChoiceSettling::QueuedMessage,
        )
        .await?
        {
            let delivered_run_id = self.send_as_next_turn(session_id, steer).await?;
            return Ok(ApplyInterventionResponse {
                delivered_run_id: Some(delivered_run_id),
                ..applied()
            });
        }
        // The run's turn may have ended while the steer waited for its place and its files; an
        // idle process would start a turn of its own with it.
        let is_routed = start
            .routes
            .lead_run_on(session_id)
            .is_some_and(|lead| lead.run_id == steer.run_id)
            && start
                .slots
                .live_session(session_id)
                .is_some_and(|current| Arc::ptr_eq(&current, live));
        if !is_routed {
            return Err(SteerTurnEndedError {
                run_id: steer.run_id,
            }
            .into());
        }
        let message_uuid = steer.message_id.to_string();
        if let (true, Some(stream)) = (steer.is_priority, &stream) {
            stream.mark_now_steer(&message_uuid);
        }
        // Recorded before the write, since Claude Code may report it taken first.
        lock(&start.prompts).record_written(session_id, steer.run_id, &message_uuid, true);
        let mut frame = compose_claude_user_frame(
            &OutboundText {
                text: steer.content,
                origin: OutboundTextOrigin::HumanText,
            },
            message_uuid.clone(),
            steer.attachment_blocks,
        );
        if steer.is_priority {
            frame.priority = Some(ClaudeMessagePriority::Now);
        }
        match live.channel.write_user_frame(frame).await {
            ClaudeWriteAttempt::Written => Ok(applied()),
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Unsent,
                cause,
            } => {
                lock(&start.prompts).record_dropped(session_id, &message_uuid);
                if let Some(stream) = &stream {
                    stream.unmark_now_steer(&message_uuid);
                }
                Err(ClaudeSessionError::InputUnwritable(cause).into())
            }
            ClaudeWriteAttempt::Failed {
                delivery: ClaudeWriteDelivery::Indeterminate,
                cause,
            } => Err(DriverError::Internal(Box::new(cause))),
        }
    }

    // Sends a steer as the session's next turn, its own run, once the ended run's turn is
    // released within the request deadline.
    async fn send_as_next_turn(
        &self,
        session_id: SessionId,
        steer: ClaudeSteer,
    ) -> Result<RunId, DriverError> {
        if !self
            .start
            .routes
            .when_turn_released(session_id, CLAUDE_REQUEST_DEADLINE)
            .await
        {
            return Err(turn_in_flight(session_id).into());
        }
        self.start
            .start_daemon_turn(
                session_id,
                ClaudeDaemonTurnOpening::Text {
                    text: OutboundText {
                        text: steer.content,
                        origin: OutboundTextOrigin::HumanText,
                    },
                    message_id: steer.message_id.to_string(),
                    attachment_blocks: steer.attachment_blocks,
                },
            )
            .await
    }
}
