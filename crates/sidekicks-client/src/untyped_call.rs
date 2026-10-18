//! The untyped call path, for a caller that holds a method's name and its params as JSON text
//! rather than its Rust types: the params are held to the method's whole contract (its schema,
//! then its type, then its garde rules) before anything is sent, and every failure takes the
//! wire's own error shape, so the caller reads a refusal from this client the way it reads one
//! from the daemon.

use std::collections::BTreeMap;

use bytes::Bytes;
use serde_json::Value;
use serde_json::value::RawValue;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::jsonrpc::issue::{
    ISSUES_MAX, IssuePathSegment, UNREADABLE_VALUE_ISSUE_MESSAGE,
};
use sidekicks_contracts::jsonrpc::message::{JsonRpcError, JsonRpcErrorData};
use sidekicks_contracts::jsonrpc::refusal::RefusalCode;
use sidekicks_contracts::method::ProcedureType;
use sidekicks_contracts::method_descriptor;
use sidekicks_contracts::schema::ReceivedCheckError;
use sidekicks_contracts::wire::AnyValue;
use sidekicks_contracts::wire::attachment::ReceivedError;
use sidekicks_contracts::wire::integer::SafeSignedInt;
use sidekicks_contracts::wire::record::JsonRecord;

use crate::error::ClientError;
use crate::transport::json_rpc::RawRequest;

/// The request for `method` once `params_json` and its attachments pass the method's contract.
/// Refused, in the wire's error shape, for a method no table declares, a subscription called as a
/// call or the reverse (`is_subscription` says which the caller makes), or params that break the
/// contract, whose `request.paramsInvalid` names each fault's place and rule, never its value.
pub fn checked_request(
    method: String,
    params_json: String,
    attachments: Vec<Bytes>,
    is_subscription: bool,
) -> Result<RawRequest, JsonRpcError> {
    let descriptor = method_descriptor(&method).ok_or_else(|| {
        refusal(
            RefusalCode::RequestMethodNotFound,
            format!("No method {method} is declared"),
            None,
        )
    })?;
    if (descriptor.procedure_type == ProcedureType::Subscription) != is_subscription {
        return Err(refusal(
            RefusalCode::RequestMethodNotAllowed,
            format!("{method} is not called this way"),
            None,
        ));
    }
    let params = RawValue::from_string(params_json)
        .map_err(|error| params_refusal(&method, &format!("are not JSON ({error})"), Vec::new()))?;
    if let Err(refused) = (descriptor.check_params)(params.get().as_bytes(), attachments.clone()) {
        return Err(match params_issues(refused) {
            Ok(issues) => params_refusal(&method, "break its contract", issues),
            Err(error) => internal_error(format!(
                "The contract check of {method} could not be built: {error}"
            )),
        });
    }
    Ok(RawRequest {
        descriptor,
        params: Some(params),
        attachments,
    })
}

/// The issues a refusal of received params names: each place and rule, never a value. A broken
/// garde rule is named at the whole params, since its path is in the Rust type's names. Fails
/// where the contract's check could not be built, which is no fault of the params.
fn params_issues(refused: ReceivedError) -> Result<Vec<Value>, ReceivedCheckError> {
    let issue = |path: Vec<IssuePathSegment>, message: String| serde_json::json!({ "path": path, "message": message });
    Ok(match refused {
        ReceivedError::Check(error) => return Err(error),
        ReceivedError::Json(_) => Vec::new(),
        ReceivedError::Shape { faults } => faults
            .into_iter()
            .take(ISSUES_MAX)
            .map(|fault| {
                let message = format!("breaks the schema's \"{}\" rule", fault.keyword);
                issue(fault.path, message)
            })
            .collect(),
        ReceivedError::Read { path, .. } => {
            vec![issue(path, UNREADABLE_VALUE_ISSUE_MESSAGE.to_owned())]
        }
        ReceivedError::Unreferenced { index } => vec![issue(
            Vec::new(),
            format!("attachment {index} is named by no placeholder"),
        )],
        ReceivedError::Rule { report, .. } => report
            .iter()
            .take(ISSUES_MAX)
            .map(|(_, rule)| issue(Vec::new(), rule.message().to_owned()))
            .collect(),
    })
}

