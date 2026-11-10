import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium, type BrowserContext, type ElementHandle, type Page } from 'playwright';
import type { AccountConfig } from './account-config.ts';
import type { Credentials } from './onepassword.ts';
import { Refusal } from './refusal.ts';
import { isItemWebsite, isSameSiteAsItemWebsite } from './sites.ts';

const PAGE_TIMEOUT_MS = 30_000;
const FIELD_TIMEOUT_MS = 15_000;
const SIGN_IN_TIMEOUT_MS = 20_000;
const POLL_MS = 250;
const SETTLE_MS = 1_500;
export const SESSION_COOKIE_HOURS = 8;

export type SignInResult = { signedInUrl: string };

export async function signIn(profileDir: string, credentials: Credentials, config: AccountConfig): Promise<SignInResult> {
  const loginUrl = config.loginUrl ?? credentials.primaryUrl;
  assertAllowed(loginUrl, credentials.allowedOrigins);

  await disablePasswordSaving(profileDir);
  // The installed Chrome, not Playwright's bundled Chromium: an agent opens the
  // returned profile with chrome-devtools-axi, which launches the installed Chrome,
  // and Ubuntu's AppArmor blocks the bundled Chromium's sandbox.
  const context = await chromium.launchPersistentContext(profileDir, { channel: 'chrome', headless: true });
  try {
    const page = context.pages()[0] ?? (await context.newPage());
    page.setDefaultTimeout(PAGE_TIMEOUT_MS);
    await page.goto(loginUrl, { waitUntil: 'domcontentloaded' });
    assertAllowed(page.url(), credentials.allowedOrigins);

    const passwordField = await findPasswordField(page, config.passwordSelector);
    const usernameField = await findField(page, config.usernameSelector, 'username');
    await usernameField.fill(credentials.username);

    assertAllowed(page.url(), credentials.allowedOrigins);
    await assertPasswordField(passwordField, config.passwordSelector);
    await passwordField.fill(credentials.password);

    const submit = await findField(page, config.submitSelector, 'submit');
    await submit.click();
    const signedInUrl = await waitForSignedIn(page, config, credentials.allowedOrigins);
    await keepSessionCookies(context);
    return { signedInUrl };
  } finally {
    await context.close();
  }
}

function assertAllowed(url: string, allowedOrigins: string[]): void {
  if (!isItemWebsite(url, allowedOrigins)) {
    throw new Refusal('SITE_NOT_ALLOWED', `${new URL(url).origin} is not one of this account's websites (${allowedOrigins.join(', ')}).`);
  }
}

async function disablePasswordSaving(profileDir: string): Promise<void> {
  const preferences = {
    credentials_enable_service: false,
    profile: { password_manager_enabled: false },
    autofill: { profile_enabled: false, credit_card_enabled: false },
  };
  await mkdir(join(profileDir, 'Default'), { recursive: true });
  await writeFile(join(profileDir, 'Default', 'Preferences'), JSON.stringify(preferences));
}

async function findField(page: Page, selector: string, role: string): Promise<ElementHandle> {
  const field = await page.waitForSelector(selector, { state: 'visible', timeout: FIELD_TIMEOUT_MS }).catch(() => null);
  if (!field) throw new Refusal('FIELD_NOT_FOUND', `No visible ${role} field matches ${JSON.stringify(selector)}.`);
  return field;
}

async function findPasswordField(page: Page, selector: string): Promise<ElementHandle> {
  const field = await findField(page, selector, 'password');
  await assertPasswordField(field, selector);
  return field;
}

async function assertPasswordField(field: ElementHandle, selector: string): Promise<void> {
  const isPasswordInput = await field
    .evaluate((element) => element instanceof HTMLInputElement && element.type === 'password')
    .catch(() => false);
  if (!isPasswordInput) {
    throw new Refusal('NOT_A_PASSWORD_FIELD', `${JSON.stringify(selector)} is not an <input type="password"> on this page.`);
  }
}

// A page that is still loading has no visible password field either, so "signed
// in" has to hold for a while after the page has loaded before it counts.
async function waitForSignedIn(page: Page, config: AccountConfig, allowedOrigins: string[]): Promise<string> {
  const deadline = Date.now() + SIGN_IN_TIMEOUT_MS;
  let signedInSince: number | null = null;
  while (Date.now() < deadline) {
    await page.waitForTimeout(POLL_MS);
    assertStillOnAllowedSite(page.url(), allowedOrigins);
    await page.waitForLoadState('load').catch(() => {});
    if (!(await looksSignedIn(page, config))) {
      signedInSince = null;
    } else if (signedInSince === null) {
      signedInSince = Date.now();
    } else if (Date.now() - signedInSince >= SETTLE_MS) {
      return page.url();
    }
  }
  throw new Refusal('SIGN_IN_FAILED', 'The site did not sign in (the login form is still showing). Not retrying, so the account does not get locked.');
}

function assertStillOnAllowedSite(url: string, allowedOrigins: string[]): void {
  if (!isSameSiteAsItemWebsite(url, allowedOrigins)) {
    throw new Refusal('SIGN_IN_FAILED', `After submitting, the site sent the browser to ${url}, which is not on the same site as any of this account's websites, so this is not counted as signed in. Not retrying.`);
  }
}

async function looksSignedIn(page: Page, config: AccountConfig): Promise<boolean> {
  try {
    if (config.signedInSelector) return await page.locator(config.signedInSelector).first().isVisible();
    return !(await page.locator(config.passwordSelector).first().isVisible());
  } catch {
    return false;
  }
}

// Chrome drops cookies without an expiry when it closes, and many sites keep the
// signed-in session in one. Giving them an expiry makes them survive into the
// profile the agent opens.
async function keepSessionCookies(context: BrowserContext): Promise<void> {
  const expires = Math.floor(Date.now() / 1000) + SESSION_COOKIE_HOURS * 3600;
  const sessionCookies = (await context.cookies()).filter((cookie) => cookie.expires === -1);
  if (sessionCookies.length) await context.addCookies(sessionCookies.map((cookie) => ({ ...cookie, expires })));
}
