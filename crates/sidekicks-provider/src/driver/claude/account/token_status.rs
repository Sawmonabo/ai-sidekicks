//! Claude Code's status read of a pasted token: a process that keeps nothing, run on a folder the
//! daemon makes for the read over the account's own credential store and handed the token on its
//! pipe, whose `initialize` reply names the token as its sign-in or names none.

use secrecy::SecretString;
use sidekicks_contracts::provider::account::record::{ProviderAccountId, ProviderAuthMode};

use crate::driver::ProviderAccountFolders;
use crate::driver::claude::account::ClaudeAccountLegs;
use crate::driver::claude::account::read_folder::run_in_read_folder;
use crate::driver::claude::spawn::environment::{ClaudeAccountFolders, ClaudeProcessHome};
use crate::driver::claude::spawn::launch::control_only::probe_claude_sign_in;
use crate::driver::contract::error::DriverError;

/// The data folder's folder of the status reads' own folders, one per read.
const CLAUDE_TOKEN_STATUS_FOLDER: [&str; 2] = ["claude", "token-status"];

/// Reads how Claude Code signs in with `token` on `provider_account_id`'s credential store, in a
/// folder made for the read and removed after it: `OauthToken` where its `initialize` reply names
/// a token source other than `none`, else `None`, whatever API key the environment holds. Fails
/// as the folder cannot be made, the build cannot be resolved, or the process cannot answer.
pub(super) async fn read_claude_token_status(
    legs: &ClaudeAccountLegs,
    provider_account_id: &ProviderAccountId,
    folders: &ProviderAccountFolders,
    token: &SecretString,
) -> Result<Option<ProviderAuthMode>, DriverError> {
    run_in_read_folder(
        &legs.data_folder,
        &CLAUDE_TOKEN_STATUS_FOLDER,
        async |folder| {
            let folders = ClaudeAccountFolders::from(folders);
            let executable = legs
                .resolve_build_on(ClaudeProcessHome::AccountStore {
                    folder,
                    credential_store_folder: &folders.credential_store_folder,
                })
                .await?;
            let sources = probe_claude_sign_in(
                &legs.launcher,
                &executable,
                Some(provider_account_id.clone()),
                Some(token.clone()),
            )
            .await?;
            Ok(sources
                .token_source()
                .is_some()
                .then_some(ProviderAuthMode::OauthToken))
        },
    )
    .await
}

#[cfg(test)]
mod tests {
    use std::path::Path;
    use std::sync::Arc;

    use rstest::rstest;
    use secrecy::SecretString;
    use sidekicks_contracts::provider::account::record::ProviderAuthMode;
    use sidekicks_std::file::atomic_write::write_file_atomically;

    use super::CLAUDE_TOKEN_STATUS_FOLDER;
    use crate::driver::ProviderAccountFolders;
    use crate::driver::claude::account::read_folder::compose_reads_folder;
    use crate::driver::claude::account::test_account_legs;
    use crate::driver::contract::account::ProviderTokenStatusLegs;
    use crate::driver::test_registry::test_driver_services;
    use crate::runtime_binding::test_store::test_provider_account_id;

    /// The token the stand-in accepts.
    const ACCEPTED_TOKEN: &str = "sk-ant-oat01-accepted-test-token-91c4";

    // A stand-in for Claude Code's sign-in read: it reads its token from the descriptor its
    // environment names, records its homes, and answers `initialize` naming the descriptor as its
    // token's source for the accepted token, and for any other `none` beside the API key the
    // environment would offer, as Claude Code does.
    fn stand_in(record: &Path) -> String {
        format!(
            r#"#!/bin/sh
handed=$(cat <&"$CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR")
printf '%s|%s\n' "$CLAUDE_CONFIG_DIR" "$CLAUDE_SECURESTORAGE_CONFIG_DIR" > '{record}'
if [ "$handed" = '{ACCEPTED_TOKEN}' ]; then
  account='{{"tokenSource":"CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR"}}'
else
  account='{{"tokenSource":"none","apiKeySource":"ANTHROPIC_API_KEY"}}'
fi
read -r line
id=$(printf '%s' "$line" | sed -n 's/.*"request_id":"\([^"]*\)".*/\1/p')
printf '{{"type":"control_response","response":{{"subtype":"success","request_id":"%s","response":{{"account":%s}}}}}}\n' "$id" "$account"
cat > /dev/null
"#,
            record = record.display()
        )
    }

    // Killed by a token not handed on the descriptor (the accepted case reads `none`), by an API
    // key's source admitted as the token's (the refused case), and by the read run in the
    // account's own configuration home or on another credential store.
    #[rstest]
    #[case::a_token_claude_code_signs_in_with(ACCEPTED_TOKEN, Some(ProviderAuthMode::OauthToken))]
    #[case::a_token_claude_code_names_none_for("sk-ant-oat01-refused-test-token", None)]
    #[tokio::test(flavor = "multi_thread")]
    async fn the_status_read_admits_a_token_claude_code_signs_in_with_and_refuses_none(
        #[case] token: &str,
        #[case] admitted: Option<ProviderAuthMode>,
    ) {
        let root = tempfile::tempdir().expect("a scratch folder is made");
        let programs = root.path().join("programs");
        tokio::fs::create_dir_all(&programs)
            .await
            .expect("the programs folder is made");
        let record = root.path().join("homes");
        write_file_atomically(&programs.join("claude"), stand_in(&record), 0o755)
            .await
            .expect("the stand-in is written");
        let mut services = test_driver_services();
        services.data_folder = root.path().join("data");
        services.home_folder = root.path().join("home");
        services.base_environment = Arc::from([(
            "PATH".to_owned(),
            format!("{}:/usr/bin:/bin", programs.display()),
        )]);
        let legs = test_account_legs(&services);
        let folders = ProviderAccountFolders {
            configuration_folder: root.path().join("account"),
            credential_store_folder: root.path().join("account").join("store"),
        };

        let read = legs
            .read_token_status(
                &test_provider_account_id(),
                &folders,
                &SecretString::from(token),
            )
            .await
            .expect("the read answers");

        assert_eq!(read, admitted);
        let recorded = tokio::fs::read_to_string(&record)
            .await
            .expect("the stand-in recorded its homes");
        let (config_folder, credential_store_folder) = recorded
            .trim_end()
            .split_once('|')
            .expect("both homes are recorded");
        let reads_folder = compose_reads_folder(&services.data_folder, &CLAUDE_TOKEN_STATUS_FOLDER);
        assert!(
            Path::new(config_folder).starts_with(&reads_folder),
            "the read's configuration home is its own folder: {config_folder}"
        );
        assert_eq!(
            Path::new(credential_store_folder),
            folders.credential_store_folder
        );
        let mut left = tokio::fs::read_dir(&reads_folder)
            .await
            .expect("the reads' folder stays");
        assert!(
            left.next_entry()
                .await
                .expect("the reads' folder lists")
                .is_none(),
            "the read's own folder is removed after it"
        );
    }
}
