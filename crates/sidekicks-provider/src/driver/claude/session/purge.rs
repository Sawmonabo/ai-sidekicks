//! The purge of Claude Code's own copy of a session's conversations, from the home each one is
//! kept in: the conversations of one home are deleted together, every home is tried, and the homes
//! that failed are returned together after.

use std::error::Error;
use std::future::Future;
use std::io;
use std::path::{Path, PathBuf};

use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_platforms::PathRules;
use sidekicks_std::settle_all::{SettleFailures, settle_all};

use crate::driver::claude::session::conversation_file::{
    ClaudeConversation, ClaudeConversationFolders, delete_claude_conversations,
};
use crate::driver::claude::session::conversation_home::read_claude_conversation_home;
use crate::driver::claude::session::rules::ClaudeProjectFolder;
use crate::driver::session_control::PurgeSessionParams;

/// Where a session's conversations ran, the same for each of its homes.
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

/// Why the conversations of one home were not deleted, named by the account a conversation in it
/// ran on.
#[derive(Debug, thiserror::Error)]
pub(crate) enum ClaudePurgeError {
    /// The configuration home of the account could not be resolved.
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

// The conversations kept in one home: the account the first of them ran on, which names the home
// in a failure, and Claude Code's ids for them.
struct ClaudeHomeConversations<'a> {
    home: PathBuf,
    provider_account_id: ProviderAccountId,
    handles: Vec<&'a str>,
}

/// Deletes every file Claude Code keeps for each of the session's conversations from the home that
/// holds it: the home its binding's recovery data names, which a switch left apart from the
/// account's, else the configuration home of the account it ran on, `resolve_account_home`. Every
/// home is tried; fails after with each home that failed.
pub(crate) async fn purge_claude_conversations<ResolveHome, HomeResolution>(
    params: &PurgeSessionParams,
    place: &ClaudePurgePlace<'_>,
    resolve_account_home: ResolveHome,
) -> Result<(), SettleFailures<ClaudePurgeError>>
where
    ResolveHome: Fn(ProviderAccountId) -> HomeResolution,
    HomeResolution: Future<Output = Result<PathBuf, Box<dyn Error + Send + Sync>>>,
{
    // Each home's conversations in the order the params list them, the homes in the order first
    // met, so a fork still goes before the conversation it was forked from.
    let mut homes: Vec<ClaudeHomeConversations<'_>> = Vec::new();
    let mut outcomes = Vec::new();
    let mut account_homes: Vec<(ProviderAccountId, Option<PathBuf>)> = Vec::new();
    for conversation in &params.conversations {
        let account = &conversation.provider_account_id;
        let home = if let Some(home) = read_claude_conversation_home(&conversation.runtime_metadata)
        {
            home
        } else {
            let known = account_homes
                .iter()
                .find(|(resolved, _)| resolved == account)
                .map(|(_, home)| home.clone());
            // Each account is resolved once; its failure is reported once.
            let resolved = if let Some(home) = known {
                home
            } else {
                let home = match resolve_account_home(account.clone()).await {
                    Ok(home) => Some(home),
                    Err(source) => {
                        outcomes.push(Err(ClaudePurgeError::HomeUnresolved {
                            provider_account_id: account.clone(),
                            source,
                        }));
                        None
                    }
                };
                account_homes.push((account.clone(), home.clone()));
                home
            };
            let Some(home) = resolved else {
                continue;
            };
            home
        };
        let handle = conversation.resume_handle.as_str();
        match homes.iter_mut().find(|kept| kept.home == home) {
            Some(kept) => kept.handles.push(handle),
            None => homes.push(ClaudeHomeConversations {
                home,
                provider_account_id: account.clone(),
                handles: vec![handle],
            }),
        }
    }
    for home in homes {
        outcomes.push(delete_home_conversations(place, home).await);
    }
    settle_all(outcomes, "deleting the session's Claude Code conversations")?;
    Ok(())
}

// Deletes one home's conversations.
async fn delete_home_conversations(
    place: &ClaudePurgePlace<'_>,
    home: ClaudeHomeConversations<'_>,
) -> Result<(), ClaudePurgeError> {
    let conversations: Vec<ClaudeConversation<'_>> = home
        .handles
        .iter()
        .map(|handle| ClaudeConversation {
            provider_session_id: handle,
            project_folder: place.project_folder,
        })
        .collect();
    let deleted = delete_claude_conversations(
        &ClaudeConversationFolders {
            config_folder: &home.home,
            home_folder: place.home_folder,
            path_rules: place.path_rules,
            data_folder: place.data_folder,
        },
        &conversations,
    )
    .await;
    deleted.map_err(|source| ClaudePurgeError::Delete {
        provider_account_id: home.provider_account_id,
        source,
    })
}

#[cfg(test)]
mod tests {
    use std::fs;
    use std::path::{Path, PathBuf};

    use sidekicks_contracts::provider::account::record::ProviderAccountId;
    use sidekicks_contracts::session::id::SessionId;
    use sidekicks_platforms::PathRules;

    use super::{ClaudePurgePlace, purge_claude_conversations};
    use crate::driver::claude::session::conversation_home::claude_conversation_home_metadata;
    use crate::driver::claude::session::rules::ClaudeProjectFolder;
    use crate::driver::session_control::{PurgeSessionParams, SessionConversation};

    const CONVERSATION: &str = "3f1c0d4e-0000-4000-8000-000000000001";

    fn write(path: &Path) {
        fs::create_dir_all(path.parent().expect("the path has a folder")).expect("the folder");
        fs::write(path, "x").expect("the file is written");
    }

    // A conversation a switch moved from account A onto account B stays in A's home, which its
    // binding names: the purge deletes it there and resolves no account's home for it. Killed by
    // the purge resolving the home of the account the binding names now, which fails here and
    // leaves A's files.
    #[tokio::test]
    async fn a_purge_after_a_switch_deletes_the_conversation_from_the_home_that_holds_it() {
        let folder = tempfile::tempdir().expect("a scratch folder");
        let home_a = folder.path().join("a").join("home");
        let work = folder.path().join("work");
        let held = [
            home_a
                .join("projects")
                .join("-work")
                .join(format!("{CONVERSATION}.jsonl")),
            home_a.join("file-history").join(CONVERSATION).join("v1"),
            home_a.join("session-env").join(CONVERSATION).join("e"),
        ];
        for path in &held {
            write(path);
        }
        let to = ProviderAccountId::new("account-b".to_owned()).expect("an account id fits");
        let params = PurgeSessionParams {
            session_id: SessionId::try_from(sidekicks_contracts::wire::id::mint_uuid_v7())
                .expect("a minted UUID is a session id"),
            conversations: vec![SessionConversation {
                resume_handle: CONVERSATION.to_owned(),
                provider_account_id: to,
                runtime_metadata: claude_conversation_home_metadata(&home_a),
            }],
        };
        let project_folder = ClaudeProjectFolder {
            working_folder: &work,
            repository: None,
        };
        let data = folder.path().join("data");
        let place = ClaudePurgePlace {
            project_folder: &project_folder,
            home_folder: folder.path(),
            path_rules: PathRules::Posix,
            data_folder: data.to_str().expect("the folder is UTF-8"),
        };

        purge_claude_conversations(&params, &place, |_account| async {
            Err::<PathBuf, _>("a conversation whose binding names its home resolves none".into())
        })
        .await
        .expect("the purge deletes the conversation");

        for path in &held {
            assert!(!path.exists(), "{} is left", path.display());
        }
    }
}
