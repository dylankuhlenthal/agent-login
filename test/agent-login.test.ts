import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, beforeEach, describe, test } from 'node:test';
import { chromium } from 'playwright';
import type { AccountConfig } from '../src/account-config.ts';
import { agentLogin } from '../src/agent-login.ts';
import type { CredentialSource, Credentials } from '../src/onepassword.ts';
import { defaultPaths, type Paths } from '../src/paths.ts';
import { filesContaining } from '../src/profile-scan.ts';
import { PASSWORD, USERNAME, sawPassword, startFakeSite, type FakeSite } from './fake-sites.ts';

const ACCOUNT = 'abcdefghijklmnopqrstuvwxyz';
const SELECTORS: AccountConfig = { usernameSelector: '#email', passwordSelector: '#password', submitSelector: '#submit' };

let allowed: FakeSite;
let phishing: FakeSite;
let home: string;
let paths: Paths;

function credentials(overrides: Partial<Credentials> = {}): CredentialSource {
  return async () => ({
    username: USERNAME,
    password: PASSWORD,
    allowedOrigins: [allowed.origin],
    primaryUrl: `${allowed.origin}/login`,
    ...overrides,
  });
}

async function writeConfig(config: Partial<AccountConfig>): Promise<void> {
  await mkdir(paths.accountsDir, { recursive: true });
  await writeFile(join(paths.accountsDir, `${ACCOUNT}.json`), JSON.stringify({ ...SELECTORS, ...config }));
}

async function refusal(promise: Promise<unknown>): Promise<string> {
  return (await refusalError(promise)).code ?? 'no code';
}

async function refusalError(promise: Promise<unknown>): Promise<{ code?: string; message: string }> {
  return promise.then(
    () => assert.fail('expected a refusal'),
    (caught: unknown) => caught as { code?: string; message: string },
  );
}

async function sessionsLeft(): Promise<string[]> {
  return readdir(paths.sessionsDir).catch(() => []);
}

before(async () => {
  allowed = await startFakeSite();
  phishing = await startFakeSite();
});

after(async () => {
  await allowed.close();
  await phishing.close();
});

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), 'agent-login-test-'));
  paths = defaultPaths(home);
  allowed.received.length = 0;
  allowed.loginAttempts = 0;
  phishing.received.length = 0;
  await writeConfig({});
});

describe('signing in', () => {
  test('returns a profile that opens signed in and holds no copy of the password', async () => {
    const session = await agentLogin(ACCOUNT, paths, credentials());

    assert.equal(session.signedInUrl, `${allowed.origin}/home?username=${USERNAME}`);
    assert.equal(allowed.loginAttempts, 1);
    assert.deepEqual(await filesContaining(session.profileDir, PASSWORD), []);
    const log = await readFile(paths.logFile, 'utf8');
    assert.ok(!log.includes(USERNAME) && !log.includes(PASSWORD), 'the log holds neither the username nor the password');

    const context = await chromium.launchPersistentContext(session.profileDir, { channel: 'chrome', headless: true });
    try {
      const page = context.pages()[0] ?? (await context.newPage());
      await page.goto(`${allowed.origin}/home`);
      assert.equal(await page.textContent('h1'), 'Signed in');
    } finally {
      await context.close();
    }
    await rm(session.profileDir, { recursive: true, force: true });
  });

  test('a rejected password fails once, is not retried, and leaves no profile behind', async () => {
    const code = await refusal(agentLogin(ACCOUNT, paths, credentials({ password: 'wrong-password' })));

    assert.equal(code, 'SIGN_IN_FAILED');
    assert.equal(allowed.loginAttempts, 1);
    assert.deepEqual(await sessionsLeft(), []);
  });

  test('a failed sign-in whose page draws the login form late is not counted as signed in', async () => {
    const slow = await startFakeSite({ slowFormAfterFailedLogin: true });
    try {
      const code = await refusal(
        agentLogin(
          ACCOUNT,
          paths,
          credentials({ password: 'wrong-password', allowedOrigins: [slow.origin], primaryUrl: `${slow.origin}/login` }),
        ),
      );

      assert.equal(code, 'SIGN_IN_FAILED');
      assert.equal(slow.loginAttempts, 1);
    } finally {
      await slow.close();
    }
  });

  test('a site that sends the browser to another site after the login form is not counted as signed in', async () => {
    const moved = await startFakeSite();
    moved.redirectAfterLogin = `${phishing.origin}/login?msg=LoginPageMoved`;
    try {
      const error = await refusalError(
        agentLogin(ACCOUNT, paths, credentials({ allowedOrigins: [moved.origin], primaryUrl: `${moved.origin}/login` })),
      );

      assert.equal(error.code, 'SIGN_IN_FAILED');
      assert.match(error.message, /sent the browser to http:\/\/127\.0\.0\.1:\d+\/login\?msg=LoginPageMoved/);
      assert.equal(moved.loginAttempts, 1);
      assert.deepEqual(await sessionsLeft(), []);
    } finally {
      await moved.close();
    }
  });
});

