//! The receipted sign-in command: a press is answered once per key, its target read from the
//! binding and launched inside the receipt, the sign-in page's address served and never saved, so
//! a retry under the key answers the acknowledgment alone and starts nothing.

use std::sync::Arc;

use sidekicks_contracts::mcp::server::requests::{McpServerSignInRequest, McpServerSignInResponse};
use sidekicks_contracts::web_address::WebAddress;
use sidekicks_contracts::wire::id::ClientUuid;
use sidekicks_ipc::registry::HandlerError;

use crate::errors::{McpRefusal, SignInUnsupportedReason};
use crate::mutation::service::command::{McpCommand, McpCommandAnswer};
use crate::mutation::service::{McpMutationService, response_of, response_value};
use crate::sign_in::service::SignInService;
use crate::sign_in::target::SignInTargetReads;

/// The receipted sign-in and sign-out commands the daemon's handlers forward to.
#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds them and its handlers call them"
    )
)]
pub(crate) struct McpSignInCommands {
    mutations: Arc<McpMutationService>,
    sign_ins: Arc<SignInService>,
    targets: SignInTargetReads,
}

#[cfg_attr(
    not(test),
    expect(
        dead_code,
        reason = "the daemon's start builds them and its handlers call them"
    )
)]
impl McpSignInCommands {
    /// The commands over the receipts of `mutations`, the launches of `sign_ins` and the target
    /// reads `targets`.
    pub(crate) fn new(
        mutations: Arc<McpMutationService>,
        sign_ins: Arc<SignInService>,
        targets: SignInTargetReads,
    ) -> Self {
        Self {
            mutations,
            sign_ins,
            targets,
        }
    }

    /// Starts a sign-in to `request`'s binding once per key, answering the sign-in page's address,
    /// and a retry under the key with the acknowledgment alone. Refuses as the receipt, the target
    /// read and the launch refuse, and `mcp.server.signInUnsupported` when the page the launch
    /// opens is no `http:` or `https:` address.
    pub(crate) async fn sign_in(
        &self,
        request: McpServerSignInRequest,
    ) -> Result<McpServerSignInResponse, HandlerError> {
        let binding = request.binding();
        let answer = self
            .mutations
            .run_command(
                McpCommand::SignIn,
                idempotency_key_of(&request),
                &request,
                &binding,
                || async {
                    let read = self.targets.read(&binding).await?;
                    let browser_url = self
                        .sign_ins
                        .launch(&read.target, &read.scopes, &read.provider_accounts)
                        .await?;
                    // The server's metadata or a provider's flow can name a page of any scheme.
                    let Some(authorization_url) = WebAddress::new(browser_url.as_str()) else {
                        return Err(HandlerError::Refused(
                            McpRefusal::ServerSignInUnsupported {
                                binding: Box::new(binding.clone()),
                                reason: SignInUnsupportedReason::UnusableMetadata,
                            }
                            .into(),
                        ));
                    };
                    Ok(McpCommandAnswer {
                        served: response_value(&McpServerSignInResponse {
                            authorization_url: Some(authorization_url),
                        }),
                        saved: response_value(&McpServerSignInResponse {
                            authorization_url: None,
                        }),
                    })
                },
            )
            .await?;
        response_of(answer).map_err(HandlerError::Refused)
    }
}

// The press's key, in whichever scope the request names its binding.
fn idempotency_key_of(request: &McpServerSignInRequest) -> &ClientUuid {
    match request {
        McpServerSignInRequest::User {
            client_idempotency_key,
            ..
        }
        | McpServerSignInRequest::Project {
            client_idempotency_key,
            ..
        }
        | McpServerSignInRequest::Local {
            client_idempotency_key,
            ..
        }
        | McpServerSignInRequest::Plugin {
            client_idempotency_key,
            ..
        }
        | McpServerSignInRequest::Connector {
            client_idempotency_key,
            ..
        }
        | McpServerSignInRequest::Managed {
            client_idempotency_key,
            ..
        } => client_idempotency_key,
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;
    use std::sync::atomic::Ordering;

    use serde_json::json;
    use sidekicks_contracts::mcp::server::config::McpServerAddress;
    use sidekicks_contracts::mcp::server::requests::McpServerSignInRequest;
    use sidekicks_provider::driver::contract::ProviderDriver;
    use sidekicks_provider::driver::contract::sign_in::McpServerAddressReading;
    use sidekicks_store::credential_store::service::KeychainService;
    use sidekicks_store::credential_store::test_keychain::test_keychain;

    use super::McpSignInCommands;
    use crate::mutation::receipts::tests::idempotency_key;
    use crate::mutation::service::{McpMutationService, McpMutationSources};
    use crate::sign_in::target::tests::{
        answer_address_read, docs_binding, driver_declaring, remote_declaration, test_sources,
    };
    use crate::sign_in::test_service::{
        FakeServerAnswers, harness_with, serve_authorization_server,
    };

    // Killed by `saved` built from `served` (the retry carries the address), and by a launch
    // outside `run_command` (a second launch reads the address again, which the driver answers
    // once, and adds requests to the fake server).
    #[tokio::test]
    async fn a_sign_in_is_launched_once_per_key() {
        let server = serve_authorization_server(FakeServerAnswers::default()).await;
        let binding = docs_binding();
        let mut driver = driver_declaring(vec![remote_declaration(&binding, &server.base)]);
        let address = McpServerAddress::new(&server.base).expect("a server address");
        answer_address_read(&mut driver, Ok(McpServerAddressReading::Declared(address)));
        let driver: Arc<dyn ProviderDriver> = Arc::new(driver);
        let sources = test_sources(vec![Arc::clone(&driver)]).await;
        let (_data_folder, _platform_store, keychain) =
            test_keychain(KeychainService::McpReceiptKey);
        let mutations = Arc::new(McpMutationService::new(McpMutationSources {
            providers: Arc::clone(&sources.providers),
            inventory: Arc::clone(&sources.inventory),
            keychain,
            writer: Arc::clone(&sources.writer),
            reads: Arc::clone(&sources.reads),
            removal_rows: None,
            board: Arc::clone(&sources.board),
        }));
        let harness = harness_with(vec![driver]).await;
        let commands = McpSignInCommands::new(
            mutations,
            Arc::clone(&harness.service),
            sources.target_reads(),
        );
        let mut request = serde_json::to_value(&binding).expect("a binding writes as JSON");
        request["clientIdempotencyKey"] = json!(idempotency_key().as_str());
        let request: McpServerSignInRequest =
            serde_json::from_value(request).expect("a sign-in request");

        let first = commands
            .sign_in(request.clone())
            .await
            .expect("the first press is served");
        let requests_after_first = server.requests.load(Ordering::SeqCst);
        let retry = commands
            .sign_in(request)
            .await
            .expect("the retry is answered");

        assert!(first.authorization_url.is_some());
        assert_eq!(retry.authorization_url, None);
        assert_eq!(server.requests.load(Ordering::SeqCst), requests_after_first);
    }
}
