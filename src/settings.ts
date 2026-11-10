import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { defaultPaths, type Paths } from './paths.ts';
import { Refusal } from './refusal.ts';

export type Settings = Paths & { vault: string };

type Source = { env?: NodeJS.ProcessEnv; home?: string };

const SETTING_ENV = {
  vault: 'AGENT_LOGIN_VAULT',
  tokenFile: 'AGENT_LOGIN_TOKEN_FILE',
  accountsDir: 'AGENT_LOGIN_ACCOUNTS_DIR',
  sessionsDir: 'AGENT_LOGIN_SESSIONS_DIR',
  logFile: 'AGENT_LOGIN_LOG_FILE',
} as const satisfies Record<keyof Settings, string>;

const PATH_KEYS = ['tokenFile', 'accountsDir', 'sessionsDir', 'logFile'] as const;

export const SETTING_NAMES = Object.keys(SETTING_ENV) as (keyof Settings)[];

export function configFilePath({ env = process.env, home = homedir() }: Source = {}): string {
  return env.AGENT_LOGIN_CONFIG || join(home, '.config', 'agent-login', 'config.json');
}

// Each setting comes from its environment variable if set, else the config file,
// else the default. The vault has no default: guessing one could read the wrong vault.
export async function loadSettings(source: Source = {}): Promise<Settings> {
  const { env = process.env, home = homedir() } = source;
  const fromFile = await readConfigFile(configFilePath(source));
  const defaults = defaultPaths(home);
  const pick = (key: keyof Settings) => env[SETTING_ENV[key]] || fromFile[key];

  const vault = pick('vault');
  if (!vault) {
    throw new Refusal(
      'NO_VAULT',
      `No 1Password vault is set. Run "agent-login setup --vault <name>", or set ${SETTING_ENV.vault}.`,
    );
  }
  const paths = {} as Paths;
  for (const key of PATH_KEYS) {
    const value = pick(key);
    paths[key] = value ? absolutePath(value, key, home) : defaults[key];
  }
  return { vault, ...paths };
}

export async function readConfigFile(file: string): Promise<Partial<Settings>> {
  const raw = await readFile(file, 'utf8').catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return null;
    throw new Refusal('BAD_CONFIG', `${file} cannot be read: ${error.code}.`);
  });
  if (raw === null) return {};
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Refusal('BAD_CONFIG', `${file} is not valid JSON.`);
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Refusal('BAD_CONFIG', `${file} must hold a JSON object.`);
  }
  const settings: Partial<Settings> = {};
  for (const [key, setting] of Object.entries(value)) {
    if (!SETTING_NAMES.includes(key as keyof Settings)) {
      throw new Refusal('BAD_CONFIG', `${file}: unknown setting "${key}". Known settings: ${SETTING_NAMES.join(', ')}.`);
    }
    if (typeof setting !== 'string' || !setting) {
      throw new Refusal('BAD_CONFIG', `${file}: "${key}" must be a non-empty string.`);
    }
    settings[key as keyof Settings] = setting;
  }
  return settings;
}

function absolutePath(value: string, key: string, home: string): string {
  const expanded = value === '~' || value.startsWith('~/') ? join(home, value.slice(1)) : value;
  if (!isAbsolute(expanded)) {
    throw new Refusal('BAD_CONFIG', `${key} must be an absolute path or start with ~/ (got ${JSON.stringify(value)}).`);
  }
  return expanded;
}
