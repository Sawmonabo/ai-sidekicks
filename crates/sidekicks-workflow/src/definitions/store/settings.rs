//! The settings kept beside a workflow's versions, each stored on the definition in one write that
//! mints no version: the canvas layout, the tags, the permission level, the background browser and
//! the pinned data.

use std::borrow::Cow;

use rusqlite::types::Value;
use sidekicks_contracts::wire::instant::WireInstant;
use sidekicks_contracts::workflow::definition::builder::{
    WorkflowBackgroundBrowserUpdateRequest, WorkflowBackgroundBrowserUpdateResponse,
    WorkflowDefinitionSettingResponse, WorkflowLayoutUpdateRequest,
    WorkflowPermissionLevelUpdateRequest, WorkflowPermissionLevelUpdateResponse,
    WorkflowPinDataUpdateRequest, WorkflowPinDataUpdateResponse, WorkflowTagsUpdateRequest,
};
use sidekicks_contracts::workflow::definition::document::WorkflowDefinitionId;
use sidekicks_store::database::statement::{StatementBindings, WriteStatement, text_binding};
use sidekicks_store::database::writer::WriteError;

use super::{WorkflowDefinitionStore, WorkflowDefinitionStoreError, json_text};
use crate::not_found::WorkflowNotFound;

const UPDATE_LAYOUT_SQL: &str = "UPDATE workflow_definitions SET layout_json = @value,
  updated_at = @updated_at WHERE id = @definition_id AND deleted_at IS NULL";

const UPDATE_TAGS_SQL: &str = "UPDATE workflow_definitions SET tags = @value,
  updated_at = @updated_at WHERE id = @definition_id AND deleted_at IS NULL";

const UPDATE_PERMISSION_LEVEL_SQL: &str =
    "UPDATE workflow_definitions SET permission_level = @value,
  updated_at = @updated_at WHERE id = @definition_id AND deleted_at IS NULL";

const UPDATE_BACKGROUND_BROWSER_SQL: &str = "UPDATE workflow_definitions
  SET background_browser = @value, updated_at = @updated_at
  WHERE id = @definition_id AND deleted_at IS NULL";

// A merge patch sets the node's items, or removes the node at a JSON null, in one statement, so a
// concurrent pin onto another node is never lost; an empty map is stored as nothing pinned.
const UPDATE_PIN_DATA_SQL: &str = "UPDATE workflow_definitions SET pin_data_json = NULLIF(
    json_patch(COALESCE(pin_data_json, '{}'), json_object(@node_id, json(@items_json))), '{}'
  ), updated_at = @updated_at
  WHERE id = @definition_id AND deleted_at IS NULL";

impl WorkflowDefinitionStore {
    /// Stores the canvas layout on the definition, minting no version; saved versions keep the
    /// layout they were written with. Each setting fails with
    /// [`WorkflowDefinitionStoreError::NotFound`] for a workflow not in the library.
    #[expect(dead_code, reason = "the workflow builder's settings handlers")]
    pub(crate) async fn update_layout(
        &self,
        request: &WorkflowLayoutUpdateRequest,
    ) -> Result<WorkflowDefinitionSettingResponse, WorkflowDefinitionStoreError> {
        self.write_setting(
            request.definition_id,
            UPDATE_LAYOUT_SQL,
            json_text(&request.layout),
        )
        .await
    }

    /// Replaces the workflow's tags, minting no version.
    #[expect(dead_code, reason = "the workflow builder's settings handlers")]
    pub(crate) async fn update_tags(
        &self,
        request: &WorkflowTagsUpdateRequest,
    ) -> Result<WorkflowDefinitionSettingResponse, WorkflowDefinitionStoreError> {
        self.write_setting(
            request.definition_id,
            UPDATE_TAGS_SQL,
            json_text(&request.tags),
        )
        .await
    }

