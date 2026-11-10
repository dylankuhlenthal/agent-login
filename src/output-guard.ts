const REDACTED = '[redacted]';
const secrets = new Set<string>();
let installed = false;

export function registerSecret(secret: string): void {
  if (secret) secrets.add(secret);
}

export function redact(text: string): string {
  let result = text;
  for (const secret of secrets) result = result.split(secret).join(REDACTED);
  return result;
}

// Every byte this process writes to stdout or stderr, including Playwright's own
// logging, passes through redact(). Node prints uncaught errors natively, around
// process.stderr, so those are caught here and printed through it instead.
export function guardProcessOutput(): void {
  if (installed) return;
  installed = true;
  const printAndExit = (error: unknown) => {
    process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
    process.exit(1);
  };
  process.on('uncaughtException', printAndExit);
  process.on('unhandledRejection', printAndExit);
  for (const stream of [process.stdout, process.stderr]) {
    const write = stream.write.bind(stream) as (chunk: unknown, ...rest: unknown[]) => boolean;
    stream.write = ((chunk: unknown, ...rest: unknown[]) => {
      const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString('utf8');
      return write(redact(text), ...rest);
    }) as typeof stream.write;
  }
}
