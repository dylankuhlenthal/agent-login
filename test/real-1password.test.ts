import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, describe, test } from 'node:test';
import type { AccountConfig } from '../src/account-config.ts';
import { agentLogin } from '../src/agent-login.ts';
import { onePasswordSource } from '../src/onepassword.ts';
import { defaultPaths, type Paths } from '../src/paths.ts';
import { loadSettings, type Settings } from '../src/settings.ts';
import { sawPassword, startFakeSite, type FakeSite } from './fake-sites.ts';

// Needs the real token and talks to the real vault from your settings, so it only runs when asked.
const enabled = process.env.AGENT_LOGIN_REAL === '1';
const realItem = process.env.AGENT_LOGIN_REAL_ITEM ?? '';
const UNKNOWN_ITEM = 'zzzzzzzzzzzzzzzzzzzzzzzzzz';

describe('against the real vault', { skip: !enabled && 'set AGENT_LOGIN_REAL=1 to run' }, () => {
  let real: Settings;
  let paths: Paths;
  let phishing: FakeSite;
  let selectors: AccountConfig;

  before(async () => {
    real = await loadSettings();
    const home = await mkdtemp(join(tmpdir(), 'agent-login-real-'));
    paths = { ...defaultPaths(home), tokenFile: real.tokenFile };
    phishing = await startFakeSite();
    selectors = JSON.parse(await readFile(join(real.accountsDir, `${realItem}.json`), 'utf8'));
  });

  after(async () => {
    await phishing.close();
  });

  async function useConfig(config: AccountConfig): Promise<void> {
    await mkdir(paths.accountsDir, { recursive: true });
    await writeFile(join(paths.accountsDir, `${realItem}.json`), JSON.stringify(config));
  }

  async function refusalCode(accountKey: string): Promise<string> {
    const error = await agentLogin(accountKey, paths, onePasswordSource(paths.tokenFile, real.vault)).then(
      () => assert.fail('expected a refusal'),
      (caught: unknown) => caught as { code?: string },
    );
    return error.code ?? 'no code';
  }

  test('an item id that is not in the vault is refused', async () => {
    assert.equal(await refusalCode(UNKNOWN_ITEM), 'UNKNOWN_ACCOUNT');
  });

  test('a login address on 127.0.0.1 is refused for the real item, before the browser goes there', async () => {
    await useConfig({ ...selectors, loginUrl: `${phishing.origin}/login` });

    assert.equal(await refusalCode(realItem), 'SITE_NOT_ALLOWED');
    assert.deepEqual(phishing.received, []);
    assert.equal(sawPassword(phishing), false);
  });

  test("the item's own website is refused when it redirects to a site not on the item", async () => {
    const { loginUrl, ...withoutLoginUrl } = selectors;
    await useConfig(withoutLoginUrl);

    assert.equal(await refusalCode(realItem), 'SITE_NOT_ALLOWED');
  });

  test('a password selector pointing at the real site username field is refused without submitting', async () => {
    await useConfig({ ...selectors, passwordSelector: selectors.usernameSelector });

    assert.equal(await refusalCode(realItem), 'NOT_A_PASSWORD_FIELD');
  });
});
