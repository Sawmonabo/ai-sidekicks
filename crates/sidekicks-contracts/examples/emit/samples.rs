//! Values of the contract types whose wire form is written by hand, a `Serialize` or a
//! `JsonSchema` impl of their own or a rule a `#[schemars(transform = …)]` adds, each as serde
//! writes it beside the schema the TypeScript reads it by. The contracts' test checks every value
//! against its schema, so the two cannot drift apart where no derive ties them. A value that
//! cannot be built is written as a fault the test reports, so one wrong sample never stops the
//! emit.

use std::collections::HashMap;

use bytes::Bytes as ByteBuffer;
use schemars::JsonSchema;
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::{Value, json};
use sidekicks_contracts::agent::definition::AgentDefinitionListEntry;
use sidekicks_contracts::agent::definition::requests::AgentDefinitionCreateRequest;
use sidekicks_contracts::agent::methods::AgentConfigUpdateRequest;
use sidekicks_contracts::agent::provider_binding::{
    AgentBindingSwitchDisposition, AgentBindingSwitchTarget,
    AgentProviderBindingChangeFailedPayload, AgentProviderBindingChangedPayload,
};
use sidekicks_contracts::artifacts::manifest::{ArtifactType, Extensible};
use sidekicks_contracts::artifacts::operations::{ARTIFACT_REFUSAL_CODES, ArtifactRefusalCode};
use sidekicks_contracts::browser::SiteOrigin;
use sidekicks_contracts::command::AgentCommandWriteRequest;
use sidekicks_contracts::daemon::config::RunTimeLimitMinutes;
use sidekicks_contracts::event::envelope::EventOccurredAt;
use sidekicks_contracts::event::version::EventEnvelopeVersion;
use sidekicks_contracts::free_form_string::FilesystemPath;
use sidekicks_contracts::highlight::HighlightSpans;
use sidekicks_contracts::jsonrpc::error_code::JsonRpcErrorCode;
use sidekicks_contracts::jsonrpc::message::{JsonRpcId, JsonRpcMessage};
use sidekicks_contracts::machine::settings::BranchNamePattern;
use sidekicks_contracts::mcp::event::McpGovernanceEvent;
use sidekicks_contracts::mcp::server::config::McpServerAddress;
use sidekicks_contracts::mcp::server::inventory::{McpServerLegStatus, McpToolOverride};
use sidekicks_contracts::preview::page::{
    PREVIEW_ZOOM_FACTORS, PreviewImageMediaType, PreviewZoomFactor,
};
use sidekicks_contracts::provider::account::record::{
    CredentialGeneration, DisplayLabel, ProviderAccountId,
};
use sidekicks_contracts::provider::settings::CompactPercent;
use sidekicks_contracts::relay::Hostname;
use sidekicks_contracts::run::events::InterventionDeviceActor;
use sidekicks_contracts::schema::{close_composite_objects, generator};
use sidekicks_contracts::session::cost::UsdMicros;
use sidekicks_contracts::session::draft::SessionAttachmentRefusedCode;
use sidekicks_contracts::session::id::SessionId;
use sidekicks_contracts::skill::{SkillCallFormReadRequest, SkillCreateRequest, SkillListEntry};
use sidekicks_contracts::tag::{Tag, TagList};
use sidekicks_contracts::transcript::run_facts::RUN_STATE_EVENT_TYPES;
use sidekicks_contracts::trust_statement::{CoseAlgorithm, DeviceId};
use sidekicks_contracts::turn::ProviderTurnId;
use sidekicks_contracts::typescript::SchemaContract;
use sidekicks_contracts::web_address::{HttpsAddress, WebAddress};
use sidekicks_contracts::wire::attachment::{Bytes, write};
use sidekicks_contracts::wire::base64::{Base64Array, Base64Bytes, Base64Text, Base64UrlText};
use sidekicks_contracts::wire::date::WireDate;
use sidekicks_contracts::wire::id::{ClientUuid, UuidTextForm};
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::wire::integer::{Port, SafeInt, SafeSignedInt};
use sidekicks_contracts::wire::list::{BoundedVec, UniqueList};
use sidekicks_contracts::wire::number::Percent;
use sidekicks_contracts::wire::record::JsonRecord;
use sidekicks_contracts::wire::text::{
    BoundedText, ComposedText, FreeFormText, NonBlankText, NulFreeText,
};
use sidekicks_contracts::wire::{AnyValue, False, True};
use sidekicks_contracts::workflow::definition::builder::WorkflowWebhookToken;
use sidekicks_contracts::workflow::kind::InputMainHandleId;
use sidekicks_contracts::workflow::run::control::WorkflowCancelReason;
use sidekicks_contracts::workflow::secret::WorkflowSecretReference;

