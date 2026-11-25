import { spawnSync } from 'node:child_process';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * The HTTP image's entrypoint, run against a stand-in for supergateway.
 *
 * The real gateway is not needed to check what this script owns: which keys it
 * hands over, that it refuses to start open by accident, and that the keys go
 * nowhere else. What the gateway then does with `--apiKey` — 401 without it,
 * 200 with it, `/healthz` open — was checked against the pinned version by
 * hand and is that package's own behaviour.
 */
const script = new URL('../docker/mcp-http/entrypoint.sh', import.meta.url)
  .pathname;

let directory: string;
let stub: string;

beforeAll(() => {
  directory = mkdtempSync(join(tmpdir(), 'entrypoint-'));
  stub = join(directory, 'gateway');
  // One argument per line, then whether the key variable reached the process.
  writeFileSync(
    stub,
    '#!/bin/sh\nfor a in "$@"; do printf "arg:%s\\n" "$a"; done\n' +
      'printf "keys-in-env:%s\\n" "$(env | grep -c MCP_API_KEYS)"\n' +
      'printf "opt-out-in-env:%s\\n" "$(env | grep -c MCP_ALLOW_NO_AUTH)"\n'
  );
  chmodSync(stub, 0o755);
});

afterAll(() => {
  rmSync(directory, { recursive: true, force: true });
});

function run(env: Record<string, string>) {
  const result = spawnSync('sh', [script], {
    env: { PATH: process.env.PATH ?? '', GATEWAY_BIN: stub, ...env },
    encoding: 'utf8',
  });
  const lines = result.stdout.split('\n');
  return {
    status: result.status,
    stderr: result.stderr,
    args: lines.filter((l) => l.startsWith('arg:')).map((l) => l.slice(4)),
    keysInEnv: lines.includes('keys-in-env:1'),
    optOutInEnv: lines.includes('opt-out-in-env:1'),
  };
}

const keyFlags = (args: string[]): string[] =>
  args.filter((arg) => arg.startsWith('--apiKey='));

describe('the http entrypoint', () => {
  it('refuses to start without MCP_API_KEYS', () => {
    const result = run({});
    expect(result.status).toBe(1);
    expect(result.stderr).toContain('MCP_API_KEYS is not set');
    expect(result.args).toEqual([]);
  });

  it('refuses a variable that holds no key', () => {
    for (const value of [',', ' , ,', '  ']) {
      const result = run({ MCP_API_KEYS: value });
      expect(result.status, JSON.stringify(value)).toBe(1);
      expect(result.args).toEqual([]);
    }
  });

  it('starts open only when told so, and says so', () => {
    const result = run({ MCP_ALLOW_NO_AUTH: 'true' });
    expect(result.status).toBe(0);
    expect(keyFlags(result.args)).toEqual([]);
    expect(result.stderr).toContain('without authentication');
    // Anything but the literal word is not an opt-out.
    expect(run({ MCP_ALLOW_NO_AUTH: '1' }).status).toBe(1);
    expect(run({ MCP_ALLOW_NO_AUTH: 'yes' }).status).toBe(1);
  });

  it('hands every key to the gateway, one flag each, trimmed', () => {
    const result = run({ MCP_API_KEYS: ' alpha-key ,beta-key,,gamma-key ' });
    expect(result.status).toBe(0);
    expect(keyFlags(result.args)).toEqual([
      '--apiKey=alpha-key',
      '--apiKey=beta-key',
      '--apiKey=gamma-key',
    ]);
  });

  it('keeps the transport settings the image has always had', () => {
    const { args } = run({ MCP_API_KEYS: 'k' });
    expect(args).toEqual(
      expect.arrayContaining([
        '--outputTransport',
        'streamableHttp',
        '--stateful',
        '--port',
        '8000',
        '--healthEndpoint',
        '/healthz',
      ])
    );
    expect(args[args.indexOf('--stdio') + 1]).toBe('node /app/dist/index.js');
  });

  it('passes a key that looks like a flag or a glob as a value, untouched', () => {
    const result = run({ MCP_API_KEYS: '--help,*,a$b' });
    expect(keyFlags(result.args)).toEqual([
      '--apiKey=--help',
      '--apiKey=*',
      '--apiKey=a$b',
    ]);
  });

  it('never prints a key, and does not leave it in the environment', () => {
    const result = run({ MCP_API_KEYS: 'super-secret-token' });
    expect(result.stderr).not.toContain('super-secret-token');
    expect(result.stderr).toContain('1 key(s)');
    expect(result.keysInEnv).toBe(false);
    expect(run({ MCP_ALLOW_NO_AUTH: 'true' }).optOutInEnv).toBe(false);
  });
});
