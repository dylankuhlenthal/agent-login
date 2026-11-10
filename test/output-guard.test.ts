import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { filesContaining } from '../src/profile-scan.ts';

const GUARD = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'output-guard.ts');
const SECRET = 'hunter2-secret-value';

function runGuarded(body: string) {
  const script = `
    import { guardProcessOutput, registerSecret } from ${JSON.stringify(GUARD)};
    guardProcessOutput();
    registerSecret(${JSON.stringify(SECRET)});
    ${body}
  `;
  return spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
}

test('a registered secret is redacted from stdout and stderr', () => {
  const result = runGuarded(`
    console.log('out ${SECRET}');
    console.error('err ${SECRET}');
    process.stdout.write(Buffer.from('buffer ${SECRET}\\n'));
  `);

  assert.equal(result.stdout, 'out [redacted]\nbuffer [redacted]\n');
  assert.equal(result.stderr, 'err [redacted]\n');
});

test('a registered secret is redacted from uncaught errors and rejections', () => {
  const thrown = runGuarded(`throw new Error('boom ${SECRET}');`);
  const rejected = runGuarded(`Promise.reject(new Error('boom ${SECRET}'));`);

  for (const result of [thrown, rejected]) {
    assert.equal(result.status, 1);
    assert.match(result.stderr, /boom \[redacted\]/);
    assert.ok(!result.stderr.includes(SECRET));
  }
});

test('the profile scan finds a secret stored as UTF-8, UTF-16, URL-encoded or base64', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'agent-login-scan-'));
  const secret = 'p@ss word&1';
  await writeFile(join(dir, 'utf8'), `x${secret}x`);
  await writeFile(join(dir, 'utf16'), Buffer.from(`x${secret}x`, 'utf16le'));
  await writeFile(join(dir, 'urlencoded'), `x=${encodeURIComponent(secret)}`);
  await writeFile(join(dir, 'base64'), Buffer.from(secret).toString('base64'));
  await writeFile(join(dir, 'clean'), 'nothing here');

  const hits = (await filesContaining(dir, secret)).map((path) => path.slice(dir.length + 1)).sort();

  assert.deepEqual(hits, ['base64', 'urlencoded', 'utf16', 'utf8']);
});
