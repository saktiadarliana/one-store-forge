// main.ts — one-store-forge: a GitHub-compatible git forge in one process.
//
// Serves git smart HTTP (upload-pack v2 + v0, receive-pack), REST v3,
// GraphQL v4 and MCP from a single in-memory store. Standard library only,
// no git binary, no package manager, no outside service.
//
// Two modes:
//  - Trial mode (MAKEFUN_ENV_URL is set): bind an ephemeral port, POST
//    {"port": N} to $MAKEFUN_ENV_URL/register, then poll /done until the
//    suite finishes and exit 0.
//  - Dev mode: listen on FORGE_PORT (default 8734) until killed.

import { createForgeServer } from './src/server.ts';

const DEV_PORT = Number.parseInt(process.env.FORGE_PORT ?? '8734', 10) || 8734;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function register(envUrl: string, port: number): Promise<void> {
  const url = `${envUrl.replace(/\/+$/, '')}/register`;
  const deadline = Date.now() + 15_000;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(3_000),
      });
      if (response.ok) {
        process.stderr.write(`one-store-forge: registered port ${port} at ${url}\n`);
        return;
      }
      lastError = `HTTP ${response.status}`;
      if (response.status === 409) throw new Error('register: another entry already registered');
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (lastError.includes('already registered')) throw error;
    }
    await sleep(500);
  }
  throw new Error(`register failed: ${lastError}`);
}

async function waitDone(envUrl: string): Promise<void> {
  const url = `${envUrl.replace(/\/+$/, '')}/done`;
  let interval = 250;
  for (;;) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(30_000) });
      const body = (await response.json()) as { done?: boolean };
      if (body.done === true) return;
    } catch {
      // A transient env hiccup must not kill the trial; keep polling.
    }
    await sleep(interval);
    interval = Math.min(2_000, interval * 2);
  }
}

async function main(): Promise<void> {
  const envUrl = process.env.MAKEFUN_ENV_URL ?? '';
  const server = createForgeServer();
  const shutdown = async (code: number): Promise<void> => {
    await server.close();
    process.exit(code);
  };
  process.on('SIGTERM', () => void shutdown(0));
  process.on('SIGINT', () => void shutdown(0));

  if (envUrl !== '') {
    const port = await server.listen(0);
    await register(envUrl, port);
    await waitDone(envUrl);
    process.stderr.write('one-store-forge: trial done, exiting\n');
    await server.close();
    process.exit(0);
  }

  const port = await server.listen(DEV_PORT);
  process.stdout.write(`one-store-forge listening on http://127.0.0.1:${port}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(`fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
