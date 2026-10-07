/*
** match_count(table, column): how many matches highlight() would mark in one column of the current
** row. SQLite hands a row's matches only to an auxiliary function, written in C, so the package
** build compiles this file into a library the search connection loads.
*/
#include <sqlite3ext.h>
SQLITE_EXTENSION_INIT1

#include <string.h>

/*
** The iterator below, the struct and fts5CInstIterNext(), is copied from SQLite's
** ext/fts5/fts5_aux.c, where highlight() walks it, so both merge the same matches.
**
** The author disclaims copyright to this source code.  In place of
** a legal notice, here is a blessing:
**
**    May you do good and not evil.
**    May you find forgiveness for yourself and forgive others.
**    May you share freely, never taking more than you give.
*/

/*
** Object used to iterate through all "coalesced phrase instances" in
** a single column of the current row. If the phrase instances in the
** column being considered do not overlap, this object simply iterates
** through them. Or, if they do overlap (share one or more tokens in
** common), each set of overlapping instances is treated as a single
** match. See documentation for the highlight() auxiliary function for
** details.
*/
typedef struct CInstIter CInstIter;
struct CInstIter {
  const Fts5ExtensionApi *pApi;   /* API offered by current FTS version */
  Fts5Context *pFts;              /* First arg to pass to pApi functions */
  int iCol;                       /* Column to search */
  int iInst;                      /* Next phrase instance index */
  int nInst;                      /* Total number of phrase instances */

  /* Output variables */
  int iStart;                     /* First token in coalesced phrase instance */
  int iEnd;                       /* Last token in coalesced phrase instance */
};

/*
** Advance the iterator to the next coalesced phrase instance. Return
** an SQLite error code if an error occurs, or SQLITE_OK otherwise.
*/
static int fts5CInstIterNext(CInstIter *pIter){
  int rc = SQLITE_OK;
  pIter->iStart = -1;
  pIter->iEnd = -1;

  while( rc==SQLITE_OK && pIter->iInst<pIter->nInst ){
    int ip; int ic; int io;
    rc = pIter->pApi->xInst(pIter->pFts, pIter->iInst, &ip, &ic, &io);
    if( rc==SQLITE_OK ){
      if( ic==pIter->iCol ){
        int iEnd = io - 1 + pIter->pApi->xPhraseSize(pIter->pFts, ip);
        if( pIter->iStart<0 ){
          pIter->iStart = io;
          pIter->iEnd = iEnd;
        }else if( io<=pIter->iEnd ){
          if( iEnd>pIter->iEnd ) pIter->iEnd = iEnd;
        }else{
          break;
        }
      }
      pIter->iInst++;
    }
  }

  return rc;
}

/* match_count(table, column): one per stretch of merged matches in the column. */
static void matchCount(
  const Fts5ExtensionApi *pApi,
  Fts5Context *pFts,
  sqlite3_context *pCtx,
  int nVal,
  sqlite3_value **apVal
){
  CInstIter iter;
  sqlite3_int64 nMatch = 0;
  int rc;
  if( nVal!=1 ){
    sqlite3_result_error(pCtx, "match_count() takes one argument, the column", -1);
    return;
  }
  memset(&iter, 0, sizeof(iter));
  iter.pApi = pApi;
  iter.pFts = pFts;
  iter.iCol = sqlite3_value_int(apVal[0]);
  rc = pApi->xInstCount(pFts, &iter.nInst);
  if( rc==SQLITE_OK ) rc = fts5CInstIterNext(&iter);
  while( rc==SQLITE_OK && iter.iStart>=0 ){
    nMatch++;
    rc = fts5CInstIterNext(&iter);
  }
  if( rc==SQLITE_OK ){
    sqlite3_result_int64(pCtx, nMatch);
  }else{
    sqlite3_result_error_code(pCtx, rc);
  }
}

/*
** The entry point SQLite calls by its default name. FTS5 hands out its API only through a pointer
** bound to `SELECT fts5(?1)`.
*/
#ifdef _WIN32
__declspec(dllexport)
#endif
int sqlite3_extension_init(
  sqlite3 *db,
  char **pzErrMsg,
  const sqlite3_api_routines *pApi
){
  fts5_api *pFts5 = 0;
  sqlite3_stmt *pStmt = 0;
  int rc;
  SQLITE_EXTENSION_INIT2(pApi);
  rc = sqlite3_prepare_v2(db, "SELECT fts5(?1)", -1, &pStmt, 0);
  if( rc!=SQLITE_OK ) return rc;
  sqlite3_bind_pointer(pStmt, 1, (void*)&pFts5, "fts5_api_ptr", 0);
  sqlite3_step(pStmt);
  rc = sqlite3_finalize(pStmt);
  if( rc!=SQLITE_OK ) return rc;
  if( pFts5==0 || pFts5->iVersion<2 ){
    *pzErrMsg = sqlite3_mprintf("match_count needs FTS5, which this SQLite lacks");
    return SQLITE_ERROR;
  }
  return pFts5->xCreateFunction(pFts5, "match_count", 0, matchCount, 0);
}
