//! What a provider's driver declares for the screens to draw by kind: its own rows on its Settings
//! section (a setting, a status or an action) and the options a session of it takes, each with the
//! words a person reads and the check a value sent for it is held to.

use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

use crate::place::Place;
use crate::typescript::{Definition, TypeScriptModule, ts_constants};
use crate::wire::integer::BoundedInt;
use crate::wire::list::{BoundedVec, ListKey, UniqueList};
use crate::wire::record::RecordKey;
use crate::wire::text::{FreeFormText, pattern_text};

ts_constants! {
    /// The longest label, line or reason a declaration carries.
    pub const PROVIDER_DECLARATION_TEXT_MAX_LEN: usize = 512;
    /// The longest value a choice or a text setting holds.
    pub const PROVIDER_VALUE_MAX_LEN: usize = 4096;
    /// The most options one choice lists.
    pub const PROVIDER_CHOICE_OPTIONS_MAX: usize = 256;
}

pattern_text! {
    /// The id a driver gives one of its rows or options, unique within its provider: a lowercase
    /// letter, then up to 63 letters or digits (`outputStyle`). Opaque to every client.
    pub struct ProviderDeclarationId("^[a-z][A-Za-z0-9]{0,63}$") branded;
}

/// A declaration id names a member of a record keyed by row, never `__proto__`, which its
/// pattern refuses.
impl RecordKey for ProviderDeclarationId {
    fn is_prototype_key(&self) -> bool {
        false
    }
}

/// A label, a line or a reason in the words a person reads.
pub type ProviderDeclarationText = FreeFormText<PROVIDER_DECLARATION_TEXT_MAX_LEN>;
/// The value a choice or a text setting holds.
pub type ProviderValueText = FreeFormText<PROVIDER_VALUE_MAX_LEN>;

/// One place's on-or-off for a per-place switch. A computer without a WSL 2 distribution has one
/// entry and names no place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderPlaceSwitch {
    /// The place; absent on a computer without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// Whether the switch is on there.
    pub enabled: bool,
}

impl ListKey for ProviderPlaceSwitch {
    type Key = Option<Place>;

    fn list_key(&self) -> Option<Place> {
        self.place.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// Every place's entry of one per-place switch, Windows first and then each distribution in WSL's
/// list order on a computer with a WSL 2 distribution, else one entry naming no place.
pub type ProviderPlaceSwitches = UniqueList<ProviderPlaceSwitch, 1, { usize::MAX }>;

/// The words an action row reads in while it runs and when it fails, each failure followed by the
/// provider's own reason.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderActionWords {
    /// While it is being done.
    pub doing: ProviderDeclarationText,
    /// While it is being undone.
    pub undoing: ProviderDeclarationText,
    /// When doing it failed.
    pub do_failed: ProviderDeclarationText,
    /// When undoing it failed.
    pub undo_failed: ProviderDeclarationText,
}

/// Where an action stands in one place beyond whether it is done: settled, running, or failed with
/// the provider's reason, the switch back where it was.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "state",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderActionProgress {
    /// Nothing is running.
    Settled {},
    /// A run is in progress.
    Running {
        /// Whether it is doing the action, not undoing it.
        is_doing: bool,
        /// Whether the driver can stop it.
        can_stop: bool,
    },
    /// The last run failed.
    Failed {
        /// Whether it was doing the action, not undoing it.
        is_doing: bool,
        /// The provider's own reason.
        reason: ProviderDeclarationText,
    },
}

/// One place's state of an action row. A computer without a WSL 2 distribution has one entry and
/// names no place.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderActionPlace {
    /// The place; absent on a computer without a WSL 2 distribution.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "Place")]
    pub place: Option<Place>,
    /// Whether the action is done there.
    pub is_done: bool,
    /// Its run there, if any.
    pub progress: ProviderActionProgress,
}

impl ListKey for ProviderActionPlace {
    type Key = Option<Place>;

    fn list_key(&self) -> Option<Place> {
        self.place.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// Every place's state of one action row, in the order of [`ProviderPlaceSwitches`].
pub type ProviderActionPlaces = UniqueList<ProviderActionPlace, 1, { usize::MAX }>;

/// One option of a choice: its value, the words it reads in, and the provider's reason where it
/// cannot be picked, which draws it dimmed.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderChoiceOption {
    /// The value a pick sends.
    pub value: ProviderValueText,
    /// The option's words.
    pub label: ProviderDeclarationText,
    /// The line describing it, where it has one.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderDeclarationText")]
    pub line: Option<ProviderDeclarationText>,
    /// Why it cannot be picked, in the provider's words; absent while it can.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "crate::wire::present"
    )]
    #[schemars(with = "ProviderDeclarationText")]
    pub unavailable_reason: Option<ProviderDeclarationText>,
}

