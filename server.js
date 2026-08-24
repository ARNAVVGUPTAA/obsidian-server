const fs = require('fs');
const http = require('http');
const path = require('path');
const dotenv = require('dotenv');
const { v2: webdav } = require('webdav-server');

dotenv.config();

const PORT = Number(process.env.PORT || 8080);
const USERNAME = process.env.WEBDAV_USERNAME || 'obsidian';
const PASSWORD = process.env.WEBDAV_PASSWORD || '';
const DATA_DIR = process.env.DATA_DIR || '/data';

// Obsidian's own origins. The desktop app uses app://obsidian.md, iOS uses
// capacitor://localhost, Android uses http://localhost. Remotely Save runs
// inside those and needs CORS to talk to a third-party WebDAV host.
const DEFAULT_ORIGINS = ['app://obsidian.md', 'capacitor://localhost', 'http://localhost'];
const EXTRA_ORIGINS = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean);
const ALLOWED_ORIGINS = new Set([...DEFAULT_ORIGINS, ...EXTRA_ORIGINS]);

const CORS_METHODS = 'GET,HEAD,POST,PUT,DELETE,OPTIONS,PROPFIND,PROPPATCH,MKCOL,COPY,MOVE,LOCK,UNLOCK';
const CORS_HEADERS = 'Authorization,Content-Type,Content-Length,Depth,Destination,Overwrite,If,If-Match,If-None-Match,Lock-Token,Timeout,X-Requested-With';
const CORS_EXPOSE = 'DAV,Content-Length,Allow,ETag,Last-Modified';

// This is intended to sit on the public internet behind a Cloudflare tunnel,
// so refuse to start with a guessable password rather than warn about it.
if (!PASSWORD || PASSWORD === 'change-me' || PASSWORD === 'obsidian') {
  console.error('FATAL: set WEBDAV_PASSWORD to a strong, non-default value before starting.');
  process.exit(1);
}

const absoluteDataDir = path.resolve(DATA_DIR);
fs.mkdirSync(absoluteDataDir, { recursive: true });

const userManager = new webdav.SimpleUserManager();
const privilegeManager = new webdav.SimplePathPrivilegeManager();
const user = userManager.addUser(USERNAME, PASSWORD, false);

privilegeManager.setRights(user, '/', ['all']);

const webdavServer = new webdav.WebDAVServer({
  httpAuthentication: new webdav.HTTPBasicAuthentication(userManager, 'Obsidian Vault'),
  privilegeManager
});

function applyCors(req, res) {
  const origin = req.headers.origin;
  if (!origin) {
    return;
  }

  res.setHeader('Vary', 'Origin');
  if (!ALLOWED_ORIGINS.has(origin)) {
    return;
  }

  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Methods', CORS_METHODS);
  res.setHeader('Access-Control-Allow-Headers', CORS_HEADERS);
  res.setHeader('Access-Control-Expose-Headers', CORS_EXPOSE);
  res.setHeader('Access-Control-Max-Age', '86400');
}

webdavServer.setFileSystem('/', new webdav.PhysicalFileSystem(absoluteDataDir), (error) => {
  if (error) {
    console.error('Failed to mount data directory:', error);
    process.exit(1);
  }

  const server = http.createServer((req, res) => {
    applyCors(req, res);

    // Preflight: answer before auth, or the browser-side check never gets far
    // enough to send the Authorization header.
    if (req.method === 'OPTIONS' && req.headers['access-control-request-method']) {
      res.writeHead(204);
      res.end();
      return;
    }

    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    const clientIp = req.headers['cf-connecting-ip'] || req.socket.remoteAddress;
    res.on('finish', () => {
      console.log(`${clientIp} ${req.method} ${req.url} -> ${res.statusCode}`);
    });

    webdavServer.executeRequest(req, res);
  });

  server.listen(PORT, '0.0.0.0', () => {
    console.log(`Obsidian WebDAV server is running on port ${PORT}`);
    console.log(`Data directory: ${absoluteDataDir}`);
    console.log(`Username: ${USERNAME}`);
  });

  const shutdown = (signal) => {
    console.log(`${signal} received, shutting down.`);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
