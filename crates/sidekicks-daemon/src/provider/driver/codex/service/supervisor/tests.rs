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
