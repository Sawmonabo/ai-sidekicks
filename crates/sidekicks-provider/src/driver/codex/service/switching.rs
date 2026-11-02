//! The sign-in of the one switching service, which keeps none of its own: the account it carries,
//! whose tokens the daemon reads from that account's own home and hands it with Codex's
//! `account/login/start {type: "chatgptAuthTokens"}`, held in memory alone. The tokens are handed
//! at each start or rejoin of the service, before it answers, so before any resume or admission
//! there; at a switch, and at any hand onto another account than the one carried, its answer the
//! acknowledgment that moves every session on the service with it; and when a limits read in the
//! carried account's home finds its access token renewed. Never on a timer, since each such login
//! refreshes the tool servers of every conversation loaded there.
//! One hand at a time: each holds the switching service's hand through its login's answer, so a
//! renewal never hands an account back over a switch that landed meanwhile. A login written and
//! never answered leaves the service's account unknown, carried as none until the next hand.

use std::collections::HashMap;
use std::path::Path;
use std::sync::{Arc, Mutex};

use secrecy::{ExposeSecret as _, SecretString};
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::provider::account::record::ProviderAccountId;
use sidekicks_contracts::provider::driver::runtime_binding::RuntimeBindingId;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_ipc::domain_error::DomainError;
use sidekicks_std::mutex_lock::lock;
use sidekicks_std::port_registration::PortRegistration;
use subtle::ConstantTimeEq as _;
use tokio::sync::oneshot;

use crate::driver::codex::DESCRIPTOR;
use crate::driver::codex::account::auth_file::{CodexAuthTokens, read_codex_auth_tokens};
use crate::driver::codex::account::login::CodexLoginAccountParams;
use crate::driver::codex::service::supervisor::CodexService;
use crate::driver::codex::session::errors::CodexError;
use crate::driver::codex::session::inbound::{
    CodexAccountMove, CodexSessionInbound, CodexSessionInboundSender,
};
use crate::driver::codex::transport::connection::CodexAppServerConnection;
use crate::driver::contract::error::DriverError;
use crate::driver::{ProviderAccountReader, read_current_account};

/// Codex's request that signs a service in.
pub(crate) const CODEX_LOGIN_START_METHOD: &str = "account/login/start";

/// A session a switch names, moved at the switch's acknowledgment with its lead's binding, and
/// where the switch waits on that move.
pub(crate) struct CodexNamedMove {
    /// The session to move.
    pub(crate) session_id: SessionId,
    /// The binding its lead runs on, which moves with it.
    pub(crate) binding_id: RuntimeBindingId,
    /// Where the bindings' move, or its failure, goes once the spend before it is recorded.
    pub(crate) moved: oneshot::Sender<Result<(), DriverError>>,
}

/// The account the switching service carries and the tokens it was last handed for it.
pub(crate) struct CodexSwitchingAccount {
    provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    // Shared with the hook a switch's answer runs on the connection's reader.
    carried: Arc<Mutex<Option<CarriedAccount>>>,
    // Held by each hand from its tokens' read through its login's answer.
    hands: tokio::sync::Mutex<()>,
}

// The account the service carries and the access token last handed for it.
struct CarriedAccount {
    provider_account_id: ProviderAccountId,
    access_token: SecretString,
}

impl CodexSwitchingAccount {
    /// Carrying no account yet, each account's home and the current account read through
    /// `provider_accounts`.
    pub(crate) fn new(
        provider_accounts: Arc<PortRegistration<Arc<dyn ProviderAccountReader>>>,
    ) -> Self {
        Self {
            provider_accounts,
            carried: Arc::default(),
            hands: tokio::sync::Mutex::default(),
        }
    }

    /// The account the switching service carries; `None` before its first hand and after a login
    /// that went unanswered.
    pub(crate) fn carried_account(&self) -> Option<ProviderAccountId> {
        lock(&self.carried)
            .as_ref()
            .map(|carried| carried.provider_account_id.clone())
    }

    /// Hands a starting or rejoined switching `service`, over `connection`, the tokens of the
    /// account it carries, else of Codex's current account, and carries that account; a service
    /// that carried none moves every session attached to it onto that account, as a switch does.
    /// Fails with the refusal of an account with no current one or no `ChatGPT` sign-in in its
    /// home, as its home cannot be read, and with Codex's refusal of the login.
    pub(crate) async fn hand_at_start(
        &self,
        service: &Arc<CodexService>,
        connection: &CodexAppServerConnection,
    ) -> Result<(), CodexError> {
        let hand = self.hands.lock().await;
        let Some(provider_account_id) = self.carried_account() else {
            let current = read_current_account(&self.provider_accounts, DESCRIPTOR.provider_id())
                .await
                .map_err(CodexError::Driver)?;
            return self
                .hand_switch_holding(&hand, service, connection, current, Vec::new())
                .await;
        };
        let tokens = self.read_tokens(&provider_account_id).await?;
        let access_token = tokens.access_token.clone();
        self.settle_login(
            connection
                .request(CODEX_LOGIN_START_METHOD, &compose_login(tokens))
                .await,
        )?;
        *lock(&self.carried) = Some(CarriedAccount {
            provider_account_id,
            access_token,
        });
        Ok(())
    }

