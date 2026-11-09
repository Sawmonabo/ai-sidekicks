use std::collections::HashMap;
use std::error::Error;
use std::path::{Path, PathBuf};
use std::sync::Arc;
use std::time::Duration;

use base64::Engine as _;
use base64::engine::general_purpose::URL_SAFE_NO_PAD;
use futures::FutureExt as _;
use futures::future::BoxFuture;
use secrecy::SecretString;
use serde_json::{Value, json};
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, ProviderAccountId, ProviderAuthMode,
};
use sidekicks_contracts::provider::id::ProviderId;
use sidekicks_std::port_registration::PortRegistration;

use crate::driver::codex::account::login::CODEX_LOGIN_START_METHOD;
use crate::driver::codex::service::supervisor::test_service::ScriptedCodexService;
use crate::driver::{
    AccountFoldersError, CurrentProviderAccount, ProviderAccountFolders, ProviderAccountReader,
};

/// The plan every test sign-in's identity token names.
pub(crate) const TEST_PLAN: &str = "pro";

/// Writes into `codex_home` the `auth.json` Codex's `file` store keeps for a `ChatGPT` sign-in
/// to `workspace` with `access_token`, its identity token naming [`TEST_PLAN`].
pub(crate) fn write_sign_in(codex_home: &Path, workspace: &str, access_token: &str) {
    std::fs::create_dir_all(codex_home).expect("the home is made");
    let auth = json!({
        "OPENAI_API_KEY": null,
        "tokens": {
            "id_token": compose_jwt(&json!({
                "https://api.openai.com/auth": {"chatgpt_plan_type": TEST_PLAN},
            })),
            "access_token": access_token,
            "refresh_token": "refresh-token-the-daemon-never-hands",
            "account_id": workspace,
        },
        "last_refresh": "2026-10-31T18:00:00Z",
    });
    std::fs::write(codex_home.join("auth.json"), auth.to_string()).expect("auth.json is kept");
}

/// An access token that reads as a JWT, `marker` its payload's subject, so no two differ only
/// in their signature.
pub(crate) fn compose_access_token(marker: &str) -> String {
    compose_jwt(&json!({"sub": marker, "exp": 4_102_444_800_i64}))
}

fn compose_jwt(claims: &Value) -> String {
    format!(
        "{}.{}.signature",
        URL_SAFE_NO_PAD.encode(br#"{"alg":"RS256"}"#),
        URL_SAFE_NO_PAD.encode(claims.to_string())
    )
}

/// An accounts reader resolving each account it holds to its Codex home, with `current` the
/// provider's current account; an account in `api_keys` signs in with its pasted key, every other
/// through `ChatGPT`.
pub(crate) struct AccountHomes {
    /// Each account's Codex home.
    pub(crate) homes: HashMap<ProviderAccountId, PathBuf>,
    /// The current account.
    pub(crate) current: ProviderAccountId,
    /// The key sealed for each account that signs in with a pasted API key.
    pub(crate) api_keys: HashMap<ProviderAccountId, SecretString>,
}

impl AccountHomes {
    /// The reader registered on `provider_accounts`.
    pub(crate) fn register_on(
        self,
        provider_accounts: &PortRegistration<Arc<dyn ProviderAccountReader>>,
    ) {
        assert!(
            provider_accounts
                .register(Arc::new(self) as Arc<dyn ProviderAccountReader>)
                .is_ok(),
            "the accounts reader registers once"
        );
    }
}

impl ProviderAccountReader for AccountHomes {
    fn resolve_account_folders(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<ProviderAccountFolders, AccountFoldersError>> {
        let folders = self
            .homes
            .get(&provider_account_id)
            .map(|home| ProviderAccountFolders {
                configuration_folder: home.clone(),
                credential_store_folder: home.clone(),
            })
            .ok_or(AccountFoldersError::NotFound);
        async move { folders }.boxed()
    }

    fn current_account(
        &self,
        _provider_id: ProviderId,
    ) -> BoxFuture<'_, Result<CurrentProviderAccount, Box<dyn Error + Send + Sync>>> {
        let current = CurrentProviderAccount::Current(self.current.clone());
        async move { Ok(current) }.boxed()
    }

    fn read_credential_generation(
        &self,
        _provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<CredentialGeneration, Box<dyn Error + Send + Sync>>> {
        async { Err("the test reads no credential generation".into()) }.boxed()
    }

    fn read_observed_auth_mode(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<ProviderAuthMode>, Box<dyn Error + Send + Sync>>> {
        let mode = if self.api_keys.contains_key(&provider_account_id) {
            ProviderAuthMode::ApiKey
        } else {
            ProviderAuthMode::OauthSubscription
        };
        async move { Ok(Some(mode)) }.boxed()
    }

    fn read_sealed_token(
        &self,
        provider_account_id: ProviderAccountId,
    ) -> BoxFuture<'_, Result<Option<SecretString>, Box<dyn Error + Send + Sync>>> {
        let key = self.api_keys.get(&provider_account_id).cloned();
        async move { Ok(key) }.boxed()
    }
}

/// What a hand sent the switching service up to its login, as [`answer_through_login`] met it.
pub(crate) struct AnsweredHand {
    /// The methods of the requests, in order.
    pub(crate) methods: Vec<String>,
    /// The login.
    pub(crate) login: Value,
    /// The account the service carried when the login came, before its answer.
    pub(crate) carried_at_login: Option<ProviderAccountId>,
    /// The answers the service wrote meanwhile to requests of Codex's, such as a refresh.
    pub(crate) answers: Vec<Value>,
}

/// Answers each request the switching service sends up to its login: a sign-out at once, and the
/// login, answered or refused where `is_login_refused`, once it noted the account the service
/// carried when the login came. Any other request before the login fails the test, an account
/// read under the hand among them. An answer the service writes to a request of Codex's is kept
/// aside.
pub(crate) async fn answer_through_login(
    scripted: &mut ScriptedCodexService,
    is_login_refused: bool,
) -> AnsweredHand {
    let mut methods = Vec::new();
    let mut answers = Vec::new();
    loop {
        let message = scripted
            .script
            .next_sent_within(Duration::from_secs(5))
            .await
            .expect("the service sends its next message");
        let Some(method) = message["method"].as_str().map(str::to_owned) else {
            answers.push(message);
            continue;
        };
        methods.push(method.clone());
        if method == "account/logout" {
            scripted.script.answer(&message, &json!({}));
            continue;
        }
        assert_eq!(method, CODEX_LOGIN_START_METHOD, "{message}");
        let carried_at_login = scripted.service.provider_account_id();
        if is_login_refused {
            scripted.script.send(&json!({
                "jsonrpc": "2.0",
                "id": message["id"],
                "error": {"code": -32600, "message": "the API key is not valid"},
            }));
        } else {
            scripted
                .script
                .answer(&message, &json!({"type": message["params"]["type"]}));
        }
        return AnsweredHand {
            methods,
            login: message,
            carried_at_login,
            answers,
        };
    }
}
