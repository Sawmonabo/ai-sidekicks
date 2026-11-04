//! Each account's kind of sign-in as last read from its row, kept in memory so a read past an
//! account's first costs no database read.
//!
//! - Every write that changes the kind drops the account's entry in its commit hook, which runs
//!   after the commit and before any caller hears, so no read after the write answers the old kind.
//! - A fill is stored only while no drop ran since its read began: a drop raises one generation, and
//!   a fill that saw an older one is refused, so a row read before a write never outlives it.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};

use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};
use sidekicks_contracts::wire::integer::SafeInt;
use sidekicks_std::mutex_lock::lock;
use sidekicks_store::database::statement::{StatementResult, WriteStatement};
use sidekicks_store::database::writer::messages::WriteJob;
use sidekicks_store::database::writer::{CommitHook, DatabaseWriter, WriteError};

/// The cached kind of sign-in of each account read, shared by the accounts reader and the
/// registry's writes that drop it.
#[derive(Debug, Default)]
pub struct ObservedAuthModes {
    state: Mutex<ObservedAuthModesState>,
}

#[derive(Debug, Default)]
struct ObservedAuthModesState {
    generation: u64,
    entries: HashMap<ProviderAccountId, Option<ProviderAuthMode>>,
}

/// What the cache holds for an account.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum ObservedAuthModeRead {
    /// The account's stored kind, `None` where none was read.
    Hit(Option<ProviderAuthMode>),
    /// No entry; a fill of the row read now passes `generation`.
    Miss {
        /// The drops counted when the miss was seen.
        generation: u64,
    },
}

impl ObservedAuthModes {
    /// The entry for `account_id`, or a miss carrying the generation a later fill passes.
    pub(crate) fn read(&self, account_id: &ProviderAccountId) -> ObservedAuthModeRead {
        let state = lock(&self.state);
        match state.entries.get(account_id) {
            Some(mode) => ObservedAuthModeRead::Hit(*mode),
            None => ObservedAuthModeRead::Miss {
                generation: state.generation,
            },
        }
    }

    /// Stores `mode` for `account_id` only while no drop ran since the miss that saw
    /// `seen_generation`; answers whether it was stored.
    pub(crate) fn fill(
        &self,
        account_id: ProviderAccountId,
        mode: Option<ProviderAuthMode>,
        seen_generation: u64,
    ) -> bool {
        let mut state = lock(&self.state);
        if state.generation != seen_generation {
            return false;
        }
        state.entries.insert(account_id, mode);
        true
    }

    /// Drops `account_id`'s entry and refuses every fill whose read began before now.
    pub(crate) fn forget(&self, account_id: &ProviderAccountId) {
        let mut state = lock(&self.state);
        state.generation = state.generation.wrapping_add(1);
        state.entries.remove(account_id);
    }

    /// Runs `statements` as one write that drops `account_id`'s entry once it commits, even when
    /// the caller stopped waiting; answers and fails as [`DatabaseWriter::write`] does.
    pub(crate) async fn write_and_forget(
        self: &Arc<Self>,
        writer: &DatabaseWriter,
        account_id: &ProviderAccountId,
        statements: Vec<WriteStatement>,
    ) -> Result<Vec<StatementResult>, WriteError> {
        let modes = Arc::clone(self);
        let account_id = account_id.clone();
        let hook: CommitHook = Box::new(move |_sequences: &[SafeInt<0>]| modes.forget(&account_id));
        let job = WriteJob {
            statements,
            events: Vec::new(),
        };
        Ok(writer.enqueue(job, Some(hook))?.await?.statement_results)
    }
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};

    use super::{ObservedAuthModeRead, ObservedAuthModes};

    // A row read before a write must not be stored after the write's drop: the fill carrying the
    // generation seen before the drop is refused and the next read misses. Killed by a fill
    // without the generation check.
    #[test]
    fn a_fill_whose_read_began_before_a_drop_is_refused() {
        let modes = ObservedAuthModes::default();
        let account_id = ProviderAccountId::new("a".repeat(32)).expect("an account id");
        let ObservedAuthModeRead::Miss { generation } = modes.read(&account_id) else {
            panic!("an empty cache misses");
        };

        modes.forget(&account_id);

        assert!(!modes.fill(
            account_id.clone(),
            Some(ProviderAuthMode::ApiKey),
            generation
        ));
        assert!(matches!(
            modes.read(&account_id),
            ObservedAuthModeRead::Miss { .. }
        ));
    }
}
