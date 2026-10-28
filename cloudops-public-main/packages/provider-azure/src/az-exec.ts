import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { win32 } from 'node:path';

/**
 * Hardened Azure CLI executor — the ONLY place this codebase shells out to `az`.
 *
 * Security posture:
 *  - Uses execFile with an args ARRAY and `shell: false` on every platform → no
 *    shell interpolation / injection surface. On Windows `az` is a `.cmd` shim;
 *    we run the Python it wraps directly instead (see {@link resolveAzInvocation}),
 *    because `shell: true` would concatenate args unescaped into a cmd.exe line —
 *    a tag value like `x & calc` would execute on the host.
 *  - Allow-lists the top-level `az` command group; anything else is rejected.
 *  - Enforces a timeout and output-size cap.
 *  - Always requests `-o json` and parses structured output.
 *  - Maps failures to a typed AzError with the stderr captured.
 *
 * The same pattern is reused by the Execution Framework and CLI Playground in
 * later phases (read-only allow-list vs. mutating allow-list differ, executor
 * does not).
 */

/** Command groups permitted for read-only inventory sync (skeleton scope). */
export const READ_ONLY_AZ_GROUPS = new Set([
  'account',
  'group',
  'resource',
  'graph',
  'rest', // used for read-only ARM queries (e.g. Cost Management)
  'version',
]);

/**
 * Command groups permitted for MUTATING operations. Kept separate from the
 * read-only set and passed explicitly by write paths (tag write-back today; the
 * Execution Framework later) so sync can never reach a mutating command.
 */
export const WRITE_AZ_GROUPS = new Set(['tag', 'vm']);

/**
 * Sub-commands that change something. Refused unless the caller opts into
 * writes (`allowWrites`), so a read path can never mutate the estate even
 * through an allowed group (`resource list` is a read, `resource delete` is not).
 */
export const MUTATING_VERBS = new Set([
  'create',
  'update',
  'delete',
  'set',
  'add',
  'remove',
  'start',
  'stop',
  'deallocate',
  'restart',
  'redeploy',
  'invoke',
  'purge',
]);

export interface AzExecOptions {
  timeoutMs?: number;
  maxBufferBytes?: number;
  /** Azure CLI config dir (reuses the mounted host `az login` session). */
  configDir?: string;
  signal?: AbortSignal;
  /** Allow-list to validate the first arg against. Defaults to read-only groups. */
  allowGroups?: Set<string>;
  /** Permit mutating sub-commands (write paths only). */
  allowWrites?: boolean;
}

export class AzError extends Error {
  constructor(
    message: string,
    readonly code: 'NOT_LOGGED_IN' | 'NOT_INSTALLED' | 'FORBIDDEN' | 'THROTTLED' | 'TIMEOUT' | 'CLI_ERROR' | 'PARSE_ERROR',
    readonly stderr?: string,
  ) {
    super(message);
    this.name = 'AzError';
  }
}

/**
 * Pull the operator-actionable sentence out of an `az` failure.
 *
 * A failed `az login` prints a generic header, then the real reason, then a
 * multi-page Python traceback. Surfacing the first line (or all of it) would
 * tell the operator nothing, so prefer the AADSTS code — that is the part that
 * says "wrong secret" vs. "wrong tenant" vs. "no subscriptions".
 */
export function summarizeAzError(msg: string): string {
  const aadsts = /AADSTS\d+:[^"\n]+/.exec(msg)?.[0];
  if (aadsts) return aadsts.split(/\s*Trace ID:/)[0]!.trim().slice(0, 400);

  const errorLine = msg
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.startsWith('ERROR:'))
    .map((l) => l.slice('ERROR:'.length).trim())
    .find((l) => l && !/^The command failed with an unexpected error/i.test(l));
  return (errorLine ?? msg.trim().split('\n')[0] ?? msg).slice(0, 400);
}

const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_MAX_BUFFER = 64 * 1024 * 1024; // 64MB — resource lists can be large

/** How to launch the Azure CLI without a shell. */
export interface AzInvocation {
  command: string;
  /** Args placed before the `az` argument vector. */
  prefixArgs: string[];
  /** Extra environment for the child (e.g. AZ_INSTALLER for the MSI layout). */
  env?: Record<string, string>;
  /**
   * Last-resort Windows mode: run through cmd.exe with every argument escaped
   * for cmd's parser (see {@link escapeCmdArg}). Only used when the MSI layout
   * can't be found.
   */
  viaCmd?: boolean;
}

/** Filesystem/env seams so the resolution logic is unit-testable on any OS. */
export interface AzResolveDeps {
  platform: NodeJS.Platform;
  pathEnv: string;
  exists: (path: string) => boolean;
}

/**
 * Work out how to run `az` WITHOUT a shell.
 *
 *  - Linux/macOS: `az` is a real executable.
 *  - Windows (MSI install): `az.cmd` is just `"%~dp0\..\python.exe" -IBm azure.cli %*`,
 *    so we run that python directly — identical behavior, no cmd.exe parsing.
 *  - Windows (other layouts): fall back to cmd.exe with fully escaped arguments.
 */
