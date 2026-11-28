import {
  logResponseGuard,
  action,
  interaction,
  token,
  LogKeyUnknown,
  jwtCustomizer,
  saml,
  trustedDevice,
  type AuditLogPrefix,
} from '@logto/schemas';
import { yes } from '@silverhand/essentials';
import { boolean, literal, number, object, string } from 'zod';
import type { z } from 'zod';

import RequestError from '#src/errors/RequestError/index.js';
import koaGuard from '#src/middleware/koa-guard.js';
import koaPagination from '#src/middleware/koa-pagination.js';
import assertThat from '#src/utils/assert-that.js';
import { buildLogCursorPage, decodeLogCursor } from '#src/utils/log-cursor.js';
import { parseTimestampParam, validateTimeWindow } from '#src/utils/time-window.js';

import type { ManagementApiRouter, RouterInitArgs } from './types.js';

// `limit` bounds how many rows one call deletes. Each call is a single
// `delete ... where ctid = any(array(select ... limit N))` statement, so the bound is what keeps a
// call short: it stays clear of the pool's `statement_timeout`, holds few row locks at a time, and
// avoids producing a burst of dead tuples and WAL that would compete with normal request traffic.
// 1000 is a safe default for both interactive and scripted callers; 10000 is the ceiling for
// callers that would trade a longer call for fewer round trips.
const defaultDeleteLimit = 1000;
const maxDeleteLimit = 10_000;

// Cursor mode on `GET /logs` uses a smaller page than delete batches because it is exposed to
// shared Logto Cloud instances.
const defaultLogCursorLimit = 500;
const maxLogCursorLimit = 1000;

/**
 * The audit log keys exposed by `GET /logs`.
 *
 * Webhook delivery logs (`TriggerHook.*`) share the `logs` table but are a separate surface, read
 * through `GET /hooks/:id/recent-logs`, so they are excluded from this list. Note that
 * `DELETE /logs` deliberately does *not* apply this list: it purges every log row in the window,
 * webhook delivery logs included, which is what lets it use the time index and reclaim their
 * space.
 */
const auditLogKeyPrefixes: AuditLogPrefix[] = [
  token.Type.ExchangeTokenBy,
  token.Type.RevokeToken,
  token.Type.RevokeGrants,
  interaction.prefix,
  jwtCustomizer.prefix,
  saml.prefix,
  action.prefix,
  trustedDevice.prefix,
  LogKeyUnknown,
];

const invalidInput = (type: string) => new RequestError({ code: 'guard.invalid_input', type });

/**
 * Parse an optional unix-millisecond boundary, rejecting inputs that `Number()` would silently
 * coerce into a valid-looking value.
 *
 * - `Number('')` and `Number('   ')` are both `0`, which would turn a bounded window into an
 *   unbounded one (an empty `start_time` drops the lower bound entirely).
 * - Values outside PostgreSQL's `timestamptz` range make `to_timestamp()` raise, which would
 *   surface as a `500` instead of a `400`.
 */
const parseBound = (raw: string | undefined, type: string): number | undefined => {
  if (raw === undefined) {
    return undefined;
  }

  if (raw.trim() === '') {
    throw invalidInput(type);
  }

  const value = parseTimestampParam(raw, type);

  assertThat(value !== undefined && Number.isSafeInteger(value) && value >= 0, invalidInput(type));

  return value;
};

const parseRequiredNonFutureTimeWindow = (
  start_time: string | undefined,
  end_time: string | undefined
): { startTime?: number; endTime: number } => {
  const endTime = parseBound(end_time, 'end_time');

  if (endTime === undefined) {
    throw invalidInput('end_time');
  }

  const startTime = parseBound(start_time, 'start_time');
  validateTimeWindow(startTime, endTime);
  assertThat(
    endTime <= Date.now(),
    new RequestError({ code: 'log.cleanup_boundary_in_future', status: 400 })
  );

  return { startTime, endTime };
};

const logQueryGuard = object({
  userId: string().optional(),
  applicationId: string().optional(),
  logKey: string().optional(),
  enableCap: string().optional(),
  pagination: literal('cursor').optional(),
  cursor: string().max(512).optional(),
  limit: string().optional(),
  start_time: string().optional(),
  end_time: string().optional(),
});

type LogQuery = z.infer<typeof logQueryGuard>;

type PaginationMode = 'page' | 'cursor';

type PaginationParameter =
  | 'page'
  | 'page_size'
  | 'enableCap'
  | 'userId'
  | 'applicationId'
  | 'logKey'
  | 'cursor'
  | 'limit';

const rejectUnsupportedPaginationParams = (
  query: Record<string, unknown>,
  mode: PaginationMode,
  parameters: readonly PaginationParameter[]
) => {
  for (const parameter of parameters) {
    if (parameter in query) {
      throw new RequestError({
        code: 'guard.unsupported_pagination_parameter',
        parameter,
        mode,
      });
    }
  }
};

