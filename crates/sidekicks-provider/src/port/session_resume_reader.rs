//! How a driver reads what it needs to resume a sleeping session it holds nothing for in memory,
//! as after a daemon restart: the resume the session's stored record composes, with the timed
//! fires the idle sleep stored for it.

use std::error::Error;

use futures::future::BoxFuture;
use sidekicks_contracts::session::id::SessionId;

use crate::driver::session_control::ResumeSessionParams;

/// The stored resumes, registered through a `PortRegistration`.
pub trait SessionResumeReader: Send + Sync {
    /// `session_id`'s resume, composed as a restart composes it with its kept schedules, `None`
    /// for a session with no conversation to resume. Fails when the stored record cannot be read.
    fn read_resume(
        &self,
        session_id: SessionId,
    ) -> BoxFuture<'_, Result<Option<ResumeSessionParams>, Box<dyn Error + Send + Sync>>>;
}