describe('sibling subdomains', () => {
  // Chrome sends every *.localhost name to this machine, so one fake site can play
  // app.example.localhost, venue.example.localhost and a look-alike.
  const at = (site: FakeSite, host: string) => `http://${host}:${new URL(site.origin).port}`;

  test('landing on a sibling subdomain after signing in counts as signed in', async () => {
    const site = await startFakeSite();
    site.redirectAfterLogin = `${at(site, 'venue.example.localhost')}/booking`;
    try {
      const appSite = at(site, 'app.example.localhost');
      const session = await agentLogin(ACCOUNT, paths, credentials({ allowedOrigins: [appSite], primaryUrl: `${appSite}/login` }));

      assert.equal(session.signedInUrl, `${at(site, 'venue.example.localhost')}/booking`);
      await rm(session.profileDir, { recursive: true, force: true });
    } finally {
      await site.close();
    }
  });

  test('a sibling subdomain is refused as the login page', async () => {
    const site = await startFakeSite();
    try {
      const appSite = at(site, 'app.example.localhost');
      await writeConfig({ loginUrl: `${at(site, 'venue.example.localhost')}/login` });

      const code = await refusal(agentLogin(ACCOUNT, paths, credentials({ allowedOrigins: [appSite], primaryUrl: `${appSite}/login` })));

      assert.equal(code, 'SITE_NOT_ALLOWED');
      assert.deepEqual(site.received, []);
    } finally {
      await site.close();
    }
  });

  test('a look-alike host after signing in is not counted as signed in', async () => {
    const site = await startFakeSite();
    site.redirectAfterLogin = `${at(site, 'example.localhost.evil.localhost')}/booking`;
    try {
      const appSite = at(site, 'app.example.localhost');
      const error = await refusalError(
        agentLogin(ACCOUNT, paths, credentials({ allowedOrigins: [appSite], primaryUrl: `${appSite}/login` })),
      );

      assert.equal(error.code, 'SIGN_IN_FAILED');
      assert.match(error.message, /sent the browser to http:\/\/example\.localhost\.evil\.localhost:/);
      assert.deepEqual(await sessionsLeft(), []);
    } finally {
      await site.close();
    }
  });
});

describe('refusing without typing the password anywhere', () => {
  test('a login address that is not one of the account websites is refused before the browser goes there', async () => {
    await writeConfig({ loginUrl: `${phishing.origin}/login` });

    assert.equal(await refusal(agentLogin(ACCOUNT, paths, credentials())), 'SITE_NOT_ALLOWED');
    assert.deepEqual(phishing.received, []);
  });

  test('an allowed address that redirects to another site is refused after the redirect', async () => {
    const redirecting = await startFakeSite({ redirectLoginTo: `${phishing.origin}/login` });
    try {
      const code = await refusal(
        agentLogin(ACCOUNT, paths, credentials({ allowedOrigins: [redirecting.origin], primaryUrl: `${redirecting.origin}/login` })),
      );

      assert.equal(code, 'SITE_NOT_ALLOWED');
      assert.ok(phishing.received.some((entry) => entry.startsWith('GET /login')), 'the browser did follow the redirect');
      assert.equal(sawPassword(phishing), false);
      assert.equal(phishing.loginAttempts, 0);
    } finally {
      await redirecting.close();
    }
  });

  test('a password selector that points at a text field is refused', async () => {
    await writeConfig({ passwordSelector: '#note' });

    assert.equal(await refusal(agentLogin(ACCOUNT, paths, credentials())), 'NOT_A_PASSWORD_FIELD');
    assert.equal(sawPassword(allowed), false);
    assert.equal(allowed.loginAttempts, 0);
  });

  test('a password selector that points at the username field is refused', async () => {
    await writeConfig({ passwordSelector: '#email' });

    assert.equal(await refusal(agentLogin(ACCOUNT, paths, credentials())), 'NOT_A_PASSWORD_FIELD');
    assert.equal(sawPassword(allowed), false);
  });

  test('a password selector that matches nothing is refused', async () => {
    await writeConfig({ passwordSelector: '#nothing-here' });

    assert.equal(await refusal(agentLogin(ACCOUNT, paths, credentials())), 'FIELD_NOT_FOUND');
    assert.equal(sawPassword(allowed), false);
  });

  test('an account key that is not a 1Password item id is refused before any lookup', async () => {
    let lookedUp = false;
    const source: CredentialSource = async () => {
      lookedUp = true;
      throw new Error('should not be called');
    };

    assert.equal(await refusal(agentLogin('--vault=Private', paths, source)), 'BAD_ACCOUNT_KEY');
    assert.equal(lookedUp, false);
  });

  test('an account with no selectors on this machine is refused before the browser starts', async () => {
    await rm(paths.accountsDir, { recursive: true });

    assert.equal(await refusal(agentLogin(ACCOUNT, paths, credentials())), 'NO_ACCOUNT_CONFIG');
    assert.deepEqual(allowed.received, []);
  });
});
