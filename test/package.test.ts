import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, test } from 'node:test';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

let work: string;
let installed: string;

// Installed the way npm installs a dependency: the packed package under a node_modules folder,
// where Node will not strip types, with its own dependencies beside it.
before(async () => {
  work = await mkdtemp(join(tmpdir(), 'agent-login-package-'));
  const pack = spawnSync('npm', ['pack', '--json', '--pack-destination', work], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(pack.status, 0, pack.stderr);
  const [{ filename }] = JSON.parse(pack.stdout) as { filename: string }[];
  const modules = join(work, 'project', 'node_modules');
  installed = join(modules, 'agent-login');
  await mkdir(installed, { recursive: true });
  const untar = spawnSync('tar', ['-xzf', join(work, filename), '-C', installed, '--strip-components=1']);
  assert.equal(untar.status, 0, String(untar.stderr));
  for (const dependency of ['playwright', 'playwright-core', 'tldts', 'tldts-core']) {
    await symlink(join(ROOT, 'node_modules', dependency), join(modules, dependency));
  }
});

after(async () => {
  await rm(work, { recursive: true, force: true });
});

test('the package holds the build, the launcher and the skill, and no TypeScript source', () => {
  assert.ok(existsSync(join(installed, 'dist', 'cli.js')));
  assert.ok(existsSync(join(installed, 'bin', 'agent-login')));
  assert.ok(existsSync(join(installed, 'skills', 'agent-login', 'SKILL.md')));
  assert.ok(!existsSync(join(installed, 'src')));
  assert.ok(!existsSync(join(installed, 'test')));
});

test('the installed launcher runs the build', async () => {
  const home = join(work, 'home');
  await mkdir(home, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: home };
  const help = spawnSync(join(installed, 'bin', 'agent-login'), ['--help'], { env, encoding: 'utf8' });
  assert.equal(help.status, 0, help.stderr);
  assert.match(help.stdout, /^usage:/);
  const signIn = spawnSync(join(installed, 'bin', 'agent-login'), ['abcdefghijklmnopqrstuvwxyz'], { env, encoding: 'utf8' });
  assert.equal(signIn.status, 2);
  assert.equal(JSON.parse(signIn.stderr).code, 'NO_VAULT');
});
