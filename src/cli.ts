import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { notesFile, startNotesFile, writeAccountConfig, type AccountConfig } from './account-config.ts';
import { agentLogin } from './agent-login.ts';
import { assertAccountKey, onePasswordSource } from './onepassword.ts';
import { guardProcessOutput } from './output-guard.ts';
import { Refusal } from './refusal.ts';
import { loadSettings } from './settings.ts';
import { runSetup } from './setup.ts';

const HARD_TIMEOUT_MS = 120_000;
const USAGE = `usage:
  agent-login <account key>
  agent-login setup [--vault <name>]
  agent-login add-site <account key> --username-selector <css> --password-selector <css> --submit-selector <css>
                       [--login-url <url>] [--signed-in-selector <css>] [--replace]`;

class UsageError extends Error {}

async function main(args: string[]): Promise<number> {
  guardProcessOutput();
  try {
    if (args.length === 1 && (args[0] === '--help' || args[0] === '-h')) {
      process.stdout.write(`${USAGE}\n`);
      return 0;
    }
    if (args[0] === 'setup') return await setup(args.slice(1));
    if (args[0] === 'add-site') return await addSite(args.slice(1));
    if (args.length !== 1 || args[0].startsWith('-')) throw new UsageError();
    return await signIn(args[0]);
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message ? `${error.message}\n` : ''}${USAGE}\n`);
      return 64;
    }
    if (error instanceof Refusal) {
      process.stderr.write(`${JSON.stringify({ ok: false, code: error.code, message: error.message })}\n`);
      return 2;
    }
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'ERROR', message: (error as Error).message })}\n`);
    return 1;
  }
}

async function signIn(accountKey: string): Promise<number> {
  setTimeout(() => {
    process.stderr.write(`${JSON.stringify({ ok: false, code: 'ERROR', message: 'Timed out.' })}\n`);
    process.exit(1);
  }, HARD_TIMEOUT_MS).unref();

  const settings = await loadSettings();
  const session = await agentLogin(accountKey, settings, onePasswordSource(settings.tokenFile, settings.vault));
  const output = {
    ok: true,
    ...session,
    notesFile: notesFile(settings.accountsDir, accountKey),
    open: howToOpen(session.profileDir, accountKey),
  };
  process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
  return 0;
}

function howToOpen(profileDir: string, accountKey: string) {
  return {
    env: {
      CHROME_DEVTOOLS_AXI_USER_DATA_DIR: profileDir,
      CHROME_DEVTOOLS_AXI_SESSION: `agent-login-${accountKey}`,
    },
    then: 'npx -y chrome-devtools-axi open <signedInUrl>',
    whenDone: `npx -y chrome-devtools-axi stop, then rm -rf ${profileDir}`,
  };
}

async function setup(args: string[]): Promise<number> {
  const { values } = parse(args, { vault: { type: 'string' } });
  const checks = await runSetup({ vault: values.vault, askVault });
  for (const check of checks) process.stdout.write(`${check.ok ? 'ok  ' : 'FAIL'}  ${check.name}: ${check.detail}\n`);
  const ok = checks.every((check) => check.ok);
  process.stdout.write(ok ? '\nReady. Add a site with "agent-login add-site".\n' : '\nFix the FAIL lines above, then run "agent-login setup" again.\n');
  return ok ? 0 : 2;
}

async function askVault(): Promise<string> {
  if (!process.stdin.isTTY) return '';
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    return (await prompt.question('1Password vault the service account reads: ')).trim();
  } finally {
    prompt.close();
  }
}

async function addSite(args: string[]): Promise<number> {
  const { values, positionals } = parse(args, {
    'username-selector': { type: 'string' },
    'password-selector': { type: 'string' },
    'submit-selector': { type: 'string' },
    'login-url': { type: 'string' },
    'signed-in-selector': { type: 'string' },
    replace: { type: 'boolean' },
  });
  if (positionals.length !== 1) throw new UsageError('add-site takes exactly one account key.');
  const [accountKey] = positionals;
  assertAccountKey(accountKey);

  const config = siteConfig(values);
  const settings = await loadSettings();
  const configFile = await writeAccountConfig(settings.accountsDir, accountKey, config, { replace: values.replace === true });
  const notes = await startNotesFile(settings.accountsDir, accountKey);
  process.stdout.write(`${JSON.stringify({ ok: true, account: accountKey, configFile, notesFile: notes }, null, 2)}\n`);
  return 0;
}

type SiteFlags = Partial<Record<'username-selector' | 'password-selector' | 'submit-selector' | 'login-url' | 'signed-in-selector', string>>;

function siteConfig(values: SiteFlags): AccountConfig {
  const missing = (['username-selector', 'password-selector', 'submit-selector'] as const).filter((flag) => !values[flag]);
  if (missing.length) throw new UsageError(`add-site needs ${missing.map((flag) => `--${flag}`).join(', ')}.`);
  const config: AccountConfig = {
    usernameSelector: values['username-selector'] ?? '',
    passwordSelector: values['password-selector'] ?? '',
    submitSelector: values['submit-selector'] ?? '',
  };
  const loginUrl = values['login-url'];
  if (loginUrl !== undefined) {
    if (!URL.canParse(loginUrl)) throw new Refusal('BAD_ACCOUNT_CONFIG', `--login-url ${JSON.stringify(loginUrl)} is not a full URL.`);
    config.loginUrl = loginUrl;
  }
  if (values['signed-in-selector'] !== undefined) config.signedInSelector = values['signed-in-selector'];
  return config;
}

type Options = NonNullable<NonNullable<Parameters<typeof parseArgs>[0]>['options']>;

function parse<T extends Options>(args: string[], options: T) {
  try {
    return parseArgs({ args, options, allowPositionals: true, strict: true } as const);
  } catch (error) {
    throw new UsageError((error as Error).message);
  }
}

process.exitCode = await main(process.argv.slice(2));
