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
      <div class="toolbar">
        <button type="button" data-action="relogin" data-account-id="${escapeHtml(account.id)}">Quét QR lại</button>
        <button type="button" data-action="remove" data-account-id="${escapeHtml(account.id)}">Xóa tài khoản</button>
      </div>
    </section>`;
}

function renderPage(status, accessToken) {
  if (Array.isArray(status.accounts)) {
    const statusPath = withToken('/status', accessToken);
    const running = status.accounts.filter((account) => account.status === 'running').length;
    const total = status.accounts.length;
    const telegram = status.telegram || {};
    const telegramSummary = [
      `Bot: ${telegram.botUsername ? '@' + telegram.botUsername : 'đang xác định'} · phiên bản ${telegram.version || 'chưa rõ'}`,
      `Nhận lệnh: ${telegram.mode || 'chưa rõ'} / ${telegram.status || 'đang khởi động'}`,
      `Lệnh gần nhất tới server: ${telegram.lastUpdateAt || 'chưa nhận được lệnh nào'}`,
      ...(telegram.webhook ? [
        `Webhook: ${telegram.webhook.matchesExpectedUrl ? 'đúng địa chỉ' : 'chưa đúng hoặc chưa đăng ký'} · tin chờ: ${telegram.webhook.pendingUpdateCount || 0}`,
        ...(telegram.webhook.lastDeliveryError ? [`Lỗi giao tin gần nhất: ${telegram.webhook.lastDeliveryError}`] : []),
        ...(telegram.webhook.checkError ? [`Lỗi kiểm tra webhook: ${telegram.webhook.checkError}`] : []),
      ] : []),
    ].join('\n');

    return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
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
    .toolbar { display: flex; gap: 10px; align-items: center; flex-wrap: wrap; margin: 16px 0; }
    input, button { font: inherit; border: 1px solid #c7d2da; border-radius: 8px; padding: 10px 12px; }
    button { cursor: pointer; background: #0f766e; border-color: #0f766e; color: #fff; }
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
    <p id="summary">Status: <strong>${escapeHtml(status.status)}</strong> - ${running}/${total} account running</p>
    <section class="panel" style="margin-top:16px">
      <h2>Bot Telegram</h2>
      <p id="telegram-state" style="white-space:pre-line">${escapeHtml(telegramSummary)}</p>
    </section>
    <form id="add-account-form" class="toolbar">
      <input name="label" type="text" maxlength="80" placeholder="Tên tài khoản, ví dụ Zalo 2">
      <button type="submit">+ Thêm tài khoản Zalo</button>
      <span id="action-error" role="status"></span>
    </form>
    <p><a href="${statusPath}">JSON status</a></p>
    <div class="grid">
      ${status.accounts.map((account) => renderAccountCard(account, accessToken)).join('')}
    </div>
  </main>
  <script>
    const statusUrl = ${JSON.stringify(statusPath)};
    const apiRoot = '/api/accounts';
    const tokenValue = ${JSON.stringify(accessToken ? encodeURIComponent(accessToken) : '')};
    const tokenQuery = tokenValue ? '?token=' + tokenValue : '';
    const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[c]));
    function drawAccounts(accounts) {
      const grid = document.querySelector('.grid');
      grid.innerHTML = accounts.map((account) => {
        const image = account.qrImageBase64 ? 'data:image/png;base64,' + account.qrImageBase64 :
          account.qrAvailable ? '/qr?account=' + encodeURIComponent(account.id) + '&t=' + Date.now() + (tokenValue ? '&token=' + tokenValue : '') : '';
        return '<section class="panel"><div class="account-head"><div><h2>' + esc(account.label || account.id) +
          '</h2><p>' + esc(account.accountName || account.label || account.id) + '</p></div><strong class="badge">' +
          esc(account.status || 'unknown') + '</strong></div><dl><div><dt>Listener</dt><dd>' +
          (account.listenerConnected ? 'connected' : 'not connected') + '</dd></div><div><dt>Topics</dt><dd>' +
          Number(account.conversationCount || 0) + '</dd></div></dl>' +
          (image ? '<p>Quét QR bằng Zalo mobile rồi xác nhận trên điện thoại.</p><img alt="Zalo login QR" src="' + image + '">' :
            '<p>Chưa có QR mới. Nếu tài khoản đã đăng nhập thì không cần quét lại.</p>') +
          (account.lastError ? '<pre>' + esc(account.lastError) + '</pre>' : '') +
          '<div class="toolbar"><button type="button" data-action="relogin" data-account-id="' + esc(account.id) +
          '">Quét QR lại</button><button type="button" data-action="remove" data-account-id="' + esc(account.id) +
          '">Xóa tài khoản</button></div></section>';
      }).join('');
    }
    async function refreshStatus() {
      try {
        const response = await fetch(statusUrl, { cache: 'no-store' });
        if (!response.ok) return;
        const data = await response.json();
        const runningCount = data.accounts.filter((a) => a.status === 'running').length;
        document.querySelector('#summary').textContent = 'Status: ' + data.status + ' - ' + runningCount + '/' + data.accounts.length + ' account running';
        const tg = data.telegram || {};
        const lines = [
          'Bot: ' + (tg.botUsername ? '@' + tg.botUsername : 'đang xác định') + ' · phiên bản ' + (tg.version || 'chưa rõ'),
          'Nhận lệnh: ' + (tg.mode || 'chưa rõ') + ' / ' + (tg.status || 'đang khởi động'),
          'Lệnh gần nhất tới server: ' + (tg.lastUpdateAt || 'chưa nhận được lệnh nào')
        ];
        if (tg.webhook) {
          lines.push('Webhook: ' + (tg.webhook.matchesExpectedUrl ? 'đúng địa chỉ' : 'chưa đúng hoặc chưa đăng ký') + ' · tin chờ: ' + (tg.webhook.pendingUpdateCount || 0));
          if (tg.webhook.lastDeliveryError) lines.push('Lỗi giao tin gần nhất: ' + tg.webhook.lastDeliveryError);
          if (tg.webhook.checkError) lines.push('Lỗi kiểm tra webhook: ' + tg.webhook.checkError);
        }
        document.querySelector('#telegram-state').textContent = lines.join('\\n');
        drawAccounts(data.accounts);
      } catch {}
    }
    async function requestAccountAction(url, method, payload) {
      const response = await fetch(url, {
        method,
        headers: {'Content-Type': 'application/json'},
        body: payload ? JSON.stringify(payload) : undefined
      });
      const result = await response.json().catch(() => ({}));
      if (!response.ok) throw new Error(result.error || 'Thao tác thất bại');
      document.querySelector('#action-error').textContent = '';
      await refreshStatus();
    }
    document.querySelector('#add-account-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      const form = event.currentTarget;
      const button = form.querySelector('button');
      button.disabled = true;
      try {
        const label = new FormData(form).get('label');
        await requestAccountAction(apiRoot + tokenQuery, 'POST', {label});
        form.reset();
      } catch (error) { document.querySelector('#action-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    document.querySelector('.grid').addEventListener('click', async (event) => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const id = encodeURIComponent(button.dataset.accountId);
      const action = button.dataset.action;
      if (action === 'remove' && !confirm('Xóa tài khoản này?')) return;
      button.disabled = true;
      try {
        await requestAccountAction(
          action === 'relogin' ? apiRoot + '/' + id + '/relogin' + tokenQuery : apiRoot + '/' + id + tokenQuery,
          action === 'relogin' ? 'POST' : 'DELETE'
        );
      } catch (error) { document.querySelector('#action-error').textContent = error.message; }
      finally { button.disabled = false; }
    });
    refreshStatus();
    setInterval(refreshStatus, 2000);
  </script>
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

async function readRequestBody(req) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    if (length > 16 * 1024) throw new Error('Request body is too large');
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  if (req.headers['content-type']?.includes('application/json')) return JSON.parse(raw);
  return Object.fromEntries(new URLSearchParams(raw));
}

export function startWebServer({
  port,
  accessToken,
  getStatus,
  getQrPath,
  logger,
  webhookHandlers,
  onEvnProbe,
  onAddAccount,
  onRemoveAccount,
  onReloginAccount,
}) {
  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url || '/', 'http://localhost');

      if (url.pathname === '/healthz') {
        if (url.searchParams.get('evn') === '1' && typeof onEvnProbe === 'function') {
          const sendTg = url.searchParams.get('send') === '1';
          const result = await onEvnProbe(sendTg);
          send(res, 200, `${JSON.stringify(result)}\n`, { 'Content-Type': 'application/json; charset=utf-8' });
          return;
        }
        send(res, 200, 'ok\n', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      // Telegram webhook: route POST /telegram-webhook/<hash> vào Telegraf handler.
      // Phải để TRƯỚC auth check vì Telegram không gửi access token của chúng ta.
      if (req.method === 'POST' && url.pathname.startsWith('/telegram-webhook/')) {
        const handler = webhookHandlers?.get(url.pathname);
        if (handler) {
          await handler(req, res);
          return;
        }
        send(res, 404, 'Webhook path not registered\n', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      if (!authorized(req, url, accessToken)) {
        send(res, 401, 'Unauthorized\n', { 'Content-Type': 'text/plain; charset=utf-8' });
        return;
      }

      if (
        req.method !== 'GET' &&
        url.pathname.startsWith('/api/accounts') &&
        !accessToken
      ) {
        send(res, 503, JSON.stringify({ error: 'Set WEB_ACCESS_TOKEN to enable account management' }), {
          'Content-Type': 'application/json; charset=utf-8',
        });
        return;
      }

      if (url.pathname === '/api/accounts' && req.method === 'POST') {
        if (!onAddAccount) {
          send(res, 503, JSON.stringify({ error: 'Account management is unavailable' }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
          return;
        }
        try {
          const input = await readRequestBody(req);
          const account = await onAddAccount({ label: String(input.label || '').trim() });
          send(res, 201, JSON.stringify({ account }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        } catch (error) {
          send(res, 400, JSON.stringify({ error: error?.message || 'Could not add account' }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        }
        return;
      }

      const accountAction = url.pathname.match(/^\/api\/accounts\/([^/]+)\/(relogin)$/);
      if (accountAction && req.method === 'POST') {
        if (!onReloginAccount) {
          send(res, 503, JSON.stringify({ error: 'QR relogin is unavailable' }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
          return;
        }
        try {
          const account = await onReloginAccount(decodeURIComponent(accountAction[1]));
          send(res, 202, JSON.stringify({ account }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        } catch (error) {
          send(res, 400, JSON.stringify({ error: error?.message || 'Could not restart account' }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        }
        return;
      }

      const accountDelete = url.pathname.match(/^\/api\/accounts\/([^/]+)$/);
      if (accountDelete && req.method === 'DELETE') {
        if (!onRemoveAccount) {
          send(res, 503, JSON.stringify({ error: 'Account removal is unavailable' }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
          return;
        }
        try {
          await onRemoveAccount(decodeURIComponent(accountDelete[1]));
          send(res, 200, JSON.stringify({ ok: true }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        } catch (error) {
          send(res, 400, JSON.stringify({ error: error?.message || 'Could not remove account' }), {
            'Content-Type': 'application/json; charset=utf-8',
          });
        }
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
      if (!res.writableEnded) {
        if (res.headersSent) res.end();
        else send(res, 500, 'Internal server error\n', { 'Content-Type': 'text/plain; charset=utf-8' });
      }
    }
  });

  server.listen(port, '0.0.0.0', () => {
    logger?.info({ port }, 'Web QR server listening.');
  });

  return server;
}
