import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { defaultPaths } from '../src/paths.ts';
import { configFilePath, loadSettings } from '../src/settings.ts';

let home: string;

async function writeConfig(config: unknown, file = configFilePath({ env: {}, home })): Promise<void> {
  await mkdir(join(file, '..'), { recursive: true });
  await writeFile(file, typeof config === 'string' ? config : JSON.stringify(config));
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-login-settings-'));
});

test('with no vault anywhere, loading settings is refused', async () => {
  await assert.rejects(loadSettings({ env: {}, home }), { code: 'NO_VAULT' });

  await writeConfig({ tokenFile: '/somewhere/op-token' });
  await assert.rejects(loadSettings({ env: {}, home }), { code: 'NO_VAULT' });
});

test('the vault from the config file is used, with the default folders', async () => {
  await writeConfig({ vault: 'Team Agents' });

  assert.deepEqual(await loadSettings({ env: {}, home }), { vault: 'Team Agents', ...defaultPaths(home) });
});

test('an environment variable beats the config file, setting by setting', async () => {
  await writeConfig({ vault: 'From File', tokenFile: '/file/op-token', accountsDir: '/file/accounts' });
  const env = { AGENT_LOGIN_VAULT: 'From Env', AGENT_LOGIN_TOKEN_FILE: '/env/op-token' };

  const settings = await loadSettings({ env, home });

  assert.equal(settings.vault, 'From Env');
  assert.equal(settings.tokenFile, '/env/op-token');
  assert.equal(settings.accountsDir, '/file/accounts');
  assert.equal(settings.sessionsDir, defaultPaths(home).sessionsDir);
});

test('every folder can be set by environment variable', async () => {
  const env = {
    AGENT_LOGIN_VAULT: 'V',
    AGENT_LOGIN_TOKEN_FILE: '/a/token',
    AGENT_LOGIN_ACCOUNTS_DIR: '/a/accounts',
    AGENT_LOGIN_SESSIONS_DIR: '/a/sessions',
    AGENT_LOGIN_LOG_FILE: '/a/log.jsonl',
  };

  assert.deepEqual(await loadSettings({ env, home }), {
    vault: 'V',
    tokenFile: '/a/token',
    accountsDir: '/a/accounts',
    sessionsDir: '/a/sessions',
    logFile: '/a/log.jsonl',
  });
});

test('AGENT_LOGIN_CONFIG points at a different config file', async () => {
  const other = join(home, 'carson', 'agent-login.json');
  await writeConfig({ vault: 'Carson Agents', sessionsDir: '~/carson/sessions' }, other);
  await writeConfig({ vault: 'Default File' });

  const settings = await loadSettings({ env: { AGENT_LOGIN_CONFIG: other }, home });

  assert.equal(settings.vault, 'Carson Agents');
  assert.equal(settings.sessionsDir, join(home, 'carson', 'sessions'));
});

test('paths starting with ~/ are under the home folder, and relative paths are refused', async () => {
  await writeConfig({ vault: 'V', logFile: '~/logs/agent-login.jsonl' });
  assert.equal((await loadSettings({ env: {}, home })).logFile, join(home, 'logs', 'agent-login.jsonl'));

  await writeConfig({ vault: 'V', logFile: 'logs/agent-login.jsonl' });
  await assert.rejects(loadSettings({ env: {}, home }), { code: 'BAD_CONFIG' });
  await assert.rejects(loadSettings({ env: { AGENT_LOGIN_VAULT: 'V', AGENT_LOGIN_TOKEN_FILE: 'op-token' }, home: '/h' }), {
    code: 'BAD_CONFIG',
  });
});

test('a config file that is not a JSON object of known string settings is refused', async () => {
  for (const config of ['{not json', '["vault"]', { vault: 'V', vualt: 'typo' }, { vault: 42 }, { vault: '' }]) {
    await writeConfig(config);
    await assert.rejects(loadSettings({ env: {}, home }), { code: 'BAD_CONFIG' }, JSON.stringify(config));
  }
});

test('a config file that exists but cannot be read is refused, not treated as missing', async () => {
  await mkdir(configFilePath({ env: {}, home }), { recursive: true });

  await assert.rejects(loadSettings({ env: { AGENT_LOGIN_VAULT: 'V' }, home }), { code: 'BAD_CONFIG' });
});
