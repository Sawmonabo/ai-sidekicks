//! A row longer than a page: cut into one document per page, one edge document per page boundary
//! and a terminal document as its pages arrive, held per version as one row once its terminal
//! document is live, and matched, counted and scored as one document from its pages' counts and
//! its edges' matches across their boundaries.

pub(crate) mod documents;
pub(crate) mod matches;
pub(crate) mod rows;
