/**
 * The smallest thing that can run a statement.
 *
 * Entity access needs to send SQL and read rows back. It does not need to open
 * connections, count them, or shut a pool down. Asking only for `query` means
 * the same functions work against a pool and against a single client checked
 * out for a transaction, without either knowing about the other.
 *
 * That is what makes a transaction possible later without rewriting anything:
 * a service will check out a client, run `begin`, hand that client in as the
 * executor, and commit. Nothing below has to change, because nothing below
 * ever assumed it was talking to a pool.
 *
 * `DatabasePool` stays what it is — pool lifecycle — and satisfies this
 * interface, so a pool can still be passed directly where no transaction is
 * involved.
 */

import type { QueryResult, QueryResultRow } from 'pg';

export interface DatabaseExecutor {
  query<R extends QueryResultRow = QueryResultRow>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<R>>;
}
