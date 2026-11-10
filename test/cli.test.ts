import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, test } from 'node:test';
import { defaultPaths, type Paths } from '../src/paths.ts';
import { configFilePath } from '../src/settings.ts';

const BIN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'agent-login');
const ACCOUNT = 'abcdefghijklmnopqrstuvwxyz';
const FAKE_TOKEN = 'ops_fake-token-that-must-never-be-printed';

let home: string;
let paths: Paths;

function run(...args: string[]) {
  return runWith({ AGENT_LOGIN_VAULT: 'Test Agents' }, ...args);
}

function runWith(extraEnv: Record<string, string>, ...args: string[]) {
  const env = { PATH: process.env.PATH, HOME: home, ...extraEnv };
  const result = spawnSync(BIN, args, { env, encoding: 'utf8', timeout: 60_000 });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, code: parseCode(result.stderr) };
}

function parseCode(stderr: string): string | undefined {
  try {
    return JSON.parse(stderr).code;
  } catch {
    return undefined;
  }
}

async function writeToken(mode: number): Promise<void> {
  await mkdir(dirname(paths.tokenFile), { recursive: true });
  await writeFile(paths.tokenFile, `${FAKE_TOKEN}\n`);
  await chmod(paths.tokenFile, mode);
}

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-login-cli-'));
  paths = defaultPaths(home);
});

test('a missing token file is refused', () => {
  const result = run(ACCOUNT);

  assert.equal(result.status, 2);
  assert.equal(result.code, 'TOKEN_MISSING');
  assert.equal(result.stdout, '');
});

test('a token file that others can read is refused without reading it', async () => {
  await writeToken(0o644);
  const result = run(ACCOUNT);

  assert.equal(result.code, 'TOKEN_TOO_OPEN');
  assert.ok(!(result.stdout + result.stderr).includes(FAKE_TOKEN));
});

test('a token 1Password rejects fails the lookup without printing the token', async () => {
  await writeToken(0o600);
  const result = run(ACCOUNT);

  assert.equal(result.code, 'LOOKUP_FAILED');
  assert.ok(!(result.stdout + result.stderr).includes(FAKE_TOKEN));
});

test('anything other than one account key prints usage', () => {
  assert.equal(run().status, 64);
  assert.equal(run('--help').status, 64);
  assert.equal(run(ACCOUNT, 'extra').status, 64);
});

test('with no vault set, signing in is refused before anything else', () => {
  const result = runWith({}, ACCOUNT);

  assert.equal(result.status, 2);
  assert.equal(result.code, 'NO_VAULT');
});

describe('setup', () => {
  // A stand-in for the 1Password CLI that only lets FAKE_TOKEN read the Test Agents vault.
  async function fakeOpOnPath(): Promise<string> {
    const bin = join(home, 'fake-bin');
    await mkdir(bin);
    await writeFile(
      join(bin, 'op'),
      `#!/usr/bin/env bash
case "$1 $2" in
  "--version "*) echo 2.99.0 ;;
  "vault get") [ "$OP_SERVICE_ACCOUNT_TOKEN" = "${FAKE_TOKEN}" ] && [ "$3" = "Test Agents" ] && echo '{}' && exit 0
               echo "[ERROR] no access to $3" >&2; exit 1 ;;
  *) exit 1 ;;
esac
`,
      { mode: 0o755 },
    );
    return `${bin}:${process.env.PATH}`;
  }

  test('saves the vault, checks the token can read it, and never prints the token', async () => {
    await writeToken(0o600);
    const result = runWith({ PATH: await fakeOpOnPath() }, 'setup', '--vault', 'Test Agents');

    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.match(result.stdout, /ok +vault access: the token can read Test Agents/);
    assert.ok(!(result.stdout + result.stderr).includes(FAKE_TOKEN));
    assert.deepEqual(JSON.parse(await readFile(configFilePath({ env: {}, home }), 'utf8')), { vault: 'Test Agents' });
  });

  test('a token that cannot read the vault fails setup, without printing the token', async () => {
    await writeToken(0o600);
    const result = runWith({ PATH: await fakeOpOnPath() }, 'setup', '--vault', 'Someone Else');

    assert.equal(result.status, 2);
    assert.match(result.stdout, /FAIL +vault access: .*no access to Someone Else/);
    assert.ok(!(result.stdout + result.stderr).includes(FAKE_TOKEN));
  });

  test('an unknown flag prints usage', () => {
    assert.equal(run('setup', '--vualt', 'x').status, 64);
  });
});

describe('add-site', () => {
  const SELECTOR_FLAGS = ['--username-selector', '#email', '--password-selector', 'input[type=password]', '--submit-selector', 'button'];

  test('writes the site settings and an empty notes file, both readable by the owner only', async () => {
    const result = run('add-site', ACCOUNT, ...SELECTOR_FLAGS, '--login-url', 'https://example.test/login', '--signed-in-selector', 'nav');

    assert.equal(result.status, 0, result.stderr);
    const output = JSON.parse(result.stdout);
    assert.equal(output.configFile, join(paths.accountsDir, `${ACCOUNT}.json`));
    assert.equal(output.notesFile, join(paths.accountsDir, `${ACCOUNT}.notes.md`));
    assert.deepEqual(JSON.parse(await readFile(output.configFile, 'utf8')), {
      usernameSelector: '#email',
      passwordSelector: 'input[type=password]',
      submitSelector: 'button',
      loginUrl: 'https://example.test/login',
      signedInSelector: 'nav',
    });
    for (const file of [output.configFile, output.notesFile]) assert.equal((await stat(file)).mode & 0o777, 0o600);
  });

  test('refuses to overwrite a site unless told to, and never overwrites its notes', async () => {
    run('add-site', ACCOUNT, ...SELECTOR_FLAGS);
    const notes = join(paths.accountsDir, `${ACCOUNT}.notes.md`);
    await writeFile(notes, 'the booking page takes ?date=YYYY-MM-DD');

    assert.equal(run('add-site', ACCOUNT, ...SELECTOR_FLAGS).code, 'ACCOUNT_CONFIG_EXISTS');
    assert.equal(run('add-site', ACCOUNT, ...SELECTOR_FLAGS.slice(0, 4), '--submit-selector', '#go', '--replace').status, 0);
    assert.equal(JSON.parse(await readFile(join(paths.accountsDir, `${ACCOUNT}.json`), 'utf8')).submitSelector, '#go');
    assert.equal(await readFile(notes, 'utf8'), 'the booking page takes ?date=YYYY-MM-DD');
  });

  test('refuses a key that is not an item id, a missing selector or a login address that is not a URL', () => {
    assert.equal(run('add-site', '--vault=Private', ...SELECTOR_FLAGS).status, 64);
    assert.equal(run('add-site', 'not-an-item-id', ...SELECTOR_FLAGS).code, 'BAD_ACCOUNT_KEY');
    assert.equal(run('add-site', ACCOUNT, ...SELECTOR_FLAGS.slice(0, 4)).status, 64);
    assert.equal(run('add-site', ACCOUNT, ...SELECTOR_FLAGS, '--login-url', 'example.test/login').code, 'BAD_ACCOUNT_CONFIG');
  });
});
