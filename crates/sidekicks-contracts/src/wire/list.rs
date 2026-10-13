//! Lists on the wire, each with the bounds its schema states.

use std::borrow::Cow;
use std::collections::hash_map::Entry;

use schemars::{JsonSchema, Schema, SchemaGenerator};
use serde::de::Error as _;
use serde::{Deserialize, Deserializer, Serialize};

/// A list of `MIN..=MAX` items (`usize::MAX` leaves it bounded only by the message cap).
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize)]
#[serde(transparent)]
pub struct BoundedVec<T, const MIN: usize, const MAX: usize>(Vec<T>);

impl<T, const MIN: usize, const MAX: usize> BoundedVec<T, MIN, MAX> {
    /// `items` when their count lies in `MIN..=MAX`, else `None`.
    pub fn new(items: Vec<T>) -> Option<Self> {
        (MIN..=MAX).contains(&items.len()).then_some(Self(items))
    }

    /// The items.
    pub fn as_slice(&self) -> &[T] {
        &self.0
    }

    /// The items, consuming the list.
    pub fn into_vec(self) -> Vec<T> {
        self.0
    }
}

impl<'de, T: Deserialize<'de>, const MIN: usize, const MAX: usize> Deserialize<'de>
    for BoundedVec<T, MIN, MAX>
{
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        let items = Vec::<T>::deserialize(deserializer)?;
        let count = items.len();
        Self::new(items)
            .ok_or_else(|| D::Error::custom(format!("{count} items is outside {MIN}..={MAX}")))
    }
}

impl<T: garde::Validate, const MIN: usize, const MAX: usize> garde::Validate
    for BoundedVec<T, MIN, MAX>
{
    type Context = T::Context;

    fn validate_into(
        &self,
        context: &Self::Context,
        parent: &mut dyn FnMut() -> garde::Path,
        report: &mut garde::Report,
    ) {
        self.0.validate_into(context, parent, report);
    }
}

impl<T: JsonSchema, const MIN: usize, const MAX: usize> JsonSchema for BoundedVec<T, MIN, MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("BoundedVec{MIN}To{MAX}Of{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = <Vec<T> as JsonSchema>::json_schema(generator);
        if MIN > 0 {
            schema.insert("minItems".into(), MIN.into());
        }
        if MAX != usize::MAX {
            schema.insert("maxItems".into(), MAX.into());
        }
        schema
    }
}

/// A garde check that no two items of a list share `key`, refusing the first repeat by its index:
/// for a list assembled from several members, where no one index names the repeat.
pub fn unique_by<List, T, K>(key: impl Fn(&T) -> K) -> impl Fn(&List, &()) -> garde::Result
where
    List: AsRef<[T]> + ?Sized,
    K: Eq + std::hash::Hash,
{
    move |items, _context| {
        let mut seen = std::collections::HashSet::new();
        match items
            .as_ref()
            .iter()
            .position(|item| !seen.insert(key(item)))
        {
            Some(index) => Err(garde::Error::new(format!(
                "item {index} repeats an earlier one"
            ))),
            None => Ok(()),
        }
    }
}

/// What no two items of a [`UniqueList`] share, and the item's own check.
pub trait ListKey {
    /// The compared value.
    type Key: Eq + std::hash::Hash;

    /// The item's key.
    fn list_key(&self) -> Self::Key;

    /// Checks the item itself, at `parent`; an item with no rule of its own checks nothing.
    fn validate_item(&self, _parent: &mut dyn FnMut() -> garde::Path, _report: &mut garde::Report) {
    }
}

/// A list of `MIN..=MAX` items no two of which share their [`ListKey`]; its check reports each
/// repeat at the repeat's index, as Zod's does. Its schema states `uniqueItems`, which refuses
/// equal items only, so the key check stays garde's.
#[derive(Clone, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(transparent)]
pub struct UniqueList<T, const MIN: usize, const MAX: usize>(BoundedVec<T, MIN, MAX>);

impl<T, const MIN: usize, const MAX: usize> UniqueList<T, MIN, MAX> {
    /// `items` when their count lies in `MIN..=MAX`, else `None`; the check refuses a repeat.
    pub fn new(items: Vec<T>) -> Option<Self> {
        BoundedVec::new(items).map(Self)
    }

    /// The items.
    pub fn as_slice(&self) -> &[T] {
        self.0.as_slice()
    }
}

impl<T: JsonSchema, const MIN: usize, const MAX: usize> JsonSchema for UniqueList<T, MIN, MAX> {
    fn inline_schema() -> bool {
        true
    }

    fn schema_name() -> Cow<'static, str> {
        format!("UniqueList{MIN}To{MAX}Of{}", T::schema_name()).into()
    }

    fn json_schema(generator: &mut SchemaGenerator) -> Schema {
        let mut schema = BoundedVec::<T, MIN, MAX>::json_schema(generator);
        schema.insert("uniqueItems".into(), true.into());
        schema
    }
}

impl<T: ListKey, const MIN: usize, const MAX: usize> garde::Validate for UniqueList<T, MIN, MAX> {
    type Context = ();

    fn validate_into(
        &self,
        (): &Self::Context,
        parent: &mut dyn FnMut() -> garde::Path,
        report: &mut garde::Report,
    ) {
        let mut first_index_of = std::collections::HashMap::new();
        for (index, item) in self.as_slice().iter().enumerate() {
            let mut item_path = || parent().join(index);
            item.validate_item(&mut item_path, report);
            match first_index_of.entry(item.list_key()) {
                Entry::Occupied(first) => report.append(
                    item_path(),
                    garde::Error::new(format!("item {index} repeats item {}", first.get())),
                ),
                Entry::Vacant(slot) => {
                    slot.insert(index);
                }
            }
        }
    }
}

impl<T, const MIN: usize, const MAX: usize> AsRef<[T]> for BoundedVec<T, MIN, MAX> {
    fn as_ref(&self) -> &[T] {
        &self.0
    }
}