    /// Sets the level every run of the workflow uses, minting no version.
    #[expect(dead_code, reason = "the workflow builder's settings handlers")]
    pub(crate) async fn update_permission_level(
        &self,
        request: &WorkflowPermissionLevelUpdateRequest,
    ) -> Result<WorkflowPermissionLevelUpdateResponse, WorkflowDefinitionStoreError> {
        let level: &'static str = request.level.into();
        self.write_setting(
            request.definition_id,
            UPDATE_PERMISSION_LEVEL_SQL,
            level.to_owned(),
        )
        .await?;
        Ok(WorkflowPermissionLevelUpdateResponse {
            definition_id: request.definition_id,
            level: request.level,
        })
    }

    /// Sets the background browser every later run of the workflow uses, minting no version.
    #[expect(dead_code, reason = "the workflow builder's settings handlers")]
    pub(crate) async fn update_background_browser(
        &self,
        request: &WorkflowBackgroundBrowserUpdateRequest,
    ) -> Result<WorkflowBackgroundBrowserUpdateResponse, WorkflowDefinitionStoreError> {
        let pick: &'static str = request.pick.into();
        self.write_setting(
            request.definition_id,
            UPDATE_BACKGROUND_BROWSER_SQL,
            pick.to_owned(),
        )
        .await?;
        Ok(WorkflowBackgroundBrowserUpdateResponse {
            definition_id: request.definition_id,
            pick: request.pick,
        })
    }

    /// Pins items onto one node, or unpins it with `None`, minting no version.
    #[expect(dead_code, reason = "the workflow builder's settings handlers")]
    pub(crate) async fn update_pin_data(
        &self,
        request: &WorkflowPinDataUpdateRequest,
    ) -> Result<WorkflowPinDataUpdateResponse, WorkflowDefinitionStoreError> {
        let definition_id = request.definition_id;
        let updated_at = WireInstant::now();
        self.write_to_live_definition(
            WriteStatement {
                sql: Cow::Borrowed(UPDATE_PIN_DATA_SQL),
                bindings: StatementBindings::Named(vec![
                    text_binding("@node_id", request.node_id.as_str()),
                    (
                        Cow::Borrowed("@items_json"),
                        Value::Text(json_text(&request.items)),
                    ),
                    text_binding("@updated_at", updated_at.as_str()),
                    text_binding("@definition_id", definition_id.text().as_str()),
                ]),
                expected_row_count: Some(1),
            },
            definition_id,
        )
        .await?;
        Ok(WorkflowPinDataUpdateResponse {
            definition_id,
            node_id: request.node_id.clone(),
            pinned: request.items.is_some(),
        })
    }

    async fn write_setting(
        &self,
        definition_id: WorkflowDefinitionId,
        sql: &'static str,
        value: String,
    ) -> Result<WorkflowDefinitionSettingResponse, WorkflowDefinitionStoreError> {
        let updated_at = WireInstant::now();
        self.write_to_live_definition(
            WriteStatement {
                sql: Cow::Borrowed(sql),
                bindings: StatementBindings::Named(vec![
                    (Cow::Borrowed("@value"), Value::Text(value)),
                    text_binding("@updated_at", updated_at.as_str()),
                    text_binding("@definition_id", definition_id.text().as_str()),
                ]),
                expected_row_count: Some(1),
            },
            definition_id,
        )
        .await?;
        Ok(WorkflowDefinitionSettingResponse {
            definition_id,
            updated_at,
        })
    }

    // Runs one change that must touch the live definition's row, else refuses it as not found.
    async fn write_to_live_definition(
        &self,
        statement: WriteStatement,
        definition_id: WorkflowDefinitionId,
    ) -> Result<(), WorkflowDefinitionStoreError> {
        match self.writer.write(vec![statement]).await {
            Ok(_) => Ok(()),
            Err(WriteError::Refused { .. }) => {
                Err(WorkflowNotFound::Definition { definition_id }.into())
            }
            Err(error) => Err(error.into()),
        }
    }
}
