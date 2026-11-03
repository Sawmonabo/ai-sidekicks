//! What a caller waiting on a Codex service's start is refused with: a start's own typed refusal
//! passed through as it was raised, any other start failure as the service being unavailable.

use std::sync::Arc;

use sidekicks_ipc::domain_error::DomainError;

use crate::driver::codex::session::errors::CodexError;
use crate::driver::contract::error::DriverError;

/// A start's failure shared by every caller that waited on it.
#[derive(Debug, thiserror::Error)]
#[error(transparent)]
pub(crate) struct SharedCodexError(
    /// The failure, as the start raised it.
    pub(crate) Arc<CodexError>,
);

/// What a caller that waited on a start reads of its `failure`: a refusal a client reads by its
/// code, such as no current account or an API key that could not be read, keeps its code, the
/// shared failure kept as its cause; every other failure reads as the service not starting.
pub(crate) fn start_failure(failure: Arc<CodexError>) -> CodexError {
    if let CodexError::Driver(DriverError::Refused(refusal)) = &*failure {
        return CodexError::Driver(DriverError::from(DomainError {
            message: refusal.message.clone(),
            code: refusal.code,
            detail: refusal.detail.clone(),
            source: Some(Box::new(SharedCodexError(Arc::clone(&failure)))),
        }));
    }
    CodexError::Transport {
        detail: "The Codex service could not be started.".to_owned(),
        cause: Some(Box::new(SharedCodexError(failure))),
    }
}

/// The refusal of a service that ended too many times in a short window.
pub(crate) fn crash_loop_refusal() -> CodexError {
    CodexError::Transport {
        detail: "The Codex service ended too many times in a short window and was not restarted."
            .to_owned(),
        cause: None,
    }
}

/// The refusal of a service shut down with the daemon.
pub(crate) fn shut_down_refusal() -> CodexError {
    CodexError::Transport {
        detail: "The Codex service was shut down with the daemon.".to_owned(),
        cause: None,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
    use sidekicks_ipc::domain_error::DomainError;

    use super::start_failure;
    use crate::driver::codex::session::errors::CodexError;
    use crate::driver::contract::error::DriverError;

    // Killed by every start failure read as the service not starting: the typed refusal of a
    // start with no current account would reach the caller as `provider.unavailable`.
    #[test]
    fn a_start_refused_with_a_typed_code_keeps_its_code() {
        let refused = Arc::new(CodexError::Driver(DriverError::from(DomainError::new(
            "No Codex account is current.",
            RefusalCode::ProviderAccountNotAuthenticated,
        ))));

        let failure = start_failure(refused);

        assert!(
            matches!(
                &failure,
                CodexError::Driver(DriverError::Refused(refusal))
                    if refusal.code == RefusalCode::ProviderAccountNotAuthenticated
            ),
            "{failure:?}"
        );
    }
}
