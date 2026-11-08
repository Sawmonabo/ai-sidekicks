//! The receipt of the sign-in and sign-out commands: the governance mutations' key, lock, digest
//! and saved check, a `pending` intent begun before the command acts, and its answer committed in
//! the form the command saves. A command writes no provider config and no daemon row, so a
//! receipt a stop left `pending` is expired and a retry under its key runs the command again.

use std::error::Error;
use std::future::Future;
use std::sync::Arc;

use futures::future::BoxFuture;
use serde::Serialize;
use serde_json::Value;
use sidekicks_contracts::mcp::governance::{McpServerSignIn, McpServerSignOut};
use sidekicks_contracts::mcp::server::McpServerBindingRef;
use sidekicks_contracts::method::Method;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::registry::HandlerError;

use super::{McpMutationService, McpMutationStart, McpReceiptOperation};
use crate::binding::store::McpBindingKey;
use crate::mutation::receipts::{McpIntentReceipt, McpMutationReceipts, McpReceiptKey};
use crate::mutation::reconciler::McpIntentSettlement;
use crate::mutation::saved_answer::McpSavedAnswer;
use crate::mutation::settle::{McpIntentSettler, commit_refusal, saved_value, store_unavailable};

/// A receipted command, as its receipt names it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum McpCommand {
    /// `mcp.server.signIn`.
    SignIn,
    /// `mcp.server.signOut`.
    SignOut,
}

impl McpCommand {
    /// The wire method the command's receipts are spent on.
    pub(crate) fn method(self) -> &'static str {
        match self {
            Self::SignIn => McpServerSignIn::DESCRIPTOR.method,
            Self::SignOut => McpServerSignOut::DESCRIPTOR.method,
        }
    }
}

/// What a command answers: the response it serves now, and the one its receipt saves for a retry
/// under the same key, which leaves out what must never be stored.
pub(crate) struct McpCommandAnswer {
    /// The response, as it goes on the wire.
    pub(crate) served: Value,
    /// The response a retry under the key is answered with.
    pub(crate) saved: Value,
}

impl McpMutationService {
    /// Runs `act` once for `idempotency_key` under the key's lock, its intent on `binding` begun
    /// before and its answer saved after, and answers a retry with the same `request` from the
    /// saved answer without running `act`. Refuses `mcp.server.idempotencyConflict` where the key
    /// was spent on another request and `mcp.bindingStoreUnavailable` where the receipts or the
    /// receipt key cannot be used, a commit failing after `act` leaving the receipt `pending`; a
    /// refusal `act` answers is saved, while a fault or a cancel expires the receipt and passes
    /// through.
    pub(crate) async fn run_command<Act, ActFuture>(
        &self,
        command: McpCommand,
        idempotency_key: &ClientUuid,
        request: &impl Serialize,
        binding: &McpServerBindingRef,
        act: Act,
    ) -> Result<Value, HandlerError>
    where
        Act: FnOnce() -> ActFuture,
        ActFuture: Future<Output = Result<McpCommandAnswer, HandlerError>>,
    {
        let (request_digest, _hold) = match self
            .start(
                McpReceiptOperation::Command(command),
                idempotency_key,
                request,
                binding,
            )
            .await?
        {
            McpMutationStart::Answered(answer) => return Ok(answer),
            McpMutationStart::Fresh {
                request_digest,
                hold,
                ..
            } => (request_digest, hold),
        };
        let receipts = &self.parts.receipts;
        let intent = McpIntentReceipt {
            idempotency_key: idempotency_key.clone(),
            operation: command.method().to_owned(),
            binding: McpBindingKey::of(binding),
            request_digest,
            before_digest: None,
            after_digest: None,
            wanted_enabled: None,
        };
        receipts.begin(&intent).await.map_err(store_unavailable)?;
        match act().await {
            Ok(McpCommandAnswer { served, saved }) => {
                receipts
                    .commit(
                        idempotency_key,
                        &saved_value(&McpSavedAnswer::Served { response: saved }),
                        Vec::new(),
                    )
                    .await
                    .map_err(store_unavailable)?;
                Ok(served)
            }
            Err(HandlerError::Refused(refusal)) => {
                commit_refusal(receipts, idempotency_key, refusal)
                    .await
                    .map_err(HandlerError::from)
            }
            Err(error @ (HandlerError::Internal(_) | HandlerError::Canceled)) => {
                // A receipt left behind is expired by the next retry or pass, so the fault stands.
                if let Err(expiry) = receipts.expire(idempotency_key).await {
                    tracing::warn!(
                        error = &expiry as &(dyn Error + 'static),
                        operation = command.method(),
                        "a failed MCP command's receipt could not be expired, so it waits for the \
                         next retry or pass"
                    );
                }
                Err(error)
            }
        }
    }
}

/// A command's settler, run by the pass over the `pending` receipts: the command's receipt is
/// expired, since nothing it did outlives the daemon's stop or would be harmed by running again.
pub(super) struct McpCommandSettler {
    /// The receipts the `pending` one is expired in.
    pub(super) receipts: McpMutationReceipts,
}

impl McpIntentSettler for McpCommandSettler {
    fn settle(
        &self,
        intent: McpIntentReceipt,
        _key: Arc<McpReceiptKey>,
    ) -> BoxFuture<'_, McpIntentSettlement> {
        Box::pin(async move {
            match self.receipts.expire(&intent.idempotency_key).await {
                Ok(()) => McpIntentSettlement::Unlanded,
                Err(error) => {
                    tracing::warn!(
                        error = &error as &(dyn Error + 'static),
                        operation = intent.operation.as_str(),
                        "an unfinished MCP command's receipt could not be expired, so the next \
                         pass tries again"
                    );
                    McpIntentSettlement::Unsettled
                }
            }
        })
    }
}

#[cfg(test)]
mod tests;
