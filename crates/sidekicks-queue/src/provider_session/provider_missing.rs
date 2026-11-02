//! The `providerMissing` notice a start posts on its session when no driver answers the session's
//! provider, or the driver finds the provider not installed where the session runs: no process
//! started, and every client reads why from the notice. The start's own failure stands.

use std::error::Error;

use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::controls::events::SessionNotice;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::contract::error::DriverError;
use sidekicks_session::directory::lookups::read_session_place;
use sidekicks_store::database::connection::read_pool::ReadLength;

use super::ProviderSessions;
use super::controls::NoticeWriteError;
use super::errors::ProviderSessionError;

impl ProviderSessions {
    /// Answers `failed`, why a start of `session_id` on `provider` failed, once the session's
    /// `providerMissing` notice is posted where `failed` says the provider is missing. Answers
    /// [`ProviderSessionError::ProviderMissingNotPosted`], carrying `failed`, when the post fails.
    pub(super) async fn answer_failed_start(
        &self,
        session_id: SessionId,
        provider: &ProviderId,
        failed: ProviderSessionError,
    ) -> ProviderSessionError {
        if !is_provider_missing(&failed) {
            return failed;
        }
        match self.post_provider_missing(session_id, provider).await {
            Ok(()) => failed,
            Err(posted) => ProviderSessionError::ProviderMissingNotPosted {
                session_id,
                start: Box::new(failed),
                posted,
            },
        }
    }

    // Posts the session's `providerMissing` notice, naming where it runs, in a write kept only
    // while the session has a directory row; a session gone since the start takes none. Fails as
    // the read of its place or the notice's write fails.
    async fn post_provider_missing(
        &self,
        session_id: SessionId,
        provider: &ProviderId,
    ) -> Result<(), Box<dyn Error + Send + Sync>> {
        let place = self
            .deps
            .pool
            .read(ReadLength::Short, move |reader| {
                Ok::<_, ProviderSessionError>(read_session_place(reader, &session_id)?)
            })
            .await?;
        let notice = SessionNotice::ProviderMissing {
            session_id,
            provider: provider.clone(),
            place,
        };
        match self
            .append_notice(session_id, notice, Vec::new(), None)
            .await
        {
            Ok(()) => Ok(()),
            Err(NoticeWriteError::Refused(refusal))
                if refusal.code == RefusalCode::SessionNotFound =>
            {
                Ok(())
            }
            Err(failure) => Err(Box::new(failure)),
        }
    }
}

// Whether a start failed because the session's provider is missing: no driver answers it, or its
// driver found no installed build of the bare command name it searched for. A typed path that does
// not run, or a build found that cannot start, is installed.
fn is_provider_missing(failed: &ProviderSessionError) -> bool {
    matches!(
        failed,
        ProviderSessionError::Provider(refusal) if refusal.code == RefusalCode::ProviderNotFound
    ) || matches!(
        failed,
        ProviderSessionError::Driver(DriverError::ExecutableUnresolvable(unresolvable))
            if unresolvable.is_not_installed()
    )
}
