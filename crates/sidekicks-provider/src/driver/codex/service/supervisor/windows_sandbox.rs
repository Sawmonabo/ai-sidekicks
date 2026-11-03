//! The service's answer to whether it may run a sandboxed command on Windows.

use serde::Deserialize;
use serde_json::value::RawValue;

use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::transport::connection::read_codex_object;

/// The ask that reads whether the service may run a sandboxed command on Windows.
const WINDOWS_SANDBOX_READINESS_METHOD: &str = "windowsSandbox/readiness";

/// What `windowsSandbox/readiness` says of the service's sandbox.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum CodexWindowsSandboxReadiness {
    /// The sandbox runs commands.
    Ready,
    /// It is not set up, or the reply named a status this daemon does not know.
    NotConfigured,
    /// It needs an update first.
    UpdateRequired,
}

// The member of a `windowsSandbox/readiness` reply the read reads.
#[derive(Deserialize)]
struct WindowsSandboxReadinessReply {
    status: Option<Box<RawValue>>,
}

impl CodexService {
    /// Whether the service's Windows sandbox runs commands: only `Ready` offers it; a status this
    /// daemon does not know reads as not configured, never as ready. Fails as the request does.
    #[expect(
        dead_code,
        reason = "the sandboxed permission level's check asks the service on Windows"
    )]
    pub(crate) async fn read_windows_sandbox_readiness(
        &self,
    ) -> Result<CodexWindowsSandboxReadiness, CodexError> {
        let reply = self
            .connection()?
            .request(WINDOWS_SANDBOX_READINESS_METHOD, &())
            .await?;
        Ok(read_windows_sandbox_readiness(&reply))
    }
}

/// The readiness a `windowsSandbox/readiness` reply names.
fn read_windows_sandbox_readiness(reply: &RawValue) -> CodexWindowsSandboxReadiness {
    let status = read_codex_object::<WindowsSandboxReadinessReply>(reply.get())
        .and_then(|reply| reply.status)
        .and_then(|status| serde_json::from_str::<String>(status.get()).ok());
    match status.as_deref() {
        Some("ready") => CodexWindowsSandboxReadiness::Ready,
        Some("updateRequired") => CodexWindowsSandboxReadiness::UpdateRequired,
        Some(_) | None => CodexWindowsSandboxReadiness::NotConfigured,
    }
}

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::value::RawValue;

    use super::{CodexWindowsSandboxReadiness, read_windows_sandbox_readiness};

    // Fails when a status Codex did not name as ready, or one this daemon does not know, reads as
    // ready, which would offer a sandbox that cannot run a command.
    #[rstest]
    #[case::ready(r#"{"status":"ready"}"#, CodexWindowsSandboxReadiness::Ready)]
    #[case::not_configured(
        r#"{"status":"notConfigured"}"#,
        CodexWindowsSandboxReadiness::NotConfigured
    )]
    #[case::update_required(
        r#"{"status":"updateRequired"}"#,
        CodexWindowsSandboxReadiness::UpdateRequired
    )]
    #[case::an_unknown_status(
        r#"{"status":"warmingUp"}"#,
        CodexWindowsSandboxReadiness::NotConfigured
    )]
    #[case::no_status(r"{}", CodexWindowsSandboxReadiness::NotConfigured)]
    fn the_windows_sandbox_offers_only_on_ready(
        #[case] reply: &str,
        #[case] readiness: CodexWindowsSandboxReadiness,
    ) {
        let reply = RawValue::from_string(reply.to_owned()).expect("the reply is JSON");

        assert_eq!(read_windows_sandbox_readiness(&reply), readiness);
    }
}
