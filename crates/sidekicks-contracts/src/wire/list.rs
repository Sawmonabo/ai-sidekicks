//! Lists on the wire, each with the bounds its schema states.

use std::borrow::Cow;

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

/// A garde check that no two items of a list share `key`, refusing the first repeat by its index.
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

impl<T, const MIN: usize, const MAX: usize> AsRef<[T]> for BoundedVec<T, MIN, MAX> {
    fn as_ref(&self) -> &[T] {
        &self.0
    }
}
