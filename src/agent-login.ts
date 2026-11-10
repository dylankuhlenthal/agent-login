import { appendFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { readAccountConfig } from './account-config.ts';
import { assertAccountKey, type CredentialSource } from './onepassword.ts';
import type { Paths } from './paths.ts';
import { filesContaining } from './profile-scan.ts';
import { Refusal } from './refusal.ts';
import { signIn } from './sign-in.ts';

export type SignedInSession = {
  account: string;
  profileDir: string;
  signedInUrl: string;
};

export async function agentLogin(accountKey: string, paths: Paths, credentialsFor: CredentialSource): Promise<SignedInSession> {
  try {
    const session = await signInToFreshProfile(accountKey, paths, credentialsFor);
    await audit(paths, { account: accountKey, result: 'signed-in', signedInPage: withoutQuery(session.signedInUrl) });
    return session;
  } catch (error) {
    const result = error instanceof Refusal ? error.code : 'ERROR';
    await audit(paths, { account: accountKey, result });
    throw error;
  }
}

async function signInToFreshProfile(accountKey: string, paths: Paths, credentialsFor: CredentialSource): Promise<SignedInSession> {
  assertAccountKey(accountKey);
  const credentials = await credentialsFor(accountKey);
  const config = await readAccountConfig(paths.accountsDir, accountKey);

  await mkdir(paths.sessionsDir, { recursive: true, mode: 0o700 });
  const profileDir = await mkdtemp(join(paths.sessionsDir, `${accountKey}-`));
  try {
    const { signedInUrl } = await signIn(profileDir, credentials, config);
    if ((await filesContaining(profileDir, credentials.password)).length) {
      throw new Refusal('PASSWORD_IN_PROFILE', 'The password was found in the browser profile, so the profile was deleted.');
    }
    return { account: accountKey, profileDir, signedInUrl };
  } catch (error) {
    await rm(profileDir, { recursive: true, force: true });
    throw error;
  }
}

// Sites put things like the username in the query string.
function withoutQuery(url: string): string {
  const { origin, pathname } = new URL(url);
  return `${origin}${pathname}`;
}

async function audit(paths: Paths, entry: Record<string, string>): Promise<void> {
  await mkdir(dirname(paths.logFile), { recursive: true, mode: 0o700 });
  await appendFile(paths.logFile, `${JSON.stringify({ time: new Date().toISOString(), ...entry })}\n`, { mode: 0o600 });
}
