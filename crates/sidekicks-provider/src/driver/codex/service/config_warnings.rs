//! The config warnings one Codex service sends, which name no conversation and belong to every
//! session it holds, and the reading of its settings they are of. A process reads its settings
//! once, so a redial of the same process keeps its reading whole, and the service sends its
//! warnings again to a connection to a new process, a new reading. A session hears that a reading
//! began only where it says something: at its first attach since the daemon started, when the
//! daemon cannot know what its log still shows, and at a new reading where a notice stands on it,
//! a warning it was told or a crash loop's banner. Within one reading each warning is kept by its
//! content with the sessions already told it, so an attach tells a session only what it has not
//! heard.

use std::collections::{HashMap, HashSet};

use serde_json::value::RawValue;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_platforms::ProcessRecord;

/// One service's reading of its settings: the process it is of, its config warnings, the sessions
/// each was delivered to and the sessions the reading has begun for.
#[derive(Debug, Default)]
pub(crate) struct CodexConfigWarnings {
    /// The process the reading is of, `None` before the first connection or where the system could
    /// not read its record.
    reading_process: Option<ProcessRecord>,
    /// The current reading's warnings, keyed by their JSON text, in arrival order.
    current: Vec<(String, Box<RawValue>)>,
    /// The sessions told each warning on the current reading, by its JSON text.
    told_by_warning: HashMap<String, HashSet<SessionId>>,
    /// The sessions a reading has begun for since the daemon started, until each closes, with
    /// whether a notice stands on it.
    known: HashMap<SessionId, bool>,
}

impl CodexConfigWarnings {
    /// Starts a connection to `process`: a redial of the process the reading is of keeps it whole,
    /// and any other, an unread one included, begins a new reading, whose warnings the service
    /// sends again. Answers `None` for the redial, else the sessions among `attached` owed the new
    /// reading's start, those a notice stands on; a session not attached that a notice stands on
    /// is forgotten, so its next attach begins the reading.
    pub(crate) fn start_connection(
        &mut self,
        process: Option<ProcessRecord>,
        attached: &[SessionId],
    ) -> Option<Vec<SessionId>> {
        if process.is_some() && process == self.reading_process {
            return None;
        }
        self.reading_process = process;
        self.current.clear();
        self.told_by_warning.clear();
        let mut owed = Vec::new();
        self.known.retain(|session_id, is_standing| {
            if !*is_standing {
                return true;
            }
            *is_standing = false;
            let is_attached = attached.contains(session_id);
            if is_attached {
                owed.push(*session_id);
            }
            is_attached
        });
        Some(owed)
    }

    /// Records a warning the service just sent and answers the sessions among `session_ids` that
    /// have not been told it, marking them told and a notice standing on each.
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
        for session_id in &owed {
            self.known.insert(*session_id, true);
        }
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

    /// Begins the reading for a session that attaches: answers whether it is owed the reading's
    /// start, as a session first met since the daemon started is, then the current warnings it
    /// has not been told, in arrival order, marking it known and told of each.
    pub(crate) fn attach(&mut self, session_id: SessionId) -> (bool, Vec<Box<RawValue>>) {
        let is_owed_start = !self.known.contains_key(&session_id);
        let mut owed = Vec::new();
        for (key, params) in &self.current {
            let told = self.told_by_warning.entry(key.clone()).or_default();
            if told.insert(session_id) {
                owed.push(params.clone());
            }
        }
        let is_standing = self.known.entry(session_id).or_default();
        *is_standing |= !owed.is_empty();
        (is_owed_start, owed)
    }

    /// Marks a notice standing on `session_id` that the next reading's start ends, a crash loop's
    /// banner.
    pub(crate) fn mark_standing(&mut self, session_id: SessionId) {
        self.known.insert(session_id, true);
    }

    /// Forgets a closed session, so a later session under its id begins the reading and hears
    /// every warning again.
    pub(crate) fn forget_session(&mut self, session_id: &SessionId) {
        self.known.remove(session_id);
        for told in self.told_by_warning.values_mut() {
            told.remove(session_id);
        }
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use serde_json::value::to_raw_value;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_platforms::ProcessRecord;

    use super::CodexConfigWarnings;
    use crate::driver::test_registry::new_session_id;

    // A process record of the id `4242` started at `start`.
    fn process_record(start: u64) -> ProcessRecord {
        serde_json::from_value(json!({"id": 4242, "start": start, "boot": "a boot"}))
            .expect("a process record reads")
    }

    // A warning goes once per reading to each session, a redial of the same process keeps the
    // reading and tells no one again, and a new process begins a reading owed to the session a
    // warning stood on, which hears it again. Killed by keeping the told sessions across a new
    // process, by resetting them at a redial of the same one, and by an unread process taken for
    // the same one.
    #[test]
    fn a_new_process_tells_each_session_its_warnings_again() {
        let mut warnings = CodexConfigWarnings::default();
        let session_id = new_session_id();
        let warning = || {
            to_raw_value(&json!({"summary": "bad", "path": "/c/config.toml"}))
                .expect("a warning serializes")
        };
        let none = Vec::<SessionId>::new();
        assert_eq!(
            warnings.start_connection(Some(process_record(1)), &[]),
            Some(none.clone())
        );
        assert_eq!(
            warnings.record_warning(warning(), &[session_id]),
            [session_id]
        );
        assert_eq!(warnings.record_warning(warning(), &[session_id]), none);
        assert_eq!(
            warnings.start_connection(Some(process_record(1)), &[session_id]),
            None
        );
        assert_eq!(warnings.record_warning(warning(), &[session_id]), none);
        assert_eq!(
            warnings.start_connection(Some(process_record(2)), &[session_id]),
            Some(vec![session_id])
        );
        assert_eq!(
            warnings.record_warning(warning(), &[session_id]),
            [session_id]
        );
        assert_eq!(
            warnings.start_connection(None, &[session_id]),
            Some(vec![session_id])
        );
        assert_eq!(warnings.start_connection(None, &[session_id]), Some(none));
    }
}
