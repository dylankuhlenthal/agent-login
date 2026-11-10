import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { defaultPaths } from '../src/paths.ts';
import { configFilePath } from '../src/settings.ts';
import { runSetup, type Check, type SetupTools } from '../src/setup.ts';

let home: string;
let vaultReads: { tokenFile: string; vault: string }[];

function tools(overrides: Partial<SetupTools> = {}): SetupTools {
  return {
    opVersion: async () => '2.99.0',
    chromePath: async () => '/opt/google/chrome/chrome',
    canReadVault: async (tokenFile, vault) => {
      vaultReads.push({ tokenFile, vault });
    },
    ...overrides,
  };
}

async function writeToken(mode: number, content = 'ops_fake\n'): Promise<void> {
  const tokenFile = defaultPaths(home).tokenFile;
  await mkdir(dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, content);
  await chmod(tokenFile, mode);
}

function failed(checks: Check[]): string[] {
  return checks.filter((check) => !check.ok).map((check) => check.name);
}

async function savedConfig(): Promise<unknown> {
  return JSON.parse(await readFile(configFilePath({ env: {}, home }), 'utf8'));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-login-setup-'));
  vaultReads = [];
});

test('with everything in place, setup saves the vault, passes every check and tries the vault once', async () => {
  await writeToken(0o600);

  const checks = await runSetup({ vault: 'Team Agents', env: {}, home, tools: tools() });

  assert.deepEqual(failed(checks), []);
  assert.deepEqual(
    checks.map((check) => check.name),
    ['vault', 'site settings folder', 'token file', '1Password CLI', 'Google Chrome', 'vault access'],
  );
  assert.deepEqual(await savedConfig(), { vault: 'Team Agents' });
  assert.equal((await stat(configFilePath({ env: {}, home }))).mode & 0o777, 0o600);
  assert.equal((await stat(defaultPaths(home).accountsDir)).isDirectory(), true);
  assert.deepEqual(vaultReads, [{ tokenFile: defaultPaths(home).tokenFile, vault: 'Team Agents' }]);
});

test('setup keeps the other settings already in the config file', async () => {
  await writeToken(0o600);
  const file = configFilePath({ env: {}, home });
  await writeFile(file, JSON.stringify({ vault: 'Old', logFile: '~/agent-login.jsonl' }));

  await runSetup({ vault: 'New', env: {}, home, tools: tools() });

  assert.deepEqual(await savedConfig(), { vault: 'New', logFile: '~/agent-login.jsonl' });
});

test('with no --vault, setup asks for one, unless one is already set', async () => {
  await writeToken(0o600);
  let asked = 0;
  const askVault = async () => {
    asked += 1;
    return 'Asked Vault';
  };

  await runSetup({ askVault, env: {}, home, tools: tools() });
  await runSetup({ askVault, env: {}, home, tools: tools() });

  assert.equal(asked, 1);
  assert.deepEqual(await savedConfig(), { vault: 'Asked Vault' });
});

test('a vault from AGENT_LOGIN_VAULT is used but not written to the config file', async () => {
  await writeToken(0o600);

  const checks = await runSetup({ env: { AGENT_LOGIN_VAULT: 'Env Vault' }, home, tools: tools() });

  assert.deepEqual(failed(checks), []);
  assert.match(checks[0].detail, /Env Vault \(from AGENT_LOGIN_VAULT/);
  await assert.rejects(readFile(configFilePath({ env: {}, home })), { code: 'ENOENT' });
});

test('with no vault given and nobody to ask, setup fails without writing anything', async () => {
  const checks = await runSetup({ env: {}, home, tools: tools() });

  assert.deepEqual(failed(checks), ['vault']);
  await assert.rejects(readFile(configFilePath({ env: {}, home })), { code: 'ENOENT' });
});

test('a missing, empty or too-open token file fails, and the vault is not tried', async () => {
  const cases: [string, () => Promise<void>][] = [
    ['missing', async () => {}],
    ['empty', () => writeToken(0o600, '')],
    ['too open', () => writeToken(0o644)],
  ];
  for (const [name, prepare] of cases) {
    home = await mkdtemp(join(tmpdir(), 'agent-login-setup-'));
    await prepare();

    const checks = await runSetup({ vault: 'V', env: {}, home, tools: tools() });

    assert.deepEqual(failed(checks), ['token file'], name);
    assert.equal(checks.some((check) => check.name === 'vault access'), false, name);
  }
  assert.deepEqual(vaultReads, []);
});

test('a missing 1Password CLI or Chrome fails its check', async () => {
  await writeToken(0o600);

  const noOp = await runSetup({ vault: 'V', env: {}, home, tools: tools({ opVersion: async () => null }) });
  const noChrome = await runSetup({ vault: 'V', env: {}, home, tools: tools({ chromePath: async () => null }) });

  assert.deepEqual(failed(noOp), ['1Password CLI']);
  assert.deepEqual(failed(noChrome), ['Google Chrome']);
});

test('a token that cannot read the vault fails the vault access check', async () => {
  await writeToken(0o600);
  const canReadVault = async () => {
    throw new Error('The token cannot read the V vault: no access');
  };

  const checks = await runSetup({ vault: 'V', env: {}, home, tools: tools({ canReadVault }) });

  assert.deepEqual(failed(checks), ['vault access']);
});
