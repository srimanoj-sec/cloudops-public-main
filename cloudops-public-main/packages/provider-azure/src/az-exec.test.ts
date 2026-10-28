import { describe, expect, it } from 'vitest';
import { az, escapeCmdArg, resolveAzInvocation, summarizeAzError } from './az-exec.js';

describe('az executor allow-list', () => {
  it('rejects a command group outside the allow-list', async () => {
    await expect(az(['vm', 'delete'])).rejects.toThrow(/not allowed/);
  });
});

/**
 * A failed `az login` is what the Providers page shows when a service principal
 * is wrong, so the message has to name the actual problem. az buries it: a
 * generic header first, the reason second, then pages of Python traceback.
 * These are real (abridged) CLI outputs.
 */
describe('summarizeAzError', () => {
  it('pulls the AADSTS reason out of a traceback dump', () => {
    const raw = [
      'ERROR: The command failed with an unexpected error. Here is the traceback:',
      'ERROR: Unable to get authority configuration for https://login.microsoftonline.com/1111.',
      'Traceback (most recent call last):',
      '  File "msal/authority.py", line 98, in __init__',
      'ValueError: OIDC Discovery failed. HTTP status: 400, Error: {"error":"invalid_tenant",',
      '"error_description":"AADSTS90002: Tenant \'1111\' not found. Check to make sure you have the',
      "correct tenant ID. Trace ID: e8ca4c97 Correlation ID: a276560d Timestamp: 2026-09-09\",",
    ].join('\n');

    const summary = summarizeAzError(raw);
    expect(summary).toMatch(/^AADSTS90002: Tenant '1111' not found/);
    expect(summary).not.toMatch(/Trace ID|Traceback|unexpected error/);
  });

  it('keeps the AADSTS code for a bad client secret', () => {
    const raw =
      'ERROR: AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value. Trace ID: abc';
    expect(summarizeAzError(raw)).toBe(
      'AADSTS7000215: Invalid client secret provided. Ensure the secret being sent in the request is the client secret value.',
    );
  });

  it('falls back to the first meaningful ERROR line when there is no AADSTS code', () => {
    const raw = [
      'ERROR: The command failed with an unexpected error. Here is the traceback:',
      'ERROR: The subscription of  does not exist in cloud AzureCloud.',
      'Traceback (most recent call last):',
    ].join('\n');
    expect(summarizeAzError(raw)).toBe('The subscription of  does not exist in cloud AzureCloud.');
  });

  it('caps the summary so a wall of output never reaches the UI', () => {
    expect(summarizeAzError('x'.repeat(5000))).toHaveLength(400);
  });
});

describe('resolveAzInvocation (never a shell)', () => {
  it('runs az directly on Linux/macOS', () => {
    expect(resolveAzInvocation({ platform: 'linux', pathEnv: '/usr/bin', exists: () => true })).toEqual({
      command: 'az',
      prefixArgs: [],
    });
  });

  it('runs the MSI-bundled python directly on Windows instead of the az.cmd shim', () => {
    const cli2 = 'C:\\Program Files\\Microsoft SDKs\\Azure\\CLI2';
    const files = new Set([`${cli2}\\wbin\\az.cmd`, `${cli2}\\python.exe`]);
    const inv = resolveAzInvocation({
      platform: 'win32',
      pathEnv: `C:\\Windows;${cli2}\\wbin`,
      exists: (p) => files.has(p),
    });
    expect(inv.command).toBe(`${cli2}\\python.exe`);
    expect(inv.prefixArgs).toEqual(['-IBm', 'azure.cli']);
    expect(inv.viaCmd).toBeFalsy();
  });

  it('falls back to an escaped cmd.exe line only for non-MSI layouts', () => {
    const inv = resolveAzInvocation({
      platform: 'win32',
      pathEnv: 'C:\\tools',
      exists: (p) => p === 'C:\\tools\\az.cmd',
    });
    expect(inv).toMatchObject({ command: 'C:\\tools\\az.cmd', viaCmd: true });
  });
});

describe('escapeCmdArg', () => {
  it('caret-escapes every cmd metacharacter so an argument cannot chain commands', () => {
    const escaped = escapeCmdArg('env=prod & calc | more > out %PATH% ^');
    // Strip escaped pairs: no bare metacharacter may survive.
    expect(escaped.replace(/\^./g, '')).not.toMatch(/[&|<>%]/);
  });

  it('wraps the argument in escaped quotes', () => {
    const escaped = escapeCmdArg('plain');
    expect(escaped.startsWith('^^^"')).toBe(true);
    expect(escaped.endsWith('^^^"')).toBe(true);
  });
});
