/**
 * 界面预览：把 dist/renderer 作为静态站点跑起来（浏览器里走 mock 桥接，可完整体验 UI）
 * 用法：npm run build:renderer && npm run preview
 */
import { createServer } from 'node:http';
import { existsSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dir = path.join(root, 'dist', 'renderer');
const PORT = Number(process.env.PORT || 4173);

if (!existsSync(dir)) {
  console.error('未找到 dist/renderer，请先执行 npm run build:renderer');
  process.exit(1);
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.map': 'application/json',
};

createServer((req, res) => {
  const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
  let file = path.join(dir, urlPath);
  if (urlPath === '/' || !existsSync(file) || statSync(file).isDirectory()) {
    file = path.join(dir, 'index.html');
  }
  try {
    const body = readFileSync(file);
    res.writeHead(200, {
      'content-type': MIME[path.extname(file)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    res.end(body);
  } catch (err) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('Not found');
  }
}).listen(PORT, '127.0.0.1', () => {
  console.log(`Run worker 界面预览：http://127.0.0.1:${PORT}`);
});