/// The options one choice lists, in the provider's order.
pub type ProviderChoiceOptions = BoundedVec<ProviderChoiceOption, 1, PROVIDER_CHOICE_OPTIONS_MAX>;

/// The longest text one text setting takes, at most [`PROVIDER_VALUE_MAX_LEN`].
pub type ProviderTextMaxLength = BoundedInt<1, { PROVIDER_VALUE_MAX_LEN as i64 }>;

/// What a setting row holds, by kind, with its live value: the app's own value once it is changed
/// in the app, else the one the provider's own settings resolve.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "control",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderSettingControl {
    /// An on-or-off per place.
    Switch {
        /// Each place's entry.
        places: ProviderPlaceSwitches,
    },
    /// One of a list of options.
    Choice {
        /// The option it is on, or `null` for none, which only a choice with `noneLabel` takes.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<ProviderValueText>")]
        value: Option<ProviderValueText>,
        /// The words of the pick that sets none, where the choice offers one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderDeclarationText")]
        none_label: Option<ProviderDeclarationText>,
        /// The options.
        options: ProviderChoiceOptions,
    },
    /// Free text up to a length.
    Text {
        /// The text, or `null` while none is set.
        #[serde(deserialize_with = "crate::wire::nullable")]
        #[schemars(with = "crate::wire::NullableSchema<ProviderValueText>")]
        value: Option<ProviderValueText>,
        /// The longest text it takes, in code points.
        max_length: ProviderTextMaxLength,
    },
}

/// One row a provider's driver declares on its Settings section, drawn by its kind.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "kind",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderRow {
    /// A value kept in the app and passed to the app's own sessions, changed through
    /// `provider.update`.
    Setting {
        /// The row's id.
        id: ProviderDeclarationId,
        /// The row's label.
        label: ProviderDeclarationText,
        /// The line under it, where it has one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderDeclarationText")]
        line: Option<ProviderDeclarationText>,
        /// What it holds.
        control: ProviderSettingControl,
    },
    /// A read-only fact the provider reports.
    Status {
        /// The row's id.
        id: ProviderDeclarationId,
        /// The row's label.
        label: ProviderDeclarationText,
        /// The line under it, where it has one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderDeclarationText")]
        line: Option<ProviderDeclarationText>,
        /// The fact, in the provider's words.
        text: ProviderDeclarationText,
    },
    /// Something the driver does in the person's own provider install, drawn as a switch per place
    /// whose state is whether it is done there, with its run in progress or its failure beside it.
    Action {
        /// The row's id.
        id: ProviderDeclarationId,
        /// The row's label.
        label: ProviderDeclarationText,
        /// The line under it, where it has one.
        #[serde(
            default,
            skip_serializing_if = "Option::is_none",
            deserialize_with = "crate::wire::present"
        )]
        #[schemars(with = "ProviderDeclarationText")]
        line: Option<ProviderDeclarationText>,
        /// The words its runs and failures read in.
        words: ProviderActionWords,
        /// Each place's state.
        places: ProviderActionPlaces,
    },
}

impl ProviderRow {
    /// The row's id.
    pub fn id(&self) -> &ProviderDeclarationId {
        match self {
            Self::Setting { id, .. } | Self::Status { id, .. } | Self::Action { id, .. } => id,
        }
    }
}

impl ListKey for ProviderRow {
    type Key = ProviderDeclarationId;