export function resolveAzInvocation(deps: AzResolveDeps): AzInvocation {
  if (deps.platform !== 'win32') return { command: 'az', prefixArgs: [] };

  for (const dir of deps.pathEnv.split(win32.delimiter).filter(Boolean)) {
    const shim = win32.join(dir, 'az.cmd');
    if (!deps.exists(shim)) continue;
    const python = win32.join(win32.dirname(dir), 'python.exe');
    if (deps.exists(python)) {
      return { command: python, prefixArgs: ['-IBm', 'azure.cli'], env: { AZ_INSTALLER: 'MSI' } };
    }
    return { command: shim, prefixArgs: [], viaCmd: true };
  }
  // Not found on PATH: let execFile surface ENOENT → NOT_INSTALLED.
  return { command: 'az.cmd', prefixArgs: [], viaCmd: true };
}

const CMD_META = /([()\][%!^"`<>&|;, *?])/g;

/**
 * Escape one argument for a cmd.exe command line that invokes a `.cmd` shim
 * (the batch file re-parses `%*`, so metacharacters are caret-escaped twice).
 * Algorithm from https://qntm.org/cmd, as used by cross-spawn.
 */
export function escapeCmdArg(arg: string): string {
  let escaped = arg.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\*)$/, '$1$1');
  escaped = `"${escaped}"`;
  escaped = escaped.replace(CMD_META, '^$1');
  return escaped.replace(CMD_META, '^$1');
}

/** Escape the program path itself (single caret pass, unquoted — as cross-spawn does). */
export function escapeCmdCommand(command: string): string {
  return command.replace(CMD_META, '^$1');
}

let cachedInvocation: AzInvocation | undefined;
function azInvocation(): AzInvocation {
  cachedInvocation ??= resolveAzInvocation({
    platform: process.platform,
    pathEnv: process.env.PATH ?? process.env.Path ?? '',
    exists: existsSync,
  });
  return cachedInvocation;
}

/**
 * Run `az <args...>` and return parsed JSON of type T.
 * @param args argument vector WITHOUT the leading `az`, e.g. ['resource', 'list']
 */
export async function az<T>(args: string[], options: AzExecOptions = {}): Promise<T> {
  const group = args[0];
  const allow = options.allowGroups ?? READ_ONLY_AZ_GROUPS;
  if (!group || !allow.has(group)) {
    throw new AzError(`az command group not allowed: "${group ?? '<empty>'}"`, 'FORBIDDEN');
  }
  const verb = args.slice(1, 3).find((a) => MUTATING_VERBS.has(a));
  if (verb && !options.allowWrites) {
    throw new AzError(`az ${group} ${verb} is a write and this call is read-only`, 'FORBIDDEN');
  }

  // Ensure JSON output unless caller already specified an output format.
  const hasOutputFlag = args.includes('-o') || args.includes('--output');
  const finalArgs = hasOutputFlag ? args : [...args, '-o', 'json'];

  const invocation = azInvocation();
  const env: NodeJS.ProcessEnv = { ...process.env, ...invocation.env };
  if (options.configDir) env.AZURE_CONFIG_DIR = options.configDir;

  // Never `shell: true`. The cmd.exe fallback builds its own fully-escaped line.
  const command = invocation.viaCmd ? (process.env.ComSpec ?? 'cmd.exe') : invocation.command;
  const argv = invocation.viaCmd
    ? ['/d', '/s', '/c', `"${[escapeCmdCommand(invocation.command), ...finalArgs.map(escapeCmdArg)].join(' ')}"`]
    : [...invocation.prefixArgs, ...finalArgs];

  return new Promise<T>((resolve, reject) => {
    execFile(
      command,
      argv,
      {
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER,
        env,
        signal: options.signal,
        windowsHide: true,
        shell: false,
        windowsVerbatimArguments: Boolean(invocation.viaCmd),
      },
      (error, stdout, stderr) => {
        if (error) {
          const msg = stderr || error.message;
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return reject(new AzError('Azure CLI (`az`) is not installed or not on PATH.', 'NOT_INSTALLED', stderr));
          }
          if ((error as { killed?: boolean }).killed) {
            return reject(new AzError('Azure CLI command timed out.', 'TIMEOUT', stderr));
          }
          // Azure throttling (429). Callers back off and retry rather than
          // treating this as "no data" — it is a transient rate limit.
          if (/Too Many Requests|"code"\s*:\s*"429"|\(429\)|status code:? ?429/i.test(msg)) {
            return reject(new AzError(`Azure throttled the request (429): ${msg.trim()}`, 'THROTTLED', stderr));
          }
          if (/az login|not logged in|no subscription found|AADSTS/i.test(msg)) {
            // A FAILING `az login` is a credential problem, not a missing
            // session — telling the operator to "run az login" would hide the
            // AADSTS reason they actually need (bad secret, wrong tenant, ...).
            if (group === 'login') {
              return reject(
                new AzError(`Azure rejected these credentials: ${summarizeAzError(msg)}`, 'CLI_ERROR', stderr),
              );
            }
            return reject(new AzError('No active Azure CLI session. Run `az login`.', 'NOT_LOGGED_IN', stderr));
          }
          return reject(new AzError(`az failed: ${msg.trim()}`, 'CLI_ERROR', stderr));
        }
        const text = stdout.trim();
        if (text === '') return resolve(undefined as unknown as T);
        try {
          resolve(JSON.parse(text) as T);
        } catch {
          reject(new AzError('Failed to parse az JSON output.', 'PARSE_ERROR', text.slice(0, 500)));
        }
      },
    );
  });
}