/// A client failure in the wire's error shape: the daemon's own error as it sent it, a link that
/// is down as `connection.unavailable` with its reason, a held call's cancel as
/// `request.canceled`, and any other failure as an internal error with its causes in the message.
pub fn wire_error(error: &ClientError) -> JsonRpcError {
    match error {
        ClientError::Remote(remote) => JsonRpcError {
            code: SafeSignedInt::new(remote.code).expect("the daemon's code was a safe integer"),
            message: remote.message.clone(),
            data: remote.data.clone(),
        },
        ClientError::Unavailable { reason, .. } => refusal(
            RefusalCode::ConnectionUnavailable,
            error_text(error),
            serde_json::to_value(reason).ok().and_then(|reason| {
                JsonRecord::new(BTreeMap::from([("reason".to_owned(), AnyValue(reason))]))
            }),
        ),
        ClientError::Canceled => JsonRpcError::request_canceled(),
        ClientError::Reply { .. }
        | ClientError::Request { .. }
        | ClientError::RunFolder(_)
        | ClientError::Token { .. } => internal_error(error_text(error)),
    }
}

fn params_refusal(method: &str, what: &str, issues: Vec<Value>) -> JsonRpcError {
    let fields = BTreeMap::from([("issues".to_owned(), AnyValue(Value::Array(issues)))]);
    refusal(
        RefusalCode::RequestParamsInvalid,
        format!("The params of {method} {what}"),
        JsonRecord::new(fields),
    )
}

/// A refusal this client answers itself, in the shape the daemon answers one.
fn refusal(code: RefusalCode, message: String, fields: Option<JsonRecord>) -> JsonRpcError {
    JsonRpcError {
        code: SafeSignedInt::new(i64::from(code.json_rpc_code().code()))
            .expect("a JSON-RPC code is a safe integer"),
        message,
        data: Some(JsonRpcErrorData {
            refusal: code.as_str().to_owned(),
            category: code.category(),
            fields,
        }),
    }
}

/// An internal failure in the wire's error shape: `-32603` with `message` and no `data`.
pub fn internal_error(message: String) -> JsonRpcError {
    JsonRpcError {
        code: SafeSignedInt::new(i64::from(JsonRpcErrorCode::InternalError.code()))
            .expect("a JSON-RPC code is a safe integer"),
        message,
        data: None,
    }
}

/// `error` and each of its causes, joined.
fn error_text(error: &ClientError) -> String {
    let mut text = error.to_string();
    let mut source = std::error::Error::source(error);
    while let Some(cause) = source {
        text.push_str(": ");
        text.push_str(&cause.to_string());
        source = cause.source();
    }
    text
}

#[cfg(test)]
mod tests {
    use sidekicks_contracts::jsonrpc::refusal::RefusalCode;

    use super::checked_request;

    #[test]
    fn params_that_break_their_contract_are_refused_before_anything_is_sent() {
        let refused = checked_request("daemon.ping".to_owned(), "[]".to_owned(), Vec::new(), false)
            .expect_err("an array is no params object");
        let data = refused.data.expect("a refusal carries its code");
        assert_eq!(data.refusal, RefusalCode::RequestParamsInvalid.as_str());
        let issues = serde_json::to_value(&data.fields).expect("the fields write as JSON");
        assert!(
            issues["issues"]
                .as_array()
                .is_some_and(|issues| !issues.is_empty()),
            "{issues}"
        );
        let request = checked_request("daemon.ping".to_owned(), "{}".to_owned(), Vec::new(), false)
            .expect("empty params pass");
        assert_eq!(request.descriptor.method, "daemon.ping");
    }
}