    fn list_key(&self) -> ProviderDeclarationId {
        self.id().clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// A value sent for one declared setting or session option: on or off, or a text.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(untagged)]
pub enum ProviderValue {
    /// On or off.
    Switch(bool),
    /// A choice's option or a text setting's text.
    Text(ProviderValueText),
}

/// Why a value does not fit the declaration it was sent for.
#[derive(Clone, Copy, Debug, PartialEq, Eq, thiserror::Error)]
pub enum DeclarationValueError {
    /// The value is of another kind than the declaration takes.
    #[error("the value is not of the kind the declaration takes")]
    WrongKind,
    /// The declaration takes no value of its own: a status, or an action, which runs through its
    /// own request.
    #[error("the row takes no value")]
    NotSettable,
    /// A choice was sent none, which it does not offer.
    #[error("the choice offers no none")]
    NoneNotOffered,
    /// A choice was sent a value none of its options holds.
    #[error("the value is none of the choice's options")]
    NotAnOption,
    /// A choice was sent an option that cannot be picked.
    #[error("the option cannot be picked")]
    OptionUnavailable,
    /// A text setting was sent a text longer than it takes.
    #[error("the text is longer than the setting takes")]
    TextTooLong,
}

/// Checks `value` against the options of a choice: `None` only where it offers none, else one of
/// its options that can be picked.
fn check_choice(
    value: Option<&ProviderValue>,
    none_label: Option<&ProviderDeclarationText>,
    options: &ProviderChoiceOptions,
) -> Result<(), DeclarationValueError> {
    let picked = match value {
        None if none_label.is_some() => return Ok(()),
        None => return Err(DeclarationValueError::NoneNotOffered),
        Some(ProviderValue::Switch(_)) => return Err(DeclarationValueError::WrongKind),
        Some(ProviderValue::Text(text)) => text,
    };
    let option = options
        .as_slice()
        .iter()
        .find(|option| option.value == *picked)
        .ok_or(DeclarationValueError::NotAnOption)?;
    match option.unavailable_reason {
        Some(_) => Err(DeclarationValueError::OptionUnavailable),
        None => Ok(()),
    }
}

impl ProviderRow {
    /// Checks a value `provider.update` sends for this row, `None` being its `null`: a switch takes
    /// on or off, a choice one of its options that can be picked (or none where it offers that),
    /// and a text a text within its length (or none). A status or an action takes no value.
    pub fn check_value(&self, value: Option<&ProviderValue>) -> Result<(), DeclarationValueError> {
        let control = match self {
            Self::Setting { control, .. } => control,
            Self::Status { .. } | Self::Action { .. } => {
                return Err(DeclarationValueError::NotSettable);
            }
        };
        match (control, value) {
            (ProviderSettingControl::Switch { .. }, Some(ProviderValue::Switch(_))) => Ok(()),
            (ProviderSettingControl::Switch { .. }, Some(ProviderValue::Text(_)) | None) => {
                Err(DeclarationValueError::WrongKind)
            }
            (
                ProviderSettingControl::Choice {
                    none_label,
                    options,
                    ..
                },
                value,
            ) => check_choice(value, none_label.as_ref(), options),
            (ProviderSettingControl::Text { .. }, None) => Ok(()),
            (ProviderSettingControl::Text { .. }, Some(ProviderValue::Switch(_))) => {
                Err(DeclarationValueError::WrongKind)
            }
            (ProviderSettingControl::Text { max_length, .. }, Some(ProviderValue::Text(text))) => {
                let length = i64::try_from(text.as_str().chars().count()).unwrap_or(i64::MAX);
                if length > max_length.get() {
                    Err(DeclarationValueError::TextTooLong)
                } else {
                    Ok(())
                }
            }
        }
    }
}

/// Where a session option is drawn in the session's composer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase")]
pub enum ProviderSessionOptionPlacement {
    /// In the effort menu, under its levels.
    EffortMenu,
}

/// What a session option holds, by kind; each agent's value travels on its binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(
    tag = "control",
    rename_all = "camelCase",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum ProviderSessionOptionControl {
    /// On or off.
    Switch {},
    /// One of a list of options.
    Choice {
        /// The options.
        options: ProviderChoiceOptions,
    },
}

/// One option a provider's driver declares on its sessions, drawn by its kind where its placement
/// says, and shown on a session only where the provider reports it available there.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderSessionOption {
    /// The option's id.
    pub id: ProviderDeclarationId,
    /// The option's label.
    pub label: ProviderDeclarationText,
    /// Where it is drawn.
    pub placement: ProviderSessionOptionPlacement,
    /// What it holds.
    pub control: ProviderSessionOptionControl,
}

impl ProviderSessionOption {
    /// Checks a value sent for this option: a switch takes on or off, a choice one of its options
    /// that can be picked.
    pub fn check_value(&self, value: &ProviderValue) -> Result<(), DeclarationValueError> {
        match (&self.control, value) {
            (ProviderSessionOptionControl::Switch {}, ProviderValue::Switch(_)) => Ok(()),
            (ProviderSessionOptionControl::Switch {}, ProviderValue::Text(_)) => {
                Err(DeclarationValueError::WrongKind)
            }
            (ProviderSessionOptionControl::Choice { options }, value) => {
                check_choice(Some(value), None, options)
            }
        }
    }
}

impl ListKey for ProviderSessionOption {
    type Key = ProviderDeclarationId;

