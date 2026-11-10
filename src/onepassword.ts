import { execFile } from 'node:child_process';
import { readFile, stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import { Refusal } from './refusal.ts';
import { registerSecret } from './output-guard.ts';

const OP_TIMEOUT_MS = 30_000;
const ITEM_ID = /^[a-z0-9]{26}$/;

export type Credentials = {
  username: string;
  password: string;
  allowedOrigins: string[];
  primaryUrl: string;
};

export type CredentialSource = (accountKey: string) => Promise<Credentials>;

type OpField = { purpose?: string; value?: string };
type OpUrl = { href?: string; primary?: boolean };
type OpItem = { fields?: OpField[]; urls?: OpUrl[] };

export function assertAccountKey(accountKey: string): void {
  if (!ITEM_ID.test(accountKey)) {
    throw new Refusal('BAD_ACCOUNT_KEY', 'The account key must be a 1Password item id (26 lowercase letters and digits).');
  }
}

export async function readToken(tokenFile: string): Promise<string> {
  const info = await stat(tokenFile).catch(() => null);
  if (!info) throw new Refusal('TOKEN_MISSING', `No 1Password service account token at ${tokenFile}.`);
  if ((info.mode & 0o077) !== 0) {
    throw new Refusal('TOKEN_TOO_OPEN', `${tokenFile} must be readable by its owner only (chmod 600).`);
  }
  const token = (await readFile(tokenFile, 'utf8')).trim();
  if (!token) throw new Refusal('TOKEN_MISSING', `${tokenFile} is empty.`);
  registerSecret(token);
  return token;
}

export function onePasswordSource(tokenFile: string, vault: string): CredentialSource {
  return async (accountKey) => {
    assertAccountKey(accountKey);
    const token = await readToken(tokenFile);
    const item = await fetchItem(accountKey, vault, token);
    return credentialsFromItem(item);
  };
}

async function fetchItem(accountKey: string, vault: string, token: string): Promise<OpItem> {
  const args = ['item', 'get', accountKey, '--vault', vault, '--format', 'json', '--reveal'];
  try {
    return JSON.parse(await runOp(args, token)) as OpItem;
  } catch (error) {
    const stderr = opErrorText(error);
    if (/isn't an item/i.test(stderr)) {
      throw new Refusal('UNKNOWN_ACCOUNT', `No item ${accountKey} in the ${vault} vault.`);
    }
    throw new Refusal('LOOKUP_FAILED', `1Password lookup failed: ${firstLine(stderr, error)}`);
  }
}

export async function checkVaultAccess(tokenFile: string, vault: string): Promise<void> {
  const token = await readToken(tokenFile);
  try {
    await runOp(['vault', 'get', vault, '--format', 'json'], token);
  } catch (error) {
    throw new Refusal('LOOKUP_FAILED', `The token cannot read the ${vault} vault: ${firstLine(opErrorText(error), error)}`);
  }
}

async function runOp(args: string[], token: string): Promise<string> {
  // The token goes to op through its environment only, never argv, and the child
  // gets no other variables from ours.
  const env = { PATH: process.env.PATH ?? '', HOME: process.env.HOME ?? '', OP_SERVICE_ACCOUNT_TOKEN: token };
  const { stdout } = await promisify(execFile)('op', args, { env, timeout: OP_TIMEOUT_MS, maxBuffer: 1 << 20 });
  return stdout;
}

function opErrorText(error: unknown): string {
  return String((error as { stderr?: string }).stderr ?? '');
}

function firstLine(stderr: string, error: unknown): string {
  return stderr.trim().split('\n')[0] || (error as Error).message;
}

export function credentialsFromItem(item: OpItem): Credentials {
  const username = item.fields?.find((field) => field.purpose === 'USERNAME')?.value;
  const password = item.fields?.find((field) => field.purpose === 'PASSWORD')?.value;
  const urls = (item.urls ?? []).filter((url): url is OpUrl & { href: string } => Boolean(url.href));
  if (!username || !password || urls.length === 0) {
    throw new Refusal('ITEM_INCOMPLETE', 'The 1Password item needs a username, a password and at least one website.');
  }
  registerSecret(password);
  const primary = urls.find((url) => url.primary) ?? urls[0];
  return {
    username,
    password,
    allowedOrigins: urls.map((url) => absoluteUrl(url.href).origin),
    primaryUrl: absoluteUrl(primary.href).href,
  };
}

// 1Password lets a website be saved without a scheme, for example "example.com".
function absoluteUrl(href: string): URL {
  return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(href) ? href : `https://${href}`);
}