    /// Hands the switching `service` the tokens of `to`'s account, the switch's one call: at its
    /// answer's place among the service's frames its readings start afresh, it carries `to`, and
    /// every session attached to it is queued its move onto `to`, each of `named` with its lead's
    /// binding and its switch's wait; a refused login leaves it carrying what it did and moves
    /// nothing. Fails as [`Self::hand_at_start`] does, before anything is sent where `to`'s home
    /// holds no sign-in, and while the service has no connection.
    pub(crate) async fn hand_switch(
        &self,
        service: &Arc<CodexService>,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
    ) -> Result<(), CodexError> {
        let hand = self.hands.lock().await;
        let connection = service.connection()?;
        self.hand_switch_holding(&hand, service, &connection, to, named)
            .await
    }

    /// Hands the switching `service` `to`'s tokens as a switch does where it carries another
    /// account or none, so a session following the current account starts on `to` though no
    /// switch moved the service there, and every session already on it moves with it; a service
    /// carrying `to` is handed nothing. Fails as [`Self::hand_switch`] does.
    pub(crate) async fn carry_for_session(
        &self,
        service: &Arc<CodexService>,
        to: &ProviderAccountId,
    ) -> Result<(), CodexError> {
        let hand = self.hands.lock().await;
        if self.carried_account().as_ref() == Some(to) {
            return Ok(());
        }
        let connection = service.connection()?;
        self.hand_switch_holding(&hand, service, &connection, to.clone(), Vec::new())
            .await
    }

    // The switch's login, sent on `connection` under `_hand`, its answer the acknowledgment that
    // moves the service and every session attached to it onto `to`.
    async fn hand_switch_holding(
        &self,
        _hand: &tokio::sync::MutexGuard<'_, ()>,
        service: &Arc<CodexService>,
        connection: &CodexAppServerConnection,
        to: ProviderAccountId,
        named: Vec<CodexNamedMove>,
    ) -> Result<(), CodexError> {
        let tokens = self.read_tokens(&to).await?;
        let access_token = tokens.access_token.clone();
        let carried = Arc::clone(&self.carried);
        let acknowledged = Arc::downgrade(service);
        let answer = connection
            .request_ordered(
                CODEX_LOGIN_START_METHOD,
                &compose_login(tokens),
                Box::new(move |answer: Option<&RawValue>| {
                    let Some(service) = answer.and(acknowledged.upgrade()) else {
                        return;
                    };
                    service.restart_rate_limits(|| {
                        *lock(&carried) = Some(CarriedAccount {
                            provider_account_id: to.clone(),
                            access_token,
                        });
                    });
                    move_attached_sessions(&service, &to, named);
                }),
            )
            .await;
        self.settle_login(answer)?;
        Ok(())
    }

    /// Hands the switching service on `connection` the tokens in `codex_home` again where that
    /// home is the carried `provider_account_id`'s and its access token is no longer the one last
    /// handed, as a renewal there leaves it; the carried account is checked under the hand, so a
    /// switch that landed first is never undone. Answers whether it handed them. Fails as the
    /// home's `auth.json` cannot be read and with Codex's refusal of the login.
    pub(crate) async fn hand_again_if_renewed(
        &self,
        connection: &CodexAppServerConnection,
        provider_account_id: &ProviderAccountId,
        codex_home: &Path,
    ) -> Result<bool, CodexError> {
        let _hand = self.hands.lock().await;
        if self.carried_account().as_ref() != Some(provider_account_id) {
            return Ok(false);
        }
        let Some(tokens) = read_home_tokens(codex_home).await? else {
            return Ok(false);
        };
        let is_renewed = lock(&self.carried).as_ref().is_some_and(|carried| {
            let handed = carried.access_token.expose_secret().as_bytes();
            !bool::from(handed.ct_eq(tokens.access_token.expose_secret().as_bytes()))
        });
        if !is_renewed {
            return Ok(false);
        }
        let access_token = tokens.access_token.clone();
        self.settle_login(
            connection
                .request(CODEX_LOGIN_START_METHOD, &compose_login(tokens))
                .await,
        )?;
        if let Some(carried) = lock(&self.carried)
            .as_mut()
            .filter(|carried| carried.provider_account_id == *provider_account_id)
        {
            carried.access_token = access_token;
        }
        Ok(true)
    }

