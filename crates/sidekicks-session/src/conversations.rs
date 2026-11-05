//! The provider conversations a session ran on, each with the recovery data that names the home
//! holding it, read for the whole-session purge and the memory switch.

pub mod purge;

use std::collections::HashSet;

use rusqlite::Connection;
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_provider::driver::session_control::SessionConversation;
use sidekicks_provider::left_conversations::read_left_conversations;

use crate::run::stored_leg::read_session_bindings;

/// The statements [`read_session_conversations`] prepares on a read connection: the session's
/// runs, their bindings and the conversations the session left.
pub const SESSION_CONVERSATIONS_STATEMENT_CAPACITY: usize = 3;

/// Each provider's conversations `session_id` ran on, newest first, in one read snapshot: the ones
/// its bindings name, latest write first, then the ones it left, latest left first. A conversation
/// is listed once, and the providers keep the order each was first met in. A bound conversation
/// carries its binding's recovery data, and a left one its provider's latest binding's. Fails when
/// the read fails.
pub fn read_session_conversations(
    reader: &Connection,
    session_id: SessionId,
) -> rusqlite::Result<Vec<(ProviderId, Vec<SessionConversation>)>> {
    let snapshot = reader.unchecked_transaction()?;
    let mut bound: Vec<_> = read_session_bindings(&snapshot, session_id)?
        .into_iter()
        .filter_map(|binding| {
            let resume_handle = binding.resume_handle.filter(|handle| !handle.is_empty())?;
            Some((
                binding.updated_at,
                binding.provider_name,
                resume_handle,
                binding.spawn_config.provider_account_id,
                binding.runtime_metadata,
            ))
        })
        .collect();
    bound.sort_by(|first, second| second.0.cmp(&first.0));
    let latest_recovery_data = |provider: &ProviderId| {
        bound
            .iter()
            .find(|(_, bound_provider, ..)| bound_provider == provider)
            .map(|(.., runtime_metadata)| runtime_metadata.clone())
            .unwrap_or_default()
    };
    let mut left = read_left_conversations(&snapshot, &session_id)?;
    left.reverse();
    let left: Vec<_> = left
        .into_iter()
        .map(|record| {
            let runtime_metadata = latest_recovery_data(&record.provider_name);
            (
                record.provider_name,
                record.conversation.conversation_id,
                record.conversation.provider_account_id,
                runtime_metadata,
            )
        })
        .collect();

    let mut by_provider: Vec<(ProviderId, Vec<SessionConversation>)> = Vec::new();
    let mut listed: HashSet<(ProviderId, String)> = HashSet::new();
    let conversations = bound
        .into_iter()
        .map(|(_, provider, resume_handle, account, runtime_metadata)| {
            (provider, resume_handle, account, runtime_metadata)
        })
        .chain(left);
    for (provider, resume_handle, provider_account_id, runtime_metadata) in conversations {
        if !listed.insert((provider.clone(), resume_handle.clone())) {
            continue;
        }
        let conversation = SessionConversation {
            resume_handle,
            provider_account_id,
            runtime_metadata,
        };
        match by_provider
            .iter_mut()
            .find(|(listed, _)| *listed == provider)
        {
            Some((_, conversations)) => conversations.push(conversation),
            None => by_provider.push((provider, vec![conversation])),
        }
    }
    Ok(by_provider)
}
