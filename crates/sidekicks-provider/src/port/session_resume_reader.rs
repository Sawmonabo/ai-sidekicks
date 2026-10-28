//! How a driver reads what it needs to resume a sleeping session it holds nothing for in memory,
//! as after a daemon restart: the resume the session's stored record composes and the schedules
//! the idle sleep stored for it.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::idle_sleep::KeptSchedule;
use crate::driver::session_control::ResumeSessionParams;

/// A sleeping session's resume and its kept schedules, as the daemon stored them.
#[derive(Clone)]
pub struct SessionResume {
    /// The resume of the session's conversation, composed as a restart composes it.
    pub params: ResumeSessionParams,
    /// The timed fires the provider kept for the session when it was last awake.
    pub schedules: Vec<KeptSchedule>,
}

/// The stored resumes, registered through a `PortRegistration`.
pub trait SessionResumeReader: Send + Sync {
    /// `session_id`'s resume and kept schedules, `None` for a session with no live binding to
    /// resume. Fails when the stored record cannot be read.
    fn read_resume(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<SessionResume>, Box<dyn Error + Send + Sync>>>;
}
