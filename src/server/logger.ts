import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';

type LogLevel = 'error' | 'warn' | 'info' | 'debug';

type LogMeta = Record<string, unknown>;

const LEVELS: Record<LogLevel, number> = {
  error: 0,
  warn: 1,
  info: 2,
  debug: 3,
};

const levelFromEnv = (() => {
  const raw = (process.env.LOG_LEVEL || 'info').toLowerCase();
  return (LEVELS as Record<string, number>)[raw] ?? LEVELS.info;
})();

function asErrorPayload(error: unknown) {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  if (typeof error === 'object' && error !== null) {
    return error;
  }
  return { message: String(error) };
}

function normalizeMeta(meta?: LogMeta) {
  if (!meta) return undefined;
  const out: LogMeta = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined) continue;
    out[key] = value instanceof Error ? asErrorPayload(value) : value;
  }
  return Object.keys(out).length ? out : undefined;
}

function baseLog(level: LogLevel, message: string, meta?: LogMeta) {
  if (LEVELS[level] > levelFromEnv) return;
  const timestamp = new Date().toISOString();
  const normalized = normalizeMeta(meta);
  const line = normalized
    ? `${timestamp} [${level.toUpperCase()}] ${message} ${JSON.stringify(normalized)}`
    : `${timestamp} [${level.toUpperCase()}] ${message}`;

  if (level === 'error') {
    console.error(line);
  } else if (level === 'warn') {
    console.warn(line);
  } else {
    console.log(line);
  }
}

export const logger = {
  debug(message: string, meta?: LogMeta) {
    baseLog('debug', message, meta);
  },
  info(message: string, meta?: LogMeta) {
    baseLog('info', message, meta);
  },
  warn(message: string, meta?: LogMeta) {
    baseLog('warn', message, meta);
  },
  error(message: string, meta?: LogMeta) {
    baseLog('error', message, meta);
  },
};

export function serializeError(error: unknown) {
  return asErrorPayload(error);
}

export function getRequestId(res: Response): string | undefined {
  return res.locals.requestId as string | undefined;
}

export function requestLogger(req: Request, res: Response, next: NextFunction) {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? randomUUID();
  const start = process.hrtime.bigint();

  res.locals.requestId = requestId;
  res.setHeader('X-Request-Id', requestId);
  logger.info('Incoming request', {
    requestId,
    method: req.method,
    path: req.originalUrl,
    ip: req.ip,
  });

  res.on('finish', () => {
    const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
    logger.info('Request completed', {
      requestId,
      status: res.statusCode,
      durationMs: Math.round(durationMs * 100) / 100,
      contentLength: res.get('Content-Length'),
    });
  });

  res.on('close', () => {
    if (!res.writableEnded) {
      const durationMs = Number(process.hrtime.bigint() - start) / 1_000_000;
      logger.warn('Request aborted by client', {
        requestId,
        method: req.method,
        path: req.originalUrl,
        durationMs: Math.round(durationMs * 100) / 100,
      });
    }
  });

  next();
}
