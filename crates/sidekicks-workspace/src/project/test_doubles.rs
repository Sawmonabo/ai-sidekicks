//! Doubles of the ports a project's services take, shared by the tests of the project service,
//! its list feed and the clone service.

use std::error::Error;

use futures::FutureExt as _;
use futures::future::BoxFuture;
use rusqlite::Connection;
use sidekicks_contracts::machine::settings::MachineSettings;
use sidekicks_contracts::project::ProjectId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::stream::feed::{SendGate, SubscriptionClosed};

use crate::machine_settings::MachineSettingsReader;
use crate::project::records::{ProjectSessionActivity, ProjectSessionFacts};
use crate::project::service::ForgottenProjectSessions;

/// No session counts in any project, for tests that read only the project rows.
pub(crate) struct NoSessions;

impl ProjectSessionActivity for NoSessions {
    fn read_session_facts(
        &self,
        _reader: &Connection,
        _project_ids: Option<&[ProjectId]>,
    ) -> rusqlite::Result<Vec<ProjectSessionFacts>> {
        Ok(Vec::new())
    }
}

/// A port the test never reaches: it detaches nothing and reads no machine settings, so a call
/// fails the test's step.
pub(crate) struct Unreached;

impl ForgottenProjectSessions for Unreached {
    fn archive_of_forgotten_project(
        &self,
        _session_id: SessionId,
    ) -> BoxFuture<'_, Result<(), Box<dyn Error + Send + Sync>>> {
        async { Err("no test archives a session".into()) }.boxed()
    }
}

impl MachineSettingsReader for Unreached {
    fn read_machine_settings(
        &self,
    ) -> BoxFuture<'_, Result<MachineSettings, Box<dyn Error + Send + Sync>>> {
        async { Err("no test reads the machine's settings".into()) }.boxed()
    }
}

/// A gate always open, so a feed sends what it holds.
pub(crate) struct OpenGate;

impl SendGate for OpenGate {
    fn ready(&self) -> BoxFuture<'_, Result<(), SubscriptionClosed>> {
        async { Ok(()) }.boxed()
    }
}