    /// The registration of the accounts reader the tokens are found through, for a test to
    /// register its own.
    #[cfg(test)]
    pub(crate) fn provider_accounts(&self) -> &PortRegistration<Arc<dyn ProviderAccountReader>> {
        &self.provider_accounts
    }

    // A login's answer: one written and never answered may have landed or not, so the service's
    // account is unknown and carried as none, which the next hand at a start or session start
    // replaces; any other failure leaves the account carried as it was.
    fn settle_login<Answer>(
        &self,
        answer: Result<Answer, CodexError>,
    ) -> Result<Answer, CodexError> {
        if let Err(CodexError::Unanswered { .. }) = &answer {
            *lock(&self.carried) = None;
        }
        answer
    }

    // The ChatGPT sign-in's tokens in `provider_account_id`'s home. Refuses
    // `provider.account.notAuthenticated` where the home holds none.
    async fn read_tokens(
        &self,
        provider_account_id: &ProviderAccountId,
    ) -> Result<CodexAuthTokens, CodexError> {
        let folders = self
            .provider_accounts
            .require_port()
            .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))?
            .resolve_account_folders(provider_account_id.clone())
            .await
            .map_err(|error| CodexError::Driver(error.into()))?;
        read_home_tokens(&folders.configuration_folder)
            .await?
            .ok_or_else(|| {
                CodexError::Driver(DriverError::from(DomainError::new(
                    "The Codex account's home holds no ChatGPT sign-in to hand over",
                    RefusalCode::ProviderAccountNotAuthenticated,
                )))
            })
    }
}

// Queues each session attached to `service` its move onto `to` at this place among its frames:
// each of `named` with its lead's binding and its switch's wait, every other one with its own
// binding alone. A named session no longer attached drops its wait, which moves it at once.
fn move_attached_sessions(
    service: &CodexService,
    to: &ProviderAccountId,
    named: Vec<CodexNamedMove>,
) {
    let mut unnamed: HashMap<SessionId, CodexSessionInboundSender> = service
        .attached_sessions()
        .into_iter()
        .map(|session| (session.session_id(), session))
        .collect();
    for session in named {
        unnamed.remove(&session.session_id);
        // A queue that takes nothing drops the wait, which moves the session at once.
        let _taken = service.push_session_item(
            &session.session_id,
            CodexSessionInbound::AccountMoved(CodexAccountMove {
                provider_account_id: to.clone(),
                binding_id: Some(session.binding_id),
                moved: Some(session.moved),
            }),
        );
    }
    for session in unnamed.into_values() {
        // A queue whose task ended takes nothing more; its session is closing.
        let _taken = session.push(CodexSessionInbound::AccountMoved(CodexAccountMove {
            provider_account_id: to.clone(),
            binding_id: None,
            moved: None,
        }));
    }
}

// The tokens of `codex_home`'s `auth.json`, `None` where it holds none. Fails as it cannot be read.
async fn read_home_tokens(codex_home: &Path) -> Result<Option<CodexAuthTokens>, CodexError> {
    read_codex_auth_tokens(codex_home)
        .await
        .map_err(|error| CodexError::Driver(DriverError::Internal(Box::new(error))))
}

fn compose_login(tokens: CodexAuthTokens) -> CodexLoginAccountParams {
    CodexLoginAccountParams::ChatgptAuthTokens {
        access_token: tokens.access_token,
        chatgpt_account_id: tokens.chatgpt_account_id,
        chatgpt_plan_type: tokens.chatgpt_plan_type,
    }
}

/// What a test signs its accounts in with: each account's home holding a `ChatGPT` sign-in Codex
/// wrote, and an accounts reader resolving each account to its home.
#[cfg(test)]
pub(crate) mod test_sign_in {
    use std::collections::HashMap;
    use std::error::Error;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;

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
    /// provider's current account.
    pub(crate) struct AccountHomes {
        /// Each account's Codex home.
        pub(crate) homes: HashMap<ProviderAccountId, PathBuf>,
        /// The current account.
        pub(crate) current: ProviderAccountId,
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
            _provider_account_id: ProviderAccountId,
        ) -> BoxFuture<'_, Result<Option<ProviderAuthMode>, Box<dyn Error + Send + Sync>>> {
            async { Ok(Some(ProviderAuthMode::OauthSubscription)) }.boxed()
        }

        fn read_sealed_token(
            &self,
            _provider_account_id: ProviderAccountId,
        ) -> BoxFuture<'_, Result<Option<SecretString>, Box<dyn Error + Send + Sync>>> {
            async { Ok(None) }.boxed()
        }
    }
}
