import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Refusal } from './refusal.ts';

export type AccountConfig = {
  usernameSelector: string;
  passwordSelector: string;
  submitSelector: string;
  loginUrl?: string;
  signedInSelector?: string;
};

const REQUIRED = ['usernameSelector', 'passwordSelector', 'submitSelector'] as const;
const OPTIONAL = ['loginUrl', 'signedInSelector'] as const;

export function accountConfigFile(accountsDir: string, accountKey: string): string {
  return join(accountsDir, `${accountKey}.json`);
}

export function notesFile(accountsDir: string, accountKey: string): string {
  return join(accountsDir, `${accountKey}.notes.md`);
}

export async function readAccountConfig(accountsDir: string, accountKey: string): Promise<AccountConfig> {
  const file = accountConfigFile(accountsDir, accountKey);
  const raw = await readFile(file, 'utf8').catch(() => null);
  if (raw === null) {
    throw new Refusal('NO_ACCOUNT_CONFIG', `No selectors for this account. Create ${file} with ${REQUIRED.join(', ')}.`);
  }
  return parseAccountConfig(raw, file);
}

export async function writeAccountConfig(
  accountsDir: string,
  accountKey: string,
  config: AccountConfig,
  { replace }: { replace: boolean },
): Promise<string> {
  const file = accountConfigFile(accountsDir, accountKey);
  const content = `${JSON.stringify(config, null, 2)}\n`;
  parseAccountConfig(content, file);
  await mkdir(accountsDir, { recursive: true, mode: 0o700 });
  try {
    await writeFile(file, content, { mode: 0o600, flag: replace ? 'w' : 'wx' });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    throw new Refusal('ACCOUNT_CONFIG_EXISTS', `${file} already exists. Pass --replace to overwrite it.`);
  }
  return file;
}

export async function startNotesFile(accountsDir: string, accountKey: string): Promise<string> {
  const file = notesFile(accountsDir, accountKey);
  const template = [
    `# ${accountKey}`,
    '',
    'Site: (what this account is for, for example "the office desk booking site")',
    '',
    '## Using the site',
    '',
    'Agents add what they learn about using this site after signing in. Never put a password, token or personal data here.',
    '',
  ].join('\n');
  await writeFile(file, template, { mode: 0o600, flag: 'wx' }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  return file;
}

function parseAccountConfig(raw: string, file: string): AccountConfig {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Refusal('BAD_ACCOUNT_CONFIG', `${file} is not valid JSON.`);
  }
  for (const key of REQUIRED) {
    if (typeof value[key] !== 'string' || !value[key]) {
      throw new Refusal('BAD_ACCOUNT_CONFIG', `${file} needs a non-empty string "${key}".`);
    }
  }
  for (const key of OPTIONAL) {
    if (value[key] !== undefined && typeof value[key] !== 'string') {
      throw new Refusal('BAD_ACCOUNT_CONFIG', `${file}: "${key}" must be a string.`);
    }
  }
  return value as AccountConfig;
}
