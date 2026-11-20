/* Minimális statikus szerver teszteléshez: node tools/serve.mjs [port] */
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.argv[2] || 8080);

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/* /app → /app/index.html, / → /index.html (mint az éles statikus hoszting) */
function candidates(path) {
  if (path.endsWith('/')) return [path + 'index.html'];
  return [path, path + '/index.html'];
}

createServer(async (req, res) => {
  try {
    const path = decodeURIComponent(new URL(req.url, 'http://x').pathname);
    const safe = normalize(path).replace(/^(\.\.[/\\])+/, '');
    let body = null;
    for (const candidate of candidates(safe)) {
      try {
        body = await readFile(join(ROOT, candidate));
        var ext = extname(candidate).toLowerCase();
        break;
      } catch { /* próbáljuk a következőt */ }
    }
    if (body === null) throw new Error('not found');
    res.writeHead(200, {
      'Content-Type': TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store'
    });
    res.end(body);
  } catch {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404');
  }
}).listen(PORT, () => console.log(`http://localhost:${PORT}`));
