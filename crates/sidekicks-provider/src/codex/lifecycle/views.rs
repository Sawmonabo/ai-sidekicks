//! What each session's task shows of its record to the driver's reads that answer at once and so
//! cannot wait their turn on the task: the service and conversation the session runs on, its
//! account, folder, model and one live run, for its command list, a request's answer and its
//! name, and the tier it declared. The task updates a view after each item it handles, only where
//! it changed, and takes it away as it lets the record go.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex, MutexGuard};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::output_speed::ProviderOutputSpeedState;
use sidekicks_contracts::run::id::RunId;
use sidekicks_contracts::session::id::SessionId;

use crate::codex::commands::CodexCommandSource;
use crate::codex::service::supervisor::CodexService;
use crate::codex::session::state::CodexSessionRecord;
use sidekicks_std::mutex_lock::lock;

/// One live session's view.
struct CodexSessionView {
    service: Arc<CodexService>,
    thread_id: String,
    provider_account_id: Option<ProviderAccountId>,
    working_directory: PathBuf,
    model: String,
    run_id: Option<RunId>,
    declared_output_speed: Option<ProviderOutputSpeedState>,
}

/// A live session's conversation as its name is drawn and told: the service it is loaded on, the
/// conversation, the folder it runs in and the model it runs.
pub(crate) struct CodexConversationView {
    /// The service.
    pub(crate) service: Arc<CodexService>,
    /// The conversation.
    pub(crate) thread_id: String,
    /// The session's folder.
    pub(crate) working_directory: PathBuf,
    /// The session's model.
    pub(crate) model: String,
}

impl CodexSessionView {
    fn of(record: &CodexSessionRecord) -> Self {
        Self {
            service: Arc::clone(&record.service),
            thread_id: record.thread_id.clone(),
            provider_account_id: record.provider_account_id.clone(),
            working_directory: record.thread_settings.working_directory.clone(),
            model: record.thread_settings.model.clone(),
            run_id: record.sole_active_run(),
            declared_output_speed: record.declared_output_speed.clone(),
        }
    }

    fn shows(&self, record: &CodexSessionRecord) -> bool {
        Arc::ptr_eq(&self.service, &record.service)
            && self.thread_id == record.thread_id
            && self.provider_account_id == record.provider_account_id
            && self.working_directory == record.thread_settings.working_directory
            && self.model == record.thread_settings.model
            && self.run_id == record.sole_active_run()
            && self.declared_output_speed == record.declared_output_speed
    }
}

/// Every live session's view, for every session of one driver.
#[derive(Default)]
pub(crate) struct CodexSessionViews {
    /// Never held across an await.
    views: Mutex<HashMap<SessionId, CodexSessionView>>,
}

impl CodexSessionViews {
    /// Shows `record` as it stands, where its view changed.
    pub(crate) fn show(&self, record: &CodexSessionRecord) {
        let mut views = self.lock();
        if views
            .get(&record.session_id)
            .is_some_and(|view| view.shows(record))
        {
            return;
        }
        views.insert(record.session_id, CodexSessionView::of(record));
    }

    /// Takes `session_id`'s view away as its record is let go.
    pub(crate) fn remove(&self, session_id: SessionId) {
        self.lock().remove(&session_id);
    }

    /// What `session_id`'s command list is read from, `None` with no live record.
    pub(crate) fn command_source(&self, session_id: SessionId) -> Option<CodexCommandSource> {
        let views = self.lock();
        let view = views.get(&session_id)?;
        Some(CodexCommandSource {
            session_id,
            service: Arc::clone(&view.service),
            provider_account_id: view.provider_account_id.clone(),
            working_directory: view.working_directory.to_string_lossy().into_owned(),
            run_id: view.run_id,
        })
    }

    /// The service `session_id`'s conversation is loaded on, `None` with no live record.
    pub(crate) fn service(&self, session_id: SessionId) -> Option<Arc<CodexService>> {
        self.lock()
            .get(&session_id)
            .map(|view| Arc::clone(&view.service))
    }

    /// `session_id`'s conversation, `None` with no live record.
    pub(crate) fn conversation(&self, session_id: SessionId) -> Option<CodexConversationView> {
        self.lock()
            .get(&session_id)
            .map(|view| CodexConversationView {
                service: Arc::clone(&view.service),
                thread_id: view.thread_id.clone(),
                working_directory: view.working_directory.clone(),
                model: view.model.clone(),
            })
    }

    /// The tier `session_id`'s conversation last declared, `None` with no live record or no
    /// declaration.
    pub(crate) fn declared_output_speed(
        &self,
        session_id: SessionId,
    ) -> Option<ProviderOutputSpeedState> {
        self.lock()
            .get(&session_id)
            .and_then(|view| view.declared_output_speed.clone())
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<SessionId, CodexSessionView>> {
        lock(&self.views)
    }
}
