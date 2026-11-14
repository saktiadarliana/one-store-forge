// server.ts — HTTP plumbing and routing: one Node http server, in-memory
// store, every route dispatched by path. Bodies are read whole (packs are
// small; the largest the suite sends is a few hundred KiB). Every response
// carries X-GitHub-Request-Id; REST replies are JSON; git replies use the
// smart-HTTP content types.

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './gitproto.ts';
import { handleRest, type RestRequest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';

const MAX_BODY_BYTES = 512 * 1024 * 1024;

export interface ForgeServer {
  store: Store;
  listen(port: number): Promise<number>;
  close(): Promise<void>;
}

let requestCounter = 0;

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function send(res: ServerResponse, status: number, headers: Record<string, string>, body: Buffer | string): void {
  const data = typeof body === 'string' ? Buffer.from(body, 'utf8') : body;
  requestCounter += 1;
  const out: Record<string, string> = {
    'x-github-request-id': `req-${requestCounter}`,
    'content-length': String(data.length),
    ...headers,
  };
  res.writeHead(status, out);
  res.end(data);
}

function authed(req: IncomingMessage): boolean {
  const auth = req.headers.authorization ?? '';
  return auth.startsWith('Bearer ') && auth.slice(7).trim() !== '';
}

export function createForgeServer(): ForgeServer {
  const store = new Store();
  let server: ReturnType<typeof createServer> | null = null;

  const handler = (req: IncomingMessage, res: ServerResponse): void => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', `http://${req.headers.host ?? '127.0.0.1'}`);
        const method = (req.method ?? 'GET').toUpperCase();
        const segments = url.pathname.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
        const query = url.searchParams;
        const host = req.headers.host ?? '127.0.0.1';

        // Health probe: no auth, always 200 (HEAD answers the headers only).
        if ((method === 'GET' || method === 'HEAD') && url.pathname === '/healthz') {
          if (method === 'HEAD') {
            res.writeHead(200, { 'content-type': 'application/json', 'content-length': '15' });
            res.end();
            return;
          }
          send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({ status: 'ok' }));
          return;
        }

        const body = method === 'GET' || method === 'HEAD' || method === 'DELETE' ? Buffer.alloc(0) : await readBody(req);

        // Git smart HTTP: /{owner}/{repo}.git/info/refs and the two services.
        if (segments.length >= 2 && (segments[1] as string).endsWith('.git')) {
          const owner = segments[0] as string;
          const repoName = (segments[1] as string).slice(0, -'.git'.length);
          const gitProtocol = req.headers['git-protocol'] ?? null;
          if (segments.length === 4 && segments[2] === 'info' && segments[3] === 'refs' && method === 'GET') {
            const service = query.get('service') ?? '';
            const answer = handleInfoRefs(store, owner, repoName, service, gitProtocol);
            send(res, answer.status, { 'content-type': answer.contentType }, answer.body);
            return;
          }
          if (segments.length === 3 && segments[2] === 'git-upload-pack' && method === 'POST') {
            const answer = handleUploadPack(store, owner, repoName, body, gitProtocol);
            send(res, answer.status, { 'content-type': answer.contentType }, answer.body);
            return;
          }
          if (segments.length === 3 && segments[2] === 'git-receive-pack' && method === 'POST') {
            const answer = handleReceivePack(store, owner, repoName, body);
            send(res, answer.status, { 'content-type': answer.contentType }, answer.body);
            return;
          }
          send(res, 404, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Not Found' }));
          return;
        }

        // GraphQL v4.
        if (url.pathname === '/api/graphql' && method === 'POST') {
          const answer = handleGraphql(store, body.toString('utf8'), authed(req));
          send(res, answer.status, { 'content-type': 'application/json' }, answer.body);
          return;
        }

        // MCP over Streamable HTTP.
        if (url.pathname === '/mcp') {
          if (method === 'DELETE') {
            send(res, 200, { 'content-type': 'application/json' }, JSON.stringify({}));
            return;
          }
          if (method === 'POST') {
            const answer = handleMcp(store, body, authed(req));
            send(res, answer.status, { 'content-type': 'application/json' }, answer.body);
            return;
          }
          send(res, 405, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Method Not Allowed' }));
          return;
        }

        // REST v3.
        if (segments.length >= 2 && segments[0] === 'api' && segments[1] === 'v3') {
          const restReq: RestRequest = {
            method,
            segments: segments.slice(2),
            query,
            headers: Object.fromEntries(
              Object.entries(req.headers).map(([key, value]) => [key.toLowerCase(), Array.isArray(value) ? value.join(', ') : (value ?? '')]),
            ),
            body,
            host,
          };
          const answer = handleRest(store, restReq);
          send(res, answer.status, { 'content-type': 'application/json', ...answer.headers }, answer.body);
          return;
        }

        send(res, 404, { 'content-type': 'application/json' }, JSON.stringify({ message: 'Not Found' }));
      } catch (error) {
        if (!res.headersSent) {
          send(res, 500, { 'content-type': 'application/json' }, JSON.stringify({ message: error instanceof Error ? error.message : String(error) }));
        } else {
          res.destroy();
        }
      }
    })();
  };

  return {
    store,
    listen(port: number): Promise<number> {
      return new Promise((resolve, reject) => {
        server = createServer(handler);
        server.on('error', reject);
        server.listen(port, '127.0.0.1', () => {
          const address = server?.address();
          if (address !== null && typeof address === 'object') resolve(address.port);
          else reject(new Error('could not bind'));
        });
      });
    },
    close(): Promise<void> {
      return new Promise((resolve) => {
        if (server === null) resolve();
        else server.close(() => resolve());
      });
    },
  };
}
