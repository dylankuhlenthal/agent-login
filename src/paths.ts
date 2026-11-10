import { homedir } from 'node:os';
import { join } from 'node:path';

export type Paths = {
  tokenFile: string;
  accountsDir: string;
  sessionsDir: string;
  logFile: string;
};

export function defaultPaths(home = homedir()): Paths {
  const configDir = join(home, '.config', 'agent-login');
  return {
    tokenFile: join(configDir, 'op-token'),
    accountsDir: join(configDir, 'accounts'),
    sessionsDir: join(home, '.cache', 'agent-login', 'sessions'),
    logFile: join(home, '.local', 'state', 'agent-login', 'log.jsonl'),
  };
}