    fn list_key(&self) -> ProviderDeclarationId {
        self.id.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// One session option's value as it is set on an agent's binding.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderOptionSetting {
    /// The option.
    pub id: ProviderDeclarationId,
    /// Its value.
    pub value: ProviderValue,
}

impl ListKey for ProviderOptionSetting {
    type Key = ProviderDeclarationId;

    fn list_key(&self) -> ProviderDeclarationId {
        self.id.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// One session option as the provider reports it on a live binding, read after each start and
/// each change: its value in effect, and whether this session can run it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize, JsonSchema)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ObservedProviderOption {
    /// The option.
    pub id: ProviderDeclarationId,
    /// The value in effect.
    pub value: ProviderValue,
    /// Whether this session can run it; an option it cannot run is not drawn.
    pub is_available: bool,
}

impl ListKey for ObservedProviderOption {
    type Key = ProviderDeclarationId;

    fn list_key(&self) -> ProviderDeclarationId {
        self.id.clone()
    }

    // It carries no rule its read does not hold.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// The session options set on an agent's binding, at most one value per option.
pub type ProviderOptionSettings = UniqueList<ProviderOptionSetting, 1, { usize::MAX }>;
/// The session options a live binding reports, at most one per option.
pub type ObservedProviderOptions = UniqueList<ObservedProviderOption, 1, { usize::MAX }>;

/// The TypeScript module of the declarations.
pub(crate) const TYPESCRIPT_MODULE: TypeScriptModule = TypeScriptModule {
    path: "provider/declaration",
    doc: "What a provider's driver declares for the screens to draw by kind: its own Settings rows \
          and the options a session of it takes.",
    definitions: &[
        Definition::read::<ProviderDeclarationId>(),
        Definition::read::<ProviderPlaceSwitch>(),
        Definition::read::<ProviderActionWords>(),
        Definition::read::<ProviderActionProgress>(),
        Definition::read::<ProviderActionPlace>(),
        Definition::read::<ProviderChoiceOption>(),
        Definition::read::<ProviderSettingControl>(),
        Definition::read::<ProviderRow>().checked(),
        Definition::read::<ProviderValue>().checked(),
        Definition::read::<ProviderSessionOptionPlacement>(),
        Definition::read::<ProviderSessionOptionControl>(),
        Definition::read::<ProviderSessionOption>().checked(),
        Definition::read::<ProviderOptionSetting>(),
        Definition::read::<ObservedProviderOption>(),
    ],
    constants: TS_CONSTANTS,
    method_tables: &[],
};

#[cfg(test)]
mod tests {
    use rstest::rstest;
    use serde_json::{Value, json};

    use super::{DeclarationValueError, ProviderRow, ProviderSessionOption, ProviderValue};

    fn choice_row() -> Value {
        json!({
            "kind": "setting",
            "id": "advisor",
            "label": "Advisor",
            "control": {
                "control": "choice",
                "value": null,
                "noneLabel": "No advisor",
                "options": [
                    {"value": "opus", "label": "Opus"},
                    {"value": "fable", "label": "Fable", "unavailableReason": "Not on this plan"},
                ],
            },
        })
    }

    fn text_row() -> Value {
        json!({
            "kind": "setting",
            "id": "note",
            "label": "Note",
            "control": {"control": "text", "value": null, "maxLength": 4},
        })
    }

    fn switch_row() -> Value {
        json!({
            "kind": "setting",
            "id": "terminalSessionsReachable",
            "label": "Reach sessions started in a terminal",
            "line": "Runs one service while it is on.",
            "control": {"control": "switch", "places": [{"enabled": true}]},
        })
    }

