//! A one-turn copy's helpers, counted with its session's: the copy's own routing band holds its
//! running helpers, and its helper-limit hook is answered through the session's limit, so a start
//! past the limit waits until one of the session's helpers, on its own process or a copy, finishes,
//! and through the session's own message-target checks, so the person's stops and pauses hold on a
//! copy too.

use std::collections::HashSet;
use std::num::NonZeroUsize;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use tokio_util::task::TaskTracker;

use crate::driver::claude::frame_routing::{bind_thread, route_in_band};
use crate::driver::claude::hooks::callbacks::helper_calls::{
    ClaudeMessageTarget, check_message_target,
};
use crate::driver::claude::hooks::callbacks::{
    answer_claude_request, hook_agent_id, hooked_call_id, is_helper_tool_call, message_recipient,
    read_hook_input,
};
use crate::driver::claude::hooks::helper_limit::{
    ClaudeCountedProcess, ClaudeHelperLimit, ClaudeHelperProcess, ClaudeHelperStartAnswer,
    answer_admitted_starts,
};
use crate::driver::claude::hooks::pause::{ClaudeHookAnswer, ClaudeRunPauses};
use crate::driver::claude::hooks::registration::ClaudeHookCallback;
use crate::driver::claude::session::process::ClaudeStreamFrame;
use crate::driver::claude::session::process::account::ClaudeProcessAccount;
use crate::driver::claude::session::state::ClaudeSessionRoutingBand;
use crate::driver::claude::session::transport::channel::ClaudeProcessChannel;
use crate::driver::claude::session::transport::inbound::{
    ClaudeInboundRequest, ClaudeInboundRequestBody,
};
use crate::port::agent_tree_lookup::AgentTreeLookup;
use crate::thread_frame_router::SubagentLifecycleEventType;
use crate::usage_delta_accountant::ThreadBaseEstablishment;

/// The session's helper limit a one-turn copy counts under, the agent tree that says which of the
/// session's helpers a message from the copy wakes, the pauses and stops a message is checked
/// against, and the tasks the answers a freed slot admits run on.
#[derive(Clone)]
pub(crate) struct ClaudeSessionHelperCount {
    /// Every session's helper limit.
    pub(crate) limit: Arc<Mutex<ClaudeHelperLimit>>,
    /// The session's agent tree, once registered.
    pub(crate) agent_tree_lookup: Arc<PortRegistration<Arc<dyn AgentTreeLookup>>>,
    /// Every session's pauses and stopped helpers.
    pub(crate) pauses: Arc<Mutex<ClaudeRunPauses>>,
    /// The one-turn processes' tasks, which the daemon's stop waits for.
    pub(crate) tasks: TaskTracker,
}

/// One copy counted with its session's helpers, until [`Self::release`].
pub(crate) struct ClaudeCopyHelpers {
    count: ClaudeSessionHelperCount,
    session_id: SessionId,
    key: ClaudeCountedProcess,
    // Whose router holds the copy's running helpers, bound to the copy's own thread.
    band: Arc<Mutex<ClaudeSessionRoutingBand>>,
    channel: Arc<dyn ClaudeProcessChannel>,
    provider_account_id: ProviderAccountId,
    provider_session_id: String,
    // The helpers the copy started, which a message may wake once they ended.
    started_helpers: HashSet<String>,
}

impl ClaudeCopyHelpers {
    /// Counts the copy `provider_session_id` of `session_id`, answered on `channel` on `account`,
    /// with the session's helpers under the session's limit, or `limit` where the session has none
    /// counted yet.
    pub(crate) fn count(
        count: ClaudeSessionHelperCount,
        session_id: SessionId,
        limit: NonZeroUsize,
        channel: Arc<dyn ClaudeProcessChannel>,
        account: ClaudeProcessAccount,
        provider_session_id: String,
    ) -> Self {
        let mut band = ClaudeSessionRoutingBand::new();
        bind_thread(
            &mut band,
            &provider_session_id,
            ThreadBaseEstablishment::Fresh,
        );
        let band = Arc::new(Mutex::new(band));
        let provider_account_id = account
            .read()
            .expect("a one-turn copy is made on an account");
        let process = ClaudeHelperProcess {
            band: Arc::clone(&band),
            channel: Arc::clone(&channel),
            account,
        };
        let key = lock(&count.limit).count_copy(&session_id, limit, process);
        Self {
            count,
            session_id,
            key,
            band,
            channel,
            provider_account_id,
            provider_session_id,
            started_helpers: HashSet::new(),
        }
    }

