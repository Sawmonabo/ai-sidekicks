//! The move of the bindings a moved lead's helpers ride onto the account the lead landed on, so no
//! helper is left spending the account the lead left.

use std::collections::HashSet;
use std::error::Error;
use std::sync::Arc;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_provider::runtime_binding::store::read_bindings_of_runs;
use sidekicks_session::agent_tree::sweep::{DescendantStop, SweepRoot, read_descendants};
use sidekicks_store::database::connection::read_pool::ReadLength;
use sidekicks_store::events::session::read::session_read_bound;

use super::{AccountSwitch, LandingLead, SessionLeadsReadError};

impl AccountSwitch {
    // Moves onto `to` each binding of `lead`'s provider that a live or interrupted agent below its
    // session's lead runs rides: a helper the binding of the run it runs under, which an earlier
    // lead run may have left it on, and a bridged or workflow run its own. A binding already on
    // `to`, the lead's own among them, is left; a failed read or move is logged, the rest moving.
    pub(super) async fn move_child_bindings(&self, lead: &LandingLead, to: &ProviderAccountId) {
        let session_id = lead.session_id;
        let provider = lead.lead.binding.provider_name.clone();
        let damaged_from = Arc::clone(&self.deps.read_damaged_from_sequence);
        let target = to.clone();
        let read = self
            .deps
            .reads
            .read(
                ReadLength::Long,
                move |reader| -> Result<_, SessionLeadsReadError> {
                    let read_bound = session_read_bound(&*damaged_from, &session_id, None);
                    let ridden: HashSet<_> = read_descendants(
                        reader,
                        &session_id,
                        &SweepRoot::Session,
                        None,
                        read_bound,
                    )?
                    .into_iter()
                    .map(|descendant| match descendant.stop {
                        DescendantStop::Run { run_id } => run_id,
                        DescendantStop::Helper {
                            carrying_run_id, ..
                        } => carrying_run_id,
                    })
                    .collect();
                    let ridden: Vec<_> = ridden.into_iter().collect();
                    Ok(read_bindings_of_runs(reader, &ridden)?
                        .into_iter()
                        .filter(|binding| {
                            binding.provider_name == provider
                                && binding.spawn_config.provider_account_id != target
                        })
                        .map(|binding| binding.id)
                        .collect::<Vec<_>>())
                },
            )
            .await;
        let binding_ids = match read {
            Ok(binding_ids) => binding_ids,
            Err(error) => {
                tracing::warn!(
                    %session_id,
                    error = &error as &(dyn Error + 'static),
                    "the bindings a switched session's helpers ride were not read, so they stay"
                );
                return;
            }
        };
        for binding_id in binding_ids {
            if let Err(error) = self
                .deps
                .bindings
                .move_account(binding_id, to.clone())
                .await
            {
                tracing::warn!(
                    %session_id,
                    error = &*error as &(dyn Error + 'static),
                    "a binding a switched session's helper rides stayed on the account it left"
                );
            }
        }
    }
}
