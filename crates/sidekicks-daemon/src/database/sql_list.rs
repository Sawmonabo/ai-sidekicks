//! A closed set of words written into a statement as a SQL list.

/// `values` as a SQL list of quoted strings, for an `IN` or a `CHECK`. Each value is a member of a
/// closed set the code declares, never input, and holds no quote.
pub(crate) fn sql_list_of<'a>(values: impl IntoIterator<Item = &'a str>) -> String {
    values
        .into_iter()
        .map(|value| format!("'{value}'"))
        .collect::<Vec<_>>()
        .join(", ")
}