use crate::{EmitResult, point_references_at_owners};

/// The samples and the faults one emit run collects, written as `serializer-samples.json`.
struct SerializerSamples<'owners> {
    /// Each definition's owning module, which every reference in a sample's schema names.
    owners: &'owners HashMap<String, &'static str>,
    /// `{type, schema, value, attachments}` for each sample written.
    samples: Vec<Value>,
    /// `{type, fault}` for each sample that could not be built, written or described.
    faults: Vec<Value>,
}

impl SerializerSamples<'_> {
    /// Adds `built` as serde writes it in a message, with the attachments its byte members write.
    fn add<T: Serialize + JsonSchema>(&mut self, built: EmitResult<T>) {
        let written = built.and_then(|value| write(&value).map_err(Into::into));
        self.add_written::<T>(written);
    }

    /// Adds a value of `T` already written as a message's JSON, with its attachments.
    fn add_written<T: JsonSchema>(&mut self, written: EmitResult<(Vec<u8>, Vec<ByteBuffer>)>) {
        let entry = written.and_then(|(json, attachments)| {
            let value: Value = serde_json::from_slice(&json)?;
            let attachments: Vec<Vec<u8>> = attachments.into_iter().map(Vec::from).collect();
            Ok(json!({
                "type": std::any::type_name::<T>(),
                "schema": sent_schema::<T>(self.owners)?,
                "value": value,
                "attachments": attachments,
            }))
        });
        match entry {
            Ok(sample) => self.samples.push(sample),
            Err(fault) => self.faults.push(json!({
                "type": std::any::type_name::<T>(),
                "fault": fault.to_string(),
            })),
        }
    }
}

/// The schema of `T` as a member holding it reads in the generated folder: a reference to its
/// owner's definition, or the schema itself where every member inlines it, closed and with each
/// reference pointed at its owner, as the emit writes a module's schema.
fn sent_schema<T: JsonSchema>(owners: &HashMap<String, &'static str>) -> EmitResult<Value> {
    let mut generator = generator(SchemaContract::Sent);
    let mut schema = generator.subschema_for::<T>();
    for transform in generator.transforms_mut() {
        transform.transform(&mut schema);
    }
    let mut schema = schema.to_value();
    close_composite_objects(&mut schema);
    point_references_at_owners(&mut schema, "", owners)?;
    Ok(schema)
}

/// `T` read from `value` by its own reader.
fn read<T: DeserializeOwned>(value: Value) -> EmitResult<T> {
    serde_json::from_value(value).map_err(Into::into)
}

/// `value`, or a fault naming the constructor that refused its sample.
fn kept<T>(value: Option<T>, constructor: &str) -> EmitResult<T> {
    value.ok_or_else(|| format!("{constructor} refused the sample").into())
}

/// A JSON-RPC message read from `json` and written again by its own writer.
fn message(json: &str) -> EmitResult<(Vec<u8>, Vec<ByteBuffer>)> {
    let message = JsonRpcMessage::from_slice(json.as_bytes())?;
    Ok((message.to_vec()?, Vec::new()))
}

/// Every sample, as `serializer-samples.json` holds them: `{"samples": [...], "faults": [...]}`.
pub(crate) fn serializer_samples(owners: &HashMap<String, &'static str>) -> Value {
    let mut samples = SerializerSamples {
        owners,
        samples: Vec::new(),
        faults: Vec::new(),
    };
    add_scalars(&mut samples);
    add_texts(&mut samples);
    add_records(&mut samples);
    add_transformed(&mut samples);
    json!({ "samples": samples.samples, "faults": samples.faults })
}

