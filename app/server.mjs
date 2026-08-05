// The issuer's back office, and a static file server.
//
// Two of the issuer's actions cannot happen in a browser: editing the identity
// register and moving the rail's association sets both need the issuer's admin
// key and the Stellar CLI. They run here instead, which is an honest depiction —
// in a real deployment this is the securitiser's internal service, and the
// README says so rather than pretending the page does everything.
//
// Everything else — paying coupons, decrypting notes, proving and verifying
// disclosures — happens in the page, against the live testnet.
//
// usage: node app/server.mjs   → http://localhost:8080

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { dirname, resolve, extname, normalize } from 'node:path';

const run = promisify(execFile);
const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const PORT = Number(process.env.PORT ?? 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.wasm': 'application/wasm',
  '.svg': 'image/svg+xml',
  '.r1cs': 'application/octet-stream',
  '.bin': 'application/octet-stream',
};

function json(res, code, body) {
  const payload = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' });
  res.end(payload);
}

async function readBody(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
}

const env = {
  ...process.env,
  SPP_REPO: process.env.SPP_REPO ?? '',
  OZ_REPO: process.env.OZ_REPO ?? '',
};

async function handleCredential(req, res) {
  const { holder, action } = await readBody(req);
  if (!/^inv[1-9]$/.test(holder ?? '') || !['grant', 'revoke'].includes(action)) {
    return json(res, 400, { error: 'expected {holder: "invN", action: "grant"|"revoke"}' });
  }
  try {
    const { stdout } = await run(resolve(ROOT, 'scripts/credential.sh'), [holder, action], { env });
    return json(res, 200, JSON.parse(stdout.trim().split('\n').pop()));
  } catch (error) {
    return json(res, 500, { error: (error.stderr || error.message).trim() });
  }
}

/**
 * The real state of both systems, read from the chain.
 *
 * The bridge's `status` already asks the register and the association sets
 * separately, which is exactly the distinction the issuer view has to show —
 * inferring it from local files would hide a divergence instead of exposing it.
 */
async function handleStatus(_req, res) {
  if (!env.SPP_REPO) return json(res, 500, { error: 'SPP_REPO is not set' });
  try {
    const { stdout } = await run(resolve(ROOT, 'scripts/policy-bridge.sh'), ['status'], { env });
    const holders = {};
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(inv[1-9])\s+(yes|no)\s+(true|false)\s+(yes|no)$/);
      if (m) holders[m[1]] = {
        credentialValid: m[2] === 'yes',
        allowlisted: m[3] === 'true',
        railBlocked: m[4] === 'yes',
      };
    }
    return json(res, 200, { holders });
  } catch (error) {
    return json(res, 500, { error: (error.stderr || error.message).trim() });
  }
}

async function handleSync(_req, res) {
  if (!env.SPP_REPO) return json(res, 500, { error: 'SPP_REPO is not set' });
  try {
    const { stdout } = await run(resolve(ROOT, 'scripts/policy-bridge.sh'), ['sync'], { env });
    // Report only the per-holder decisions; the surrounding chatter is for a terminal.
    const changes = stdout.split('\n')
      .map((l) => l.trim())
      .filter((l) => /^inv[1-9]:/.test(l));
    return json(res, 200, { changes });
  } catch (error) {
    return json(res, 500, { error: (error.stderr || error.message).trim() });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, 'http://localhost');
  let path = decodeURIComponent(url.pathname);

  // Redirect rather than serve: the page's own links are relative to /app/, so
  // serving it at / leaves the stylesheet and modules resolving one level too high.
  if (path === '/') {
    res.writeHead(302, { location: '/app/index.html' }).end();
    return;
  }

  // Contain traversal: everything must resolve inside the repo.
  const file = resolve(ROOT, '.' + normalize(path));
  if (!file.startsWith(ROOT)) {
    res.writeHead(403).end('forbidden');
    return;
  }

  try {
    const body = await readFile(file);
    res.writeHead(200, {
      'content-type': TYPES[extname(file)] ?? 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch {
    res.writeHead(404).end('not found');
  }
}

createServer(async (req, res) => {
  try {
    if (req.method === 'POST' && req.url === '/api/credential') return await handleCredential(req, res);
    if (req.method === 'POST' && req.url === '/api/sync') return await handleSync(req, res);
    if (req.method === 'GET' && req.url === '/api/status') return await handleStatus(req, res);
    return await serveStatic(req, res);
  } catch (error) {
    json(res, 500, { error: String(error?.message ?? error) });
  }
}).listen(PORT, () => {
  console.log(`Sigilo demo → http://localhost:${PORT}/app/index.html`);
  if (!env.SPP_REPO) console.log('  (SPP_REPO unset — policy sync will refuse)');
});