    /// Routes `frame` through the copy's band, so the helpers it starts and ends count, hands the
    /// frame back, and answers the held starts that frees on any of the session's processes on a
    /// task of their own the daemon's stop waits for, so a stop that drops the copy's turn leaves
    /// none admitted unanswered.
    pub(crate) fn take_frame(&mut self, frame: ClaudeStreamFrame) -> ClaudeStreamFrame {
        let routed = route_in_band(
            &mut lock(&self.band),
            self.session_id,
            &self.provider_session_id,
            frame,
        );
        // A helper's frames its start released can end it too.
        let released =
            (routed.released_helper_frames.iter()).map(|(frame, observed)| (frame, observed));
        let mut admitted = Vec::new();
        for (frame, observed) in std::iter::once((&routed.frame, &routed.routed)).chain(released) {
            for emission in &observed.helper_lifecycle {
                if emission.event_type == SubagentLifecycleEventType::Started {
                    self.started_helpers.insert(emission.subagent_id.clone());
                }
            }
            admitted.extend(lock(&self.count.limit).observe_lifecycle(
                &self.session_id,
                self.key,
                &observed.helper_lifecycle,
                &frame.observation.answered_call_ids,
            ));
        }
        if !admitted.is_empty() {
            let session_id = self.session_id;
            self.count
                .tasks
                .spawn(async move { answer_admitted_starts(&session_id, admitted).await });
        }
        routed.frame
    }

    /// Answers `asked` where it is the helper-limit hook's callback, and hands back any other
    /// request: a helper start, or a message that wakes an ended helper, is let through while the
    /// session has room and held otherwise; a message the session's own message-target checks deny
    /// is denied in their words and takes no slot, and any other call passes. A message's check
    /// reads the session's agent tree inside the copy's arrivals loop, as the session's own process
    /// reads it inside its own, so the copy's frames behind it, one that frees a slot among them,
    /// wait for that read.
    pub(crate) async fn take_request(
        &self,
        asked: ClaudeInboundRequest,
    ) -> Option<ClaudeInboundRequest> {
        let ClaudeInboundRequestBody::HookCallback(callback) = &asked.body else {
            return Some(asked);
        };
        let hook = callback
            .callback_id
            .as_deref()
            .and_then(ClaudeHookCallback::of);
        if hook != Some(ClaudeHookCallback::HelperLimit) {
            return Some(asked);
        }
        let input = read_hook_input(callback);
        let tool_use_id =
            hooked_call_id(callback, input.as_ref()).unwrap_or_else(|| asked.request_id.clone());
        let is_counted = if is_helper_tool_call(input.as_ref()) {
            Ok(true)
        } else if let Some(to) = message_recipient(input.as_ref()) {
            let agent_id = hook_agent_id(input.as_ref());
            self.wakes_ended_helper(agent_id.as_deref(), &to).await
        } else {
            Ok(false)
        };
        let answer = match is_counted {
            Ok(true) => {
                let start = lock(&self.count.limit).answer_start(
                    &self.session_id,
                    self.key,
                    &asked.request_id,
                    &tool_use_id,
                );
                match start {
                    ClaudeHelperStartAnswer::Admit => ClaudeHookAnswer::Pass,
                    ClaudeHelperStartAnswer::Hold => return None,
                }
            }
            Ok(false) => ClaudeHookAnswer::Pass,
            Err(denial) => denial,
        };
        answer_claude_request(
            &*self.channel,
            &self.session_id,
            &self.provider_account_id,
            asked.request_id,
            &answer,
        )
        .await;
        None
    }

    // Whether a message to `to` by the copy's helper `agent_id` or its lead wakes an ended helper,
    // which Claude Code runs again in the copy, once the session's own message-target checks let it
    // through: one not running in the copy whose transcript the copy holds, a helper the copy
    // started or one the session's agent tree holds. The checks' denial where they deny it.
    async fn wakes_ended_helper(
        &self,
        agent_id: Option<&str>,
        to: &str,
    ) -> Result<bool, ClaudeHookAnswer> {
        let stored = match check_message_target(
            self.count.agent_tree_lookup.port().cloned(),
            &self.count.pauses,
            &self.session_id,
            agent_id,
            to,
        )
        .await
        {
            ClaudeMessageTarget::Denied(denial) => return Err(denial),
            ClaudeMessageTarget::Unread(reason) => return Err(ClaudeHookAnswer::Deny { reason }),
            ClaudeMessageTarget::Open(stored) => stored,
        };
        if lock(&self.band).router.child_attribution_for(to).is_some() {
            return Ok(false);
        }
        Ok(self.started_helpers.contains(to) || stored.is_some())
    }

    /// Drops the start the copy's request `request_id` held, which Claude Code withdrew.
    pub(crate) fn withdraw(&self, request_id: &str) {
        lock(&self.count.limit).withdraw_start(&self.session_id, self.key, request_id);
    }

    /// Stops counting the copy, whose process ended with its helpers: its held starts go with it,
    /// and the held starts of the session's other processes its room admits are answered.
    pub(crate) async fn release(self) {
        let admitted = lock(&self.count.limit).forget_process(&self.session_id, self.key);
        answer_admitted_starts(&self.session_id, admitted).await;
    }
}
