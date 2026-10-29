//! The purge of Claude Code's own copy of a session's conversations, from the home each one ran
//! in: the conversations of one account home are deleted together, every home is tried, and the
//! homes that failed are returned together after.

use std::error::Error;
use std::future::Future;
use std::io;
use std::path::Path;

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::PathRules;
use sidekicks_std::settle_all::{SettleFailures, settle_all};

use crate::driver::claude::session::conversation_file::{
    ClaudeConversation, ClaudeConversationFolders, delete_claude_conversations,
};
use crate::driver::claude::session::rules::ClaudeProjectFolder;
use crate::driver::claude::spawn::environment::claude_config_folder;
use crate::driver::session_control::PurgeSessionParams;

/// Where a session's conversations ran, the same for each of its account homes.
pub(crate) struct ClaudePurgePlace<'a> {
    /// The session's working folder, with what Claude Code reads to place its local settings.
    pub(crate) project_folder: &'a ClaudeProjectFolder<'a>,
    /// The home folder of the place the conversations ran in.
    pub(crate) home_folder: &'a Path,
    /// How that place spells paths.
    pub(crate) path_rules: PathRules,
    /// The daemon's data folder, which holds each home's scratch folder.
    pub(crate) data_folder: &'a str,
}

/// Why the conversations of one account home were not deleted.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudePurgeError {
    /// The environment a spawn on the account would start with could not be resolved.
    #[error(
        "resolving the Claude Code home of account {} failed",
        .provider_account_id.as_str()
    )]
    HomeUnresolved {
        /// The account.
        provider_account_id: ProviderAccountId,
        /// Why.
        #[source]
        source: Box<dyn Error + Send + Sync>,
    },
    /// The spawn environment names no home, so no config folder is known.
    #[error(
        "no Claude Code config folder is known for account {}",
        .provider_account_id.as_str()
    )]
    ConfigFolderUnknown {
        /// The account.
        provider_account_id: ProviderAccountId,
    },
    /// Claude Code's files of the home's conversations could not all be deleted.
    #[error(
        "deleting the Claude Code conversations of account {} failed",
        .provider_account_id.as_str()
    )]
    Delete {
        /// The account.
        provider_account_id: ProviderAccountId,
        /// The first read or removal that failed.
        #[source]
        source: io::Error,
    },
}

/// Deletes every file Claude Code keeps for each of the session's conversations from the home it
/// ran in, its config folder resolved from the environment a spawn on its account would start
/// with, `resolve_spawn_environment`. Every home is tried; fails
/// after with each home that failed.
pub(crate) async fn purge_claude_conversations<ResolveEnvironment, EnvironmentResolution>(
    params: &PurgeSessionParams,
    place: &ClaudePurgePlace<'_>,
    resolve_spawn_environment: ResolveEnvironment,
) -> Result<(), SettleFailures<ClaudePurgeError>>
where
    ResolveEnvironment: Fn(ProviderAccountId) -> EnvironmentResolution,
    EnvironmentResolution:
        Future<Output = Result<Vec<(String, String)>, Box<dyn Error + Send + Sync>>>,
{
    // Each home's conversations in the order the params list them, the homes in the order first
    // met, so a fork still goes before the conversation it was forked from.
    let mut homes: Vec<(ProviderAccountId, Vec<&str>)> = Vec::new();
    for conversation in &params.conversations {
        let handle = conversation.resume_handle.as_str();
        match homes
            .iter_mut()
            .find(|(account, _)| *account == conversation.provider_account_id)
        {
            Some((_, handles)) => handles.push(handle),
            None => homes.push((conversation.provider_account_id.clone(), vec![handle])),
        }
    }
    let mut outcomes = Vec::with_capacity(homes.len());
    for (provider_account_id, handles) in homes {
        outcomes.push(
            delete_home_conversations(
                place,
                &resolve_spawn_environment,
                provider_account_id,
                &handles,
            )
            .await,
        );
    }
    settle_all(outcomes, "deleting the session's Claude Code conversations")?;
    Ok(())
}

// Deletes one home's conversations, `handles` being Claude Code's ids for them.
async fn delete_home_conversations<ResolveEnvironment, EnvironmentResolution>(
    place: &ClaudePurgePlace<'_>,
    resolve_spawn_environment: &ResolveEnvironment,
    provider_account_id: ProviderAccountId,
    handles: &[&str],
) -> Result<(), ClaudePurgeError>
where
    ResolveEnvironment: Fn(ProviderAccountId) -> EnvironmentResolution,
    EnvironmentResolution:
        Future<Output = Result<Vec<(String, String)>, Box<dyn Error + Send + Sync>>>,
{
    let spawn_environment = match resolve_spawn_environment(provider_account_id.clone()).await {
        Ok(spawn_environment) => spawn_environment,
        Err(source) => {
            return Err(ClaudePurgeError::HomeUnresolved {
                provider_account_id,
                source,
            });
        }
    };
    let Some(config_folder) = claude_config_folder(&spawn_environment, place.path_rules) else {
        return Err(ClaudePurgeError::ConfigFolderUnknown {
            provider_account_id,
        });
    };
    let conversations: Vec<ClaudeConversation<'_>> = handles
        .iter()
        .map(|handle| ClaudeConversation {
            provider_session_id: handle,
            project_folder: place.project_folder,
        })
        .collect();
    let deleted = delete_claude_conversations(
        &ClaudeConversationFolders {
            config_folder: &config_folder,
            home_folder: place.home_folder,
            path_rules: place.path_rules,
            data_folder: place.data_folder,
            provider_account_id: &provider_account_id,
        },
        &conversations,
    )
    .await;
    deleted.map_err(|source| ClaudePurgeError::Delete {
        provider_account_id,
        source,
    })
}
