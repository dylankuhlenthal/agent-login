import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

function encodings(secret: string): Buffer[] {
  return [
    Buffer.from(secret, 'utf8'),
    Buffer.from(secret, 'utf16le'),
    Buffer.from(encodeURIComponent(secret), 'utf8'),
    Buffer.from(Buffer.from(secret, 'utf8').toString('base64'), 'utf8'),
  ];
}

export async function filesContaining(dir: string, secret: string): Promise<string[]> {
  const needles = encodings(secret);
  const hits: string[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const content = await readFile(path).catch(() => null);
    if (content && needles.some((needle) => content.includes(needle))) hits.push(path);
  }
  return hits;
}