export default function logRoutes<T extends ManagementApiRouter>(
  ...[router, { queries }]: RouterInitArgs<T>
) {
  const { findLogById, countLogs, findLogs, findLogsForCursor, deleteLogsInRange } = queries.logs;

  const listLogsByPage = async (
    query: LogQuery,
    pagination: { limit: number; offset: number },
    { startTime, endTime }: { startTime?: number; endTime?: number }
  ) => {
    const { userId, applicationId, logKey, enableCap } = query;
    const includeKeyPrefix = auditLogKeyPrefixes;

    // TODO: @Gao refactor like user search
    const [{ count, isCapped }, logs] = await Promise.all([
      countLogs(
        {
          logKey,
          payload: { applicationId, userId },
          startTime,
          endTime,
          includeKeyPrefix,
        },
        { capped: yes(enableCap) }
      ),
      findLogs(pagination.limit, pagination.offset, {
        logKey,
        payload: { userId, applicationId },
        startTime,
        endTime,
        includeKeyPrefix,
      }),
    ]);

    return { count, isCapped, logs };
  };

  const listLogsByCursor = async (
    query: LogQuery,
    { startTime, endTime }: { startTime?: number; endTime?: number }
  ) => {
    const limit = query.limit === undefined ? defaultLogCursorLimit : Number(query.limit);
    assertThat(
      Number.isInteger(limit) && limit >= 1 && limit <= maxLogCursorLimit,
      invalidInput('limit')
    );

    const cursor = decodeLogCursor(query.cursor);

    // Read one extra row to determine whether another page exists.
    // Cursor mode is audit-only and deliberately does not run the page-mode count query.
    const rows = await findLogsForCursor(limit + 1, {
      startTime,
      endTime,
      includeKeyPrefix: auditLogKeyPrefixes,
      after: cursor,
    });

    const { logs, nextCursor } = buildLogCursorPage(rows, limit);

    return { logs, nextCursor };
  };

  router.get(
    '/logs',
    koaPagination({
      skip: (context) => context.request.query.pagination === 'cursor',
    }),
    koaGuard({
      query: logQueryGuard,
      response: logResponseGuard.array(),
      status: [200, 400],
    }),
    async (ctx, next) => {
      const { query } = ctx.guard;
      const cursorMode = query.pagination === 'cursor';

      if (cursorMode) {
        rejectUnsupportedPaginationParams(ctx.request.query, 'cursor', [
          'page',
          'page_size',
          'enableCap',
          'userId',
          'applicationId',
          'logKey',
        ]);

        const timeWindow = parseRequiredNonFutureTimeWindow(query.start_time, query.end_time);
        const { logs, nextCursor } = await listLogsByCursor(query, timeWindow);

        ctx.body = logs;

        if (nextCursor) {
          ctx.set('Next-Cursor', nextCursor);
        }

        return next();
      }

      rejectUnsupportedPaginationParams(ctx.request.query, 'page', ['cursor', 'limit']);

      const startTime = parseTimestampParam(query.start_time, 'start_time');
      const endTime = parseTimestampParam(query.end_time, 'end_time');
      validateTimeWindow(startTime, endTime);

      const { count, isCapped, logs } = await listLogsByPage(query, ctx.pagination, {
        startTime,
        endTime,
      });

      // Return totalCount to pagination middleware
      ctx.pagination.totalCount = count;
      ctx.pagination.totalCountIsCapped = isCapped;
      ctx.body = logs;

      return next();
    }
  );

  router.get(
    '/logs/:id',
    koaGuard({
      params: object({ id: string().min(1) }),
      response: logResponseGuard,
      status: [200, 404],
    }),
    async (ctx, next) => {
      const {
        params: { id },
      } = ctx.guard;

      ctx.body = await findLogById(id);

      return next();
    }
  );

  router.delete(
    '/logs',
    koaGuard({
      query: object({
        end_time: string(),
        start_time: string().optional(),
        limit: string().optional(),
      }),
      response: object({
        deletedCount: number(),
        hasMore: boolean(),
        deletedRange: object({ oldest: number(), newest: number() }).optional(),
      }),
      status: [200, 400],
    }),
    async (ctx, next) => {
      const { query } = ctx.guard;

      const { startTime, endTime } = parseRequiredNonFutureTimeWindow(
        query.start_time,
        query.end_time
      );

      const limit = query.limit === undefined ? defaultDeleteLimit : Number(query.limit);
      assertThat(
        Number.isInteger(limit) && limit >= 1 && limit <= maxDeleteLimit,
        invalidInput('limit')
      );

      const { deletedCount, deletedRange } = await deleteLogsInRange({
        endTime,
        startTime,
        limit,
      });

      ctx.body = {
        deletedCount,
        hasMore: deletedCount === limit,
        ...(deletedRange && { deletedRange }),
      };

      return next();
    }
  );
}