/// The numbers, ids, encodings and literals.
fn add_scalars(samples: &mut SerializerSamples<'_>) {
    samples.add(Ok(CoseAlgorithm::Es256));
    samples.add(Ok(JsonRpcErrorCode::InvalidParams));
    samples.add(Ok(JsonRpcId::String("call-1".into())));
    samples.add(Ok(JsonRpcId::Number(7.into())));
    samples.add(Ok(JsonRpcId::Null));
    samples.add(Ok(True::default()));
    samples.add(Ok(False::default()));
    samples.add(Ok(SessionAttachmentRefusedCode::Value));
    samples.add(Ok(AnyValue(json!({ "nested": [1, "two", null] }))));
    samples.add(SessionId::new("0190F1C4-7E3A-7B1C-9D2E-3F4A5B6C7D8E").map_err(Into::into));
    samples.add(UuidTextForm::new("0190F1C4-7E3A-7B1C-9D2E-3F4A5B6C7D8E").map_err(Into::into));
    samples.add(ClientUuid::new("0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e".into()).map_err(Into::into));
    samples.add(kept(InputMainHandleId::new(3), "InputMainHandleId::new"));
    samples.add(kept(SafeInt::<1>::new(42), "SafeInt::new"));
    samples.add(kept(SafeSignedInt::new(-5), "BoundedInt::new"));
    samples.add(kept(Port::new(8080), "Port::new"));
    samples.add(kept(Percent::new(12.5), "Percent::new"));
    samples.add(kept(
        CredentialGeneration::new(3),
        "CredentialGeneration::new",
    ));
    samples.add(kept(
        RunTimeLimitMinutes::new(60),
        "RunTimeLimitMinutes::new",
    ));
    samples.add(kept(SafeInt::new(1_500), "SafeInt::new").map(UsdMicros));
    samples.add(read::<CompactPercent>(json!(85)));
    samples.add(kept(
        PreviewZoomFactor::new(PREVIEW_ZOOM_FACTORS[5]),
        "PreviewZoomFactor::new",
    ));
    samples.add(Ok(RUN_STATE_EVENT_TYPES[0]));
    samples.add(read::<ArtifactRefusalCode>(json!(
        ARTIFACT_REFUSAL_CODES[0].as_str()
    )));
    samples.add(Ok(Base64Array::<32>::new([7; 32])));
    samples.add(read::<Base64Text<4, 64>>(json!("c2FtcGxl")));
    samples.add(kept(
        Base64UrlText::<1, 64>::encode(b"sample?>"),
        "Base64UrlText::encode",
    ));
    samples.add(read::<Base64Bytes<16>>(json!("c2FtcGxlIQ==")));
    samples.add(kept(
        Bytes::<1, 64>::new(ByteBuffer::from_static(b"sample")),
        "Bytes::new",
    ));
    samples.add(read::<HighlightSpans>(json!([0, 3, 1, 4, 2, 0])));
    samples.add(Ok(Extensible::Known(ArtifactType::File)));
    samples.add(Ok(Extensible::<ArtifactType>::Unknown("hologram".into())));
    samples.add_written::<JsonRpcMessage>(message(
        r#"{"jsonrpc":"2.0","id":1,"method":"session.list","params":{},"protocolVersion":"2026-11-01"}"#,
    ));
    samples.add_written::<JsonRpcMessage>(message(
        r#"{"jsonrpc":"2.0","method":"session.event","params":{"cursor":3}}"#,
    ));
    samples.add_written::<JsonRpcMessage>(message(
        r#"{"jsonrpc":"2.0","id":"call-1","result":{"ok":true}}"#,
    ));
    samples.add_written::<JsonRpcMessage>(message(
        r#"{"jsonrpc":"2.0","id":null,"error":{"code":-32602,"message":"Invalid params"}}"#,
    ));
}

