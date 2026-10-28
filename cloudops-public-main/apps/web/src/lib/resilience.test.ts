import { describe, expect, it } from 'vitest';
import { AxiosError, AxiosHeaders } from 'axios';
import { isAuthRejection, shouldRetry } from './api';
import { runFinished } from './queries';
import { returnPath } from './returnPath';
import { renderMarkdown } from '../features/workspaces/markdown';

const httpError = (status?: number) =>
  new AxiosError(
    'x',
    status ? 'ERR_BAD_RESPONSE' : 'ERR_NETWORK',
    undefined,
    undefined,
    status ? { status, statusText: '', data: {}, headers: {}, config: { headers: new AxiosHeaders() } } : undefined,
  );

describe('returnPath — post-login redirect is never an open redirect', () => {
  it('returns in-app paths with their query', () => {
    expect(returnPath({ from: '/inventory?types=vm' })).toBe('/inventory?types=vm');
    expect(returnPath({ from: '/resources/abc' })).toBe('/resources/abc');
  });
  it('falls back to the dashboard for anything else', () => {
    for (const from of ['https://evil.example', '//evil.example', '/\\evil.example', 'javascript:alert(1)', '/login', '/login?x=1', 42, null]) {
      expect(returnPath({ from })).toBe('/');
    }
    expect(returnPath(null)).toBe('/');
    expect(returnPath(undefined)).toBe('/');
  });
});

describe('shouldRetry — only transient failures are retried', () => {
  it('does not retry client errors', () => {
    for (const s of [400, 401, 403, 404, 409, 422]) expect(shouldRetry(0, httpError(s))).toBe(false);
  });
  it('retries network errors, 5xx, 408 and 429 — at most twice', () => {
    for (const e of [httpError(), httpError(500), httpError(503), httpError(408), httpError(429)]) {
      expect(shouldRetry(0, e)).toBe(true);
      expect(shouldRetry(1, e)).toBe(true);
      expect(shouldRetry(2, e)).toBe(false);
    }
  });
  it('recognises credential rejections (and nothing else) as auth failures', () => {
    expect(isAuthRejection(httpError(401))).toBe(true);
    expect(isAuthRejection(httpError(403))).toBe(true);
    expect(isAuthRejection(httpError(503))).toBe(false);
    expect(isAuthRejection(httpError())).toBe(false);
  });
});

describe('runFinished — refresh dependent data when a run completes', () => {
  it('detects a live run that finished', () => {
    expect(runFinished([{ id: 'a', status: 'running' }], [{ id: 'a', status: 'completed' }])).toBe(true);
    expect(runFinished([{ id: 'a', status: 'queued' }], [{ id: 'a', status: 'failed' }])).toBe(true);
  });
  it('ignores first loads, still-running runs and old history', () => {
    expect(runFinished(undefined, [{ id: 'a', status: 'completed' }])).toBe(false);
    expect(runFinished([{ id: 'a', status: 'running' }], [{ id: 'a', status: 'running' }])).toBe(false);
    expect(runFinished([{ id: 'a', status: 'completed' }], [{ id: 'a', status: 'completed' }])).toBe(false);
  });
});

describe('renderMarkdown — protocol-relative links', () => {
  it('keeps in-app paths but neutralises //host and /\\host', () => {
    expect(renderMarkdown('[a](/inventory)')).toContain('href="/inventory"');
    expect(renderMarkdown('[a](//evil.example/x)')).toContain('href="#"');
    expect(renderMarkdown('[a](/\\evil.example)')).toContain('href="#"');
  });
});
