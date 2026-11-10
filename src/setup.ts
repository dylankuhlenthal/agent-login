import { execFile } from 'node:child_process';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { promisify } from 'node:util';
import { checkVaultAccess } from './onepassword.ts';
import { configFilePath, loadSettings, readConfigFile, type Settings } from './settings.ts';

export type Check = { name: string; ok: boolean; detail: string };

export type SetupTools = {
  opVersion: () => Promise<string | null>;
  chromePath: () => Promise<string | null>;
  canReadVault: (tokenFile: string, vault: string) => Promise<void>;
};

type SetupOptions = {
  vault?: string;
  askVault?: () => Promise<string>;
  env?: NodeJS.ProcessEnv;
  home?: string;
  tools?: SetupTools;
};

// The installed Chrome Playwright's "chrome" channel launches, which is also what
// chrome-devtools-axi opens the returned profile with.
const CHROME_PATHS: Partial<Record<NodeJS.Platform, string>> = {
  linux: '/opt/google/chrome/chrome',
  darwin: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
};

export const realTools: SetupTools = {
  async opVersion() {
    const result = await promisify(execFile)('op', ['--version'], { timeout: 10_000 }).catch(() => null);
    return result ? result.stdout.trim() : null;
  },
  async chromePath() {
    const path = CHROME_PATHS[process.platform];
    if (!path) return null;
    return access(path).then(() => path, () => null);
  },
  canReadVault: checkVaultAccess,
};

export async function runSetup(options: SetupOptions = {}): Promise<Check[]> {
  const { env = process.env, home, tools = realTools } = options;
  const source = { env, home };
  const configFile = configFilePath(source);
  const saved = await readConfigFile(configFile);

  const newVault = options.vault || (env.AGENT_LOGIN_VAULT || saved.vault ? '' : await options.askVault?.());
  if (newVault) await saveConfig(configFile, { ...saved, vault: newVault });
  if (!newVault && !env.AGENT_LOGIN_VAULT && !saved.vault) {
    return [{ name: 'vault', ok: false, detail: 'No vault given. Run "agent-login setup --vault <name>".' }];
  }

  const settings = await loadSettings(source);
  const tokenFile = await tokenFileCheck(settings.tokenFile);
  const op = await opCheck(tools);
  const checks = [vaultCheck(settings, configFile, env), await accountsDirCheck(settings), tokenFile, op, await chromeCheck(tools)];
  if (tokenFile.ok && op.ok) checks.push(await vaultAccessCheck(settings, tools));
  return checks;
}

async function saveConfig(file: string, config: Partial<Settings>): Promise<void> {
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
}

function vaultCheck(settings: Settings, configFile: string, env: NodeJS.ProcessEnv): Check {
  const where = env.AGENT_LOGIN_VAULT ? 'from AGENT_LOGIN_VAULT, which beats the config file' : `saved in ${configFile}`;
  return { name: 'vault', ok: true, detail: `${settings.vault} (${where})` };
}

async function accountsDirCheck({ accountsDir }: Settings): Promise<Check> {
  await mkdir(accountsDir, { recursive: true, mode: 0o700 });
  return { name: 'site settings folder', ok: true, detail: accountsDir };
}

// Only the file's metadata is read here; the token itself is read once, by the
// vault check, the same way a sign-in reads it.
async function tokenFileCheck(tokenFile: string): Promise<Check> {
  const name = 'token file';
  const info = await stat(tokenFile).catch(() => null);
  if (!info?.isFile()) {
    return { name, ok: false, detail: `${tokenFile} is missing. Paste your service account token into it as the only line, then chmod 600 it.` };
  }
  if (info.size === 0) return { name, ok: false, detail: `${tokenFile} is empty.` };
  if ((info.mode & 0o077) !== 0) {
    return { name, ok: false, detail: `${tokenFile} can be read by other users. Run: chmod 600 ${tokenFile}` };
  }
  return { name, ok: true, detail: `${tokenFile} (owner-only)` };
}

async function opCheck(tools: SetupTools): Promise<Check> {
  const version = await tools.opVersion();
  return version
    ? { name: '1Password CLI', ok: true, detail: `op ${version}` }
    : { name: '1Password CLI', ok: false, detail: 'op is not on the PATH. Install the 1Password CLI.' };
}

async function chromeCheck(tools: SetupTools): Promise<Check> {
  const path = await tools.chromePath();
  return path
    ? { name: 'Google Chrome', ok: true, detail: path }
    : { name: 'Google Chrome', ok: false, detail: `Google Chrome is not installed${CHROME_PATHS[process.platform] ? ` at ${CHROME_PATHS[process.platform]}` : ' (only Linux and macOS are supported)'}.` };
}

async function vaultAccessCheck(settings: Settings, tools: SetupTools): Promise<Check> {
  try {
    await tools.canReadVault(settings.tokenFile, settings.vault);
    return { name: 'vault access', ok: true, detail: `the token can read ${settings.vault}` };
  } catch (error) {
    return { name: 'vault access', ok: false, detail: (error as Error).message };
  }
}