    #[rstest]
    #[case::switch_setting(switch_row())]
    #[case::choice_setting(choice_row())]
    #[case::text_setting(text_row())]
    #[case::status(json!({"kind": "status", "id": "build", "label": "Build", "text": "Stable"}))]
    #[case::action(json!({
        "kind": "action",
        "id": "terminalPlugin",
        "label": "Use the app in the terminal",
        "words": {
            "doing": "Installing…",
            "undoing": "Removing…",
            "doFailed": "Couldn't install the plugin",
            "undoFailed": "Couldn't remove the plugin",
        },
        "places": [
            {"place": "windows", "isDone": false, "progress": {"state": "running", "isDoing": true, "canStop": false}},
            {"place": {"distro": "Ubuntu"}, "isDone": true, "progress": {"state": "settled"}},
            {"place": {"distro": "Debian"}, "isDone": false, "progress": {"state": "failed", "isDoing": true, "reason": "no network"}},
        ],
    }))]
    fn a_declared_row_of_each_kind_writes_back_as_read(#[case] row: Value) {
        let read: ProviderRow = serde_json::from_value(row.clone()).expect("the row reads");
        let written = serde_json::to_value(&read).expect("the row writes");
        assert_eq!(written, row);
    }

    #[test]
    fn a_declared_session_option_of_each_kind_writes_back_as_read() {
        for option in [
            json!({"id": "ultra", "label": "Ultra", "placement": "effortMenu", "control": {"control": "switch"}}),
            json!({
                "id": "style",
                "label": "Style",
                "placement": "effortMenu",
                "control": {"control": "choice", "options": [{"value": "a", "label": "A"}]},
            }),
        ] {
            let read: ProviderSessionOption =
                serde_json::from_value(option.clone()).expect("the option reads");
            assert_eq!(
                serde_json::to_value(&read).expect("the option writes"),
                option
            );
        }
    }

    fn value(json: Value) -> Option<ProviderValue> {
        serde_json::from_value::<Option<ProviderValue>>(json).expect("the value reads")
    }

    #[rstest]
    #[case::switch_takes_on(switch_row(), json!(true), Ok(()))]
    #[case::switch_refuses_text(switch_row(), json!("on"), Err(DeclarationValueError::WrongKind))]
    #[case::switch_refuses_none(switch_row(), json!(null), Err(DeclarationValueError::WrongKind))]
    #[case::choice_takes_an_option(choice_row(), json!("opus"), Ok(()))]
    #[case::choice_takes_its_none(choice_row(), json!(null), Ok(()))]
    #[case::choice_refuses_an_unlisted_value(
        choice_row(),
        json!("haiku"),
        Err(DeclarationValueError::NotAnOption)
    )]
    #[case::choice_refuses_an_unavailable_option(
        choice_row(),
        json!("fable"),
        Err(DeclarationValueError::OptionUnavailable)
    )]
    #[case::choice_refuses_a_switch(choice_row(), json!(false), Err(DeclarationValueError::WrongKind))]
    #[case::text_takes_text_within_its_length(text_row(), json!("four"), Ok(()))]
    #[case::text_refuses_longer_text(text_row(), json!("fives"), Err(DeclarationValueError::TextTooLong))]
    #[case::status_takes_nothing(
        json!({"kind": "status", "id": "build", "label": "Build", "text": "Stable"}),
        json!(true),
        Err(DeclarationValueError::NotSettable)
    )]
    fn a_value_is_held_to_its_declaration(
        #[case] row: Value,
        #[case] sent: Value,
        #[case] expected: Result<(), DeclarationValueError>,
    ) {
        let row: ProviderRow = serde_json::from_value(row).expect("the row reads");
        assert_eq!(row.check_value(value(sent).as_ref()), expected);
    }

    #[test]
    fn a_choice_without_none_refuses_none_and_an_option_refuses_another_kind() {
        let mut row = choice_row();
        row["control"]
            .as_object_mut()
            .expect("the control is an object")
            .remove("noneLabel");
        let row: ProviderRow = serde_json::from_value(row).expect("the row reads");
        assert_eq!(
            row.check_value(None),
            Err(DeclarationValueError::NoneNotOffered)
        );

        let option: ProviderSessionOption = serde_json::from_value(
            json!({"id": "ultra", "label": "Ultra", "placement": "effortMenu", "control": {"control": "switch"}}),
        )
        .expect("the option reads");
        assert_eq!(option.check_value(&ProviderValue::Switch(true)), Ok(()));
        assert_eq!(
            option.check_value(&value(json!("on")).expect("a text")),
            Err(DeclarationValueError::WrongKind)
        );
    }
}
