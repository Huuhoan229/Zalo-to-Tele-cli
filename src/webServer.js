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

function renderAccountCard(account, accessToken) {
  const qrPath = account.qrImageBase64
    ? `data:image/png;base64,${account.qrImageBase64}`
    : account.qrAvailable
      ? withToken(`/qr?account=${encodeURIComponent(account.id)}&t=${Date.now()}`, accessToken)
      : '';

  return `<section class="panel">
      <div class="account-head">
        <div>
          <h2>${escapeHtml(account.label || account.id)}</h2>
          <p>${escapeHtml(account.accountName || account.label || account.id)}</p>
        </div>
        <strong class="badge">${escapeHtml(account.status || 'unknown')}</strong>
      </div>
      <dl>
        <div><dt>Listener</dt><dd>${account.listenerConnected ? 'connected' : 'not connected'}</dd></div>
        <div><dt>Topics</dt><dd>${Number(account.conversationCount || 0)}</dd></div>
      </dl>
      ${
        qrPath
          ? `<p>Scan QR bằng Zalo mobile, rồi confirm trên điện thoại.</p><img alt="Zalo login QR for ${escapeHtml(account.label || account.id)}" src="${qrPath}">`
          : `<p>Chưa có QR mới. Nếu app đã đăng nhập bằng credentials thì không cần scan lại.</p>`
      }
      ${account.lastError ? `<pre>${escapeHtml(account.lastError)}</pre>` : ''}
    </section>`;
}

function renderPage(status, accessToken) {
  if (Array.isArray(status.accounts)) {
    const statusPath = withToken('/status', accessToken);
    const running = status.accounts.filter((account) => account.status === 'running').length;
    const total = status.accounts.length;

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="5">
  <title>Zalo-to-Tele</title>
  <style>
    :root { color-scheme: light dark; font-family: Arial, sans-serif; }
    body { margin: 0; padding: 28px; background: #f4f6f8; color: #172026; }
    main { max-width: 980px; margin: 0 auto; }
    h1 { margin: 0 0 8px; font-size: 28px; }
    h2 { margin: 0; font-size: 20px; }
    p { line-height: 1.5; margin: 8px 0; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(280px, 1fr)); gap: 16px; margin-top: 18px; }
    .panel { background: #fff; border: 1px solid #d9e0e7; border-radius: 8px; padding: 18px; }
    .account-head { display: flex; justify-content: space-between; gap: 12px; align-items: flex-start; }
    .badge { border: 1px solid #c7d2da; border-radius: 999px; padding: 4px 10px; font-size: 13px; background: #eef7f5; color: #0f766e; }
    dl { display: grid; grid-template-columns: repeat(2, 1fr); gap: 10px; margin: 16px 0; }
    dt { font-size: 12px; color: #617080; }
    dd { margin: 4px 0 0; font-weight: 700; }
    img { width: min(320px, 100%); height: auto; image-rendering: pixelated; border: 1px solid #d9e0e7; border-radius: 8px; background: #fff; }
    pre { overflow: auto; padding: 12px; background: #111827; color: #e5e7eb; border-radius: 8px; font-size: 13px; white-space: pre-wrap; }
    a { color: #0f766e; }
    @media (prefers-color-scheme: dark) {
      body { background: #111827; color: #eef2f7; }
      .panel { background: #1f2937; border-color: #374151; }
      .badge { background: #0f2f2b; border-color: #1f766e; color: #a7f3d0; }
      dt { color: #9ca3af; }
      img { border-color: #374151; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Zalo-to-Tele</h1>
    <p>Status: <strong>${escapeHtml(status.status)}</strong> - ${running}/${total} account running</p>
    <p><a href="${statusPath}">JSON status</a></p>
    <div class="grid">
      ${status.accounts.map((account) => renderAccountCard(account, accessToken)).join('')}
    </div>
  </main>
</body>
</html>`;
  }

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
      const status = { ...currentStatus };

      if (Array.isArray(currentStatus.accounts)) {
        status.accounts = await Promise.all(
          currentStatus.accounts.map(async (account) => {
            const accountQrPath = getQrPath?.(account.id, account);
            return {
              ...account,
              qrAvailable: Boolean(account.qrImageBase64) || await fileExists(accountQrPath),
              qrFilename: accountQrPath ? path.basename(accountQrPath) : null,
            };
          }),
        );
        status.qrAvailable = status.accounts.some((account) => account.qrAvailable);
      } else {
        const qrPath = getQrPath?.();
        status.qrAvailable = Boolean(currentStatus.qrImageBase64) || await fileExists(qrPath);
        status.qrFilename = qrPath ? path.basename(qrPath) : null;
      }

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
        const accountId = url.searchParams.get('account') || undefined;
        const targetStatus = accountId && Array.isArray(status.accounts)
          ? status.accounts.find((account) => account.id === accountId)
          : status;
        const qrPath = getQrPath?.(accountId);

        if (!targetStatus?.qrAvailable || !qrPath) {
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
