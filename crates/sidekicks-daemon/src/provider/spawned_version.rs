//! The spawned build's version: the configured command resolved to one build, and the version that
//! build reports in-band through its driver's handshake, so a binding row names the build that ran
//! and never a launcher's idea of it.

use std::path::PathBuf;

use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_platforms::ProgramStart;

use crate::provider::driver::contract::DriverError;

/// The one build a spawn and its binding row both name, resolved from the configured command.
#[expect(
    dead_code,
    reason = "each driver's capability read and session start read the spawned build's version \
              through it"
)]
pub(crate) struct ResolvedProviderExecutable {
    /// The command as configured: a bare name or a path.
    pub(crate) requested_command: String,
    /// The build's absolute, symlink-resolved path, recorded as what ran.
    pub(crate) resolved_executable_path: PathBuf,
    /// What the system starts to run the build, with no shell.
    pub(crate) start: ProgramStart,
    /// The child's whole environment, the provider's auto-update opt-out applied.
    pub(crate) environment: Vec<(String, String)>,
}

/// What one zero-turn version handshake needs: the provider, its build as resolved, and the client
/// name the handshake sends, which a provider may echo beside its own version.
#[expect(
    dead_code,
    reason = "each driver's capability read and session start read the spawned build's version \
              through it"
)]
pub(crate) struct ProviderVersionHandshakeRequest {
    /// The provider.
    pub(crate) provider: ProviderId,
    /// The build to start, never the configured name.
    pub(crate) executable: ResolvedProviderExecutable,
    /// The client name sent, with no `/` or whitespace.
    pub(crate) client_name: &'static str,
}

/// A driver's zero-turn version handshake: starts the request's build as resolved, under a
/// deadline the driver owns, and answers the version text its own reader took from the reply. It
/// fails with the driver's error when the build cannot be started or does not answer.
#[expect(
    dead_code,
    reason = "each driver's capability read and session start read the spawned build's version \
              through it"
)]
pub(crate) trait ProviderVersionHandshake:
    AsyncFnOnce(&ProviderVersionHandshakeRequest) -> Result<String, DriverError>
{
}

impl<Handshake> ProviderVersionHandshake for Handshake where
    Handshake: AsyncFnOnce(&ProviderVersionHandshakeRequest) -> Result<String, DriverError>
{
}