/// The texts, addresses and the instants written as text.
fn add_texts(samples: &mut SerializerSamples<'_>) {
    samples.add(FreeFormText::<64>::new("Fix the build".into()).map_err(Into::into));
    samples.add(kept(
        BoundedText::<1, 64>::new("x".into()),
        "BoundedText::new",
    ));
    samples.add(NulFreeText::<64>::new(" ".into()).map_err(Into::into));
    samples.add(read::<ComposedText>(json!("A composed reply")));
    samples.add(kept(NonBlankText::new(" a".into()), "NonBlankText::new"));
    samples.add(kept(
        ProviderAccountId::new("account-1".into()),
        "ProviderAccountId::new",
    ));
    samples.add(ProviderTurnId::new("turn_01".into()).map_err(Into::into));
    samples.add(FilesystemPath::new("/tmp/project".into()).map_err(Into::into));
    samples.add(read::<DisplayLabel>(json!("  Work account  ")));
    samples.add(kept(Tag::new("billing/stripe".into()), "Tag::new"));
    samples.add(kept(
        Hostname::new("relay.example.com.".into()),
        "Hostname::new",
    ));
    samples.add(kept(
        HttpsAddress::<2048>::new(" https://example.com/docs "),
        "HttpsAddress::new",
    ));
    samples.add(kept(
        WebAddress::new("http://localhost:5173/"),
        "WebAddress::new",
    ));
    samples.add(kept(
        McpServerAddress::new("http://127.0.0.1:8931/mcp"),
        "McpServerAddress::new",
    ));
    samples.add(kept(
        SiteOrigin::new("https://example.com".into()),
        "SiteOrigin::new",
    ));
    samples.add(read::<PreviewImageMediaType>(json!("image/svg+xml")));
    samples.add(read::<WorkflowSecretReference>(json!(
        "secret://shared/deploy-key"
    )));
    samples.add(kept(
        WorkflowWebhookToken::new("whk_sample".into()),
        "WorkflowWebhookToken::new",
    ));
    samples.add(kept(
        WorkflowCancelReason::new("No longer needed".into()),
        "WorkflowCancelReason::new",
    ));
    samples.add(read::<BranchNamePattern>(json!("feat/{title}")));
    samples.add(kept(
        EventEnvelopeVersion::new("1.0".into()),
        "EventEnvelopeVersion::new",
    ));
    samples.add(Ok(EventOccurredAt::now()));
    samples.add(EventOccurredAt::new("2026-11-14T10:00:00+01:00".into()).map_err(Into::into));
    samples.add(Ok(WireInstant::now()));
    samples.add(read::<WireDate>(json!("2026-11-14")));
    samples.add(
        kept(DeviceId::new("device-1".into()), "DeviceId::new").and_then(|device_id| {
            kept(
                InterventionDeviceActor::new(device_id),
                "InterventionDeviceActor::new",
            )
        }),
    );
}

/// The lists, the maps and the stored event.
fn add_records(samples: &mut SerializerSamples<'_>) {
    let texts = ["first", "second"].map(|text| FreeFormText::<64>::new(text.into()));
    samples.add(
        texts
            .clone()
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
            .and_then(|items| kept(BoundedVec::<_, 1, 4>::new(items), "BoundedVec::new")),
    );
    samples.add(
        texts
            .into_iter()
            .collect::<Result<Vec<_>, _>>()
            .map_err(Into::into)
            .and_then(|items| kept(UniqueList::<_, 0, 8>::new(items), "UniqueList::new")),
    );
    samples.add(read::<TagList>(json!(["ops", "billing/stripe"])));
    samples.add(read::<JsonRecord>(
        json!({ "tool": "build", "attempts": 2 }),
    ));
    samples.add(read::<McpGovernanceEvent>(json!({
        "id": "event-1",
        "sessionId": "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e",
        "sequence": 4,
        "occurredAt": "2026-11-14T10:00:00.000Z",
        "category": "mcpGovernance",
        "type": "mcp.server.added",
        "payload": {},
        "version": "1.0",
    })));
}

