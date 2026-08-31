import fs from 'node:fs/promises';
import http from 'node:http';
import path from 'node:path';

function send(res, statusCode, body, headers = {}) {
  res.writeHead(statusCode, {
    'Cache-Control': 'no-store',
    ...headers,
  });
  res.end(body);
}

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

function authorized(req, url, accessToken) {
  if (!accessToken) return true;
  const bearer = req.headers.authorization?.match(/^Bearer\s+(.+)$/i)?.[1];
  return (
    url.searchParams.get('token') === accessToken ||
    req.headers['x-web-token'] === accessToken ||
    bearer === accessToken
  );
}

function withToken(pathname, accessToken) {
  if (!accessToken) return pathname;
  const separator = pathname.includes('?') ? '&' : '?';
  return `${pathname}${separator}token=${encodeURIComponent(accessToken)}`;
}

function renderPage(status, accessToken) {
  const qrPath = status.qrImageBase64
    ? `data:image/png;base64,${status.qrImageBase64}`
    : status.qrAvailable
      ? withToken(`/qr?t=${Date.now()}`, accessToken)
      : '';
  const statusPath = withToken('/status', accessToken);
  const statusJson = escapeHtml(JSON.stringify(status, null, 2));

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>Zalo-to-Tele</title>
  <style>
    :root { color-scheme: light dark; font-family: Arial, sans-serif; }
    body { margin: 0; padding: 32px; background: #f4f6f8; color: #172026; }
    main { max-width: 720px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    p { line-height: 1.5; }
    .panel { background: #fff; border: 1px solid #d9e0e7; border-radius: 8px; padding: 20px; margin-top: 18px; }
    img { width: min(360px, 100%); height: auto; image-rendering: pixelated; border: 1px solid #d9e0e7; border-radius: 8px; background: #fff; }
    pre { overflow: auto; padding: 14px; background: #111827; color: #e5e7eb; border-radius: 8px; font-size: 13px; }
    a { color: #0f766e; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #eef2f7; }
      .panel { background: #1f2937; border-color: #374151; }
      img { border-color: #374151; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Zalo-to-Tele</h1>
    <p>Status: <strong>${escapeHtml(status.status)}</strong>${status.accountName ? ` - ${escapeHtml(status.accountName)}` : ''}</p>
    <section class="panel">
      ${
        qrPath
          ? `<p>Scan QR bằng Zalo mobile, rồi confirm trên điện thoại.</p><img alt="Zalo login QR" src="${qrPath}">`
          : `<p>Chưa có QR mới. Nếu app đã đăng nhập bằng credentials thì không cần scan lại.</p>`
      }
    </section>
    <section class="panel">
      <p><a href="${statusPath}">JSON status</a></p>
      <pre>${statusJson}</pre>
    </section>
  </main>
</body>
</html>`;
}

async function fileExists(filePath) {
  if (!filePath) return false;
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch (error) {
    if (error.code === 'ENOENT') return false;
    throw error;
  }
}

export function startWebServer({ port, accessToken, getStatus, getQrPath, logger }) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/healthz') {
        send(res, 200, 'ok\n', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      if (!authorized(req, url, accessToken)) {
        send(res, 401, 'Unauthorized\n', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      const currentStatus = getStatus?.() || {};
      const qrPath = getQrPath?.();
      const status = {
        ...currentStatus,
        qrAvailable: Boolean(currentStatus.qrImageBase64) || await fileExists(qrPath),
        qrFilename: qrPath ? path.basename(qrPath) : null,
      };

      if (url.pathname === '/' || url.pathname === '/qr-login') {
        send(res, 200, renderPage(status, accessToken), { 'Content-Type': 'text/html; charset=utf-8' });
        return;
      }

      if (url.pathname === '/status') {
        send(res, 200, `${JSON.stringify(status, null, 2)}\n`, {
          'Content-Type': 'application/json; charset=utf-8',
        });
        return;
      }

      if (url.pathname === '/qr') {
        if (!status.qrAvailable) {
          send(res, 404, 'QR not available yet\n', { 'Content-Type': 'text/plain; charset=utf-8' });
          return;
        }

        const image = await fs.readFile(qrPath);
        send(res, 200, image, { 'Content-Type': 'image/png' });
        return;
      }

      send(res, 404, 'Not found\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    } catch (error) {
      logger?.error({ error }, 'Web server request failed');
      send(res, 500, 'Internal server error\n', { 'Content-Type': 'text/plain; charset=utf-8' });
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger?.info({ port }, 'Web QR server listening.');
  });

  return server;
}
