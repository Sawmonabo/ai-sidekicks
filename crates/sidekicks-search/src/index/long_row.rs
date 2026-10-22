//! A row longer than a page: cut into one document per page and one edge document per page
//! boundary as its pages arrive, held per version as one row, and matched, counted and scored as
//! one document from its pages' counts and its edges' matches across their boundaries.

pub(crate) mod documents;
pub(crate) mod matches;
pub(crate) mod rows;
