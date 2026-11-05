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
/// carries its binding's recovery data, and a left one the data kept when the session left it.
/// Fails when the read fails.
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
    let mut left = read_left_conversations(&snapshot, &session_id)?;
    left.reverse();
    let left = left.into_iter().map(|record| {
        (
            record.provider_name,
            record.conversation.conversation_id,
            record.conversation.provider_account_id,
            record.conversation.runtime_metadata,
        )
    });

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

#[cfg(test)]
mod tests {
    use serde_json::{Map, json};
    use sidekicks_contracts::run::id::RunId;
    use sidekicks_contracts::wire::id::mint_uuid_v7;
    use sidekicks_provider::driver::session_control::SessionConversation;
    use sidekicks_provider::left_conversations::LeftConversation;
    use sidekicks_provider::runtime_binding::store::{
        CreateRuntimeBindingInput, RuntimeBindingPatch,
    };
    use sidekicks_provider::runtime_binding::test_store::{
        binding_input, open_store, spawn_config_on, spawned_build, test_provider_account_id,
    };
    use sidekicks_store::database::writer::test_file::{TestDatabase, test_session_id};

    use super::read_session_conversations;
    use crate::run::engine::test_fixture::insert_running_run;
    use crate::run::schema::schema_parts;

    // Killed by a left row's insert that takes the binding row's data, and by a read that hands a
    // left conversation its provider's latest binding's data: either gives `conversation-1` `{}`.
    #[tokio::test]
    async fn a_left_conversation_keeps_the_home_it_was_left_in() {
        let database = TestDatabase::new(schema_parts());
        let store = open_store(&database).await;
        let session_id = test_session_id();
        let run_id = RunId::try_from(mint_uuid_v7()).expect("a minted UUID is a run id");
        insert_running_run(&database, session_id, run_id);
        let home = json!({"home": "shared"})
            .as_object()
            .cloned()
            .expect("the test's recovery data is a map");
        let binding = store
            .create(CreateRuntimeBindingInput {
                run_id,
                runtime_metadata: home.clone(),
                ..binding_input(
                    spawn_config_on(test_provider_account_id()),
                    spawned_build("1.0.0", "/opt/provider/bin"),
                )
            })
            .await
            .expect("the binding is recorded");
        store
            .update(
                &binding.id,
                RuntimeBindingPatch {
                    resume_handle: Some("conversation-2".to_owned()),
                    runtime_metadata: Some(Map::new()),
                    ..RuntimeBindingPatch::default()
                },
                vec![LeftConversation {
                    session_id,
                    provider_account_id: test_provider_account_id(),
                    conversation_id: "conversation-1".to_owned(),
                    runtime_metadata: home.clone(),
                }],
            )
            .await
            .expect("the update is written")
            .expect("the binding has a row");

        let reader = database.reader();
        let conversations =
            read_session_conversations(&reader, session_id).expect("the conversations read");

        assert_eq!(
            conversations,
            vec![(
                binding.provider_name,
                vec![
                    SessionConversation {
                        resume_handle: "conversation-2".to_owned(),
                        provider_account_id: test_provider_account_id(),
                        runtime_metadata: Map::new(),
                    },
                    SessionConversation {
                        resume_handle: "conversation-1".to_owned(),
                        provider_account_id: test_provider_account_id(),
                        runtime_metadata: home,
                    },
                ],
            )]
        );
    }
}
