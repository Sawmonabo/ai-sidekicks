//! The config warnings one Codex service sends, which name no conversation and belong to every
//! session it holds. The service sends them again to each new connection, so each warning is kept
//! by its content with the sessions already told it: a resume, a reconnect or a late attach tells
//! a session only what it has not heard.

use std::collections::{HashMap, HashSet};

use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;

/// One service's config warnings and the sessions each was delivered to.
#[derive(Debug, Default)]
pub(crate) struct CodexConfigWarnings {
    /// The current connection's warnings, keyed by their JSON text, in arrival order.
    current: Vec<(String, Box<RawValue>)>,
    /// The sessions told each warning, by its JSON text; kept across connections.
    told_by_warning: HashMap<String, HashSet<SessionId>>,
}

impl CodexConfigWarnings {
    /// Starts a new connection's list: the service sends its warnings again to each connection.
    pub(crate) fn start_connection(&mut self) {
        self.current.clear();
    }

    /// Records a warning the service just sent and answers the sessions among `session_ids` that
    /// have not been told it, marking them told.
    pub(crate) fn record_warning(
        &mut self,
        params: Box<RawValue>,
        session_ids: &[SessionId],
    ) -> Vec<SessionId> {
        let key = params.get().to_owned();
        let told = self.told_by_warning.entry(key.clone()).or_default();
        let owed: Vec<SessionId> = session_ids
            .iter()
            .filter(|session_id| !told.contains(*session_id))
            .copied()
            .collect();
        told.extend(owed.iter().copied());
        // A warning sent again keeps its place and takes the newest params, as a map entry does.
        match self
            .current
            .iter_mut()
            .find(|(current_key, _)| *current_key == key)
        {
            Some((_, current_params)) => *current_params = params,
            None => self.current.push((key, params)),
        }
        owed
    }

    /// The current warnings a session has not been told, in arrival order, marking it told of
    /// each.
    pub(crate) fn take_owed(&mut self, session_id: &SessionId) -> Vec<Box<RawValue>> {
        let mut owed = Vec::new();
        for (key, params) in &self.current {
            let told = self.told_by_warning.entry(key.clone()).or_default();
            if told.insert(*session_id) {
                owed.push(params.clone());
            }
        }
        owed
    }

    /// Forgets a closed session, so a later session under its id hears every warning again.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        for told in self.told_by_warning.values_mut() {
            told.remove(session_id);
        }
    }
}
