import winston from 'winston';
import type { Logger } from '@cloudops/kernel';
import { config } from '../env.js';
import { currentContext } from './request-context.js';

/** Keys whose values must never reach a log sink, at any depth. */
const SECRET_KEY = /^pass(wd)?$|password|secret|token|^authorization$|^cookie$|api[-_]?key|credential/i;

/** Replace secret-looking fields with a marker (defense in depth — callers shouldn't log them). */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value instanceof Error) return value;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = SECRET_KEY.test(k) ? '[redacted]' : redact(v, depth + 1);
  }
  return out;
}

/** Stamp the active request's correlation id / user onto every entry, and scrub secrets. */
const enrich = winston.format((info) => {
  const ctx = currentContext();
  if (ctx) {
    info.requestId ??= ctx.requestId;
    if (ctx.userId) info.userId ??= ctx.userId;
  }
  for (const key of Object.keys(info)) {
    if (key === 'level' || key === 'message') continue;
    info[key] = SECRET_KEY.test(key) ? '[redacted]' : redact(info[key]);
  }
  return info;
});

const winstonLogger = winston.createLogger({
  level: config.LOG_LEVEL ?? (config.NODE_ENV === 'production' ? 'info' : 'debug'),
  format: winston.format.combine(
    enrich(),
    winston.format.timestamp(),
    winston.format.errors({ stack: true }),
    config.NODE_ENV === 'production'
      ? winston.format.json()
      : winston.format.printf(({ level, message, timestamp, ...meta }) => {
          const rest = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
          return `${timestamp} ${level}: ${message}${rest}`;
        }),
  ),
  transports: [new winston.transports.Console()],
  // Never crash the process because a transport failed.
  exitOnError: false,
});

/** Adapts Winston to the kernel Logger contract. */
function adapt(w: winston.Logger): Logger {
  return {
    debug: (m, meta) => w.debug(m, meta),
    info: (m, meta) => w.info(m, meta),
    warn: (m, meta) => w.warn(m, meta),
    error: (m, meta) => w.error(m, meta),
    child: (bindings) => adapt(w.child(bindings)),
  };
}

export const logger: Logger = adapt(winstonLogger);