/// The types a `#[schemars(transform = …)]` adds a rule to, each on the arm where its rule holds
/// something: a plugin's or a provider's origin with its name, a project scope with its project, a
/// failure with its reason, a model move with its window and a brief with its losses.
fn add_transformed(samples: &mut SerializerSamples<'_>) {
    let session_id = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8e";
    let agent_id = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d8f";
    let project_id = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d90";
    let skill_create_uuid = "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d93";
    let claude = json!({
        "providerName": "claude",
        "modelId": "claude-opus-4-5",
        "providerAccountId": null,
        "effort": null,
    });
    let codex = json!({
        "providerName": "codex",
        "modelId": "gpt-5.1",
        "providerAccountId": "account-1",
        "effort": "high",
    });
    let brief_losses = json!(["conversationHistorySummarized", "providerPrivateReasoning"]);
    samples.add(read::<McpServerLegStatus>(json!({
        "sessionId": session_id,
        "bindingId": "binding-1",
        "status": "failed",
        "failedReason": "commandNotRunnable",
    })));
    samples.add(read::<McpToolOverride>(json!({
        "toolName": "search",
        "approvalMode": "prompt",
    })));
    samples.add(read::<AgentDefinitionListEntry>(json!({
        "definitionId": "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d91",
        "name": "reviewer",
        "description": "Reviews a change.",
        "icon": null,
        "accentHue": null,
        "bindings": { "default": claude, "overrides": [] },
        "instructions": "Review the change.",
        "goal": null,
        "toolAllowlist": null,
        "turnCap": null,
        "hooks": null,
        "memoryScope": null,
        "createdAt": "2026-11-14T10:00:00.000Z",
        "updatedAt": "2026-11-14T10:00:00.000Z",
        "origin": "plugin",
        "pluginName": "review-kit",
        "scope": "project",
        "projectId": project_id,
        "sourcePath": "/tmp/project/agents/reviewer.md",
        "orphaned": false,
        "disabledInProvider": false,
        "loadError": null,
    })));
    samples.add(read::<AgentDefinitionCreateRequest>(json!({
        "name": "reviewer",
        "bindings": { "default": claude },
        "scope": "project",
        "projectId": project_id,
    })));
    samples.add(read::<AgentConfigUpdateRequest>(json!({
        "agentId": agent_id,
        "modelId": "claude-opus-4-5",
        "largerWindow": 1_000_000,
    })));
    samples.add(read::<AgentBindingSwitchTarget>(json!({
        "modelId": "gpt-5.1",
        "largerWindow": null,
    })));
    samples.add(read::<AgentBindingSwitchDisposition>(json!({
        "status": "degraded",
        "switchId": "switch-1",
        "continuity": "brief",
        "declaredLosses": brief_losses,
    })));
    samples.add(read::<AgentBindingSwitchDisposition>(json!({
        "status": "failed",
        "switchId": "switch-1",
        "reason": "accountUnavailable",
        "accountState": "reauthRequired",
    })));
    samples.add(read::<AgentProviderBindingChangedPayload>(json!({
        "switchId": "switch-1",
        "declaredLosses": brief_losses,
        "continuity": "brief",
        "sessionId": session_id,
        "agentId": agent_id,
        "actor": "device-1",
        "from": claude,
        "to": codex,
        "landedProviderAccountId": "account-1",
    })));
    samples.add(read::<AgentProviderBindingChangeFailedPayload>(json!({
        "switchId": "switch-1",
        "reason": "accountUnavailable",
        "accountState": "reauthRequired",
        "sessionId": session_id,
        "agentId": agent_id,
        "actor": "device-1",
        "from": claude,
        "attempted": { "providerAccountId": "account-2" },
    })));
    samples.add(read::<SkillListEntry>(json!({
        "skillId": "0190f1c4-7e3a-7b1c-9d2e-3f4a5b6c7d92",
        "name": "review",
        "description": null,
        "icon": null,
        "origin": "provider",
        "originProvider": "claude",
        "scope": "project",
        "projectId": project_id,
        "folderPath": "/tmp/project/skills/review",
        "files": [{ "path": "/tmp/project/skills/review/SKILL.md", "size": 120, "readable": true }],
        "availability": [{ "provider": "claude", "available": true }],
        "callForms": [{ "provider": "claude", "callForm": "/review" }],
        "orphaned": false,
        "disabledInProvider": [],
        "loadError": null,
    })));
    samples.add(read::<SkillCreateRequest>(json!({
        "name": "review",
        "description": "Reviews a change.",
        "body": "Read the diff.",
        "scope": "project",
        "projectId": project_id,
        "clientIdempotencyKey": skill_create_uuid,
    })));
    samples.add(read::<SkillCallFormReadRequest>(json!({
        "name": "review",
        "scope": "project",
        "projectId": project_id,
    })));
    samples.add(read::<AgentCommandWriteRequest>(json!({
        "sessionId": session_id,
        "commandId": "command-1",
        "endOfInput": true,
    })));
}
