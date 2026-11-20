import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { observeZaloLogin } from '../src/loginNotifications.js';
import { BridgeManager } from '../src/bridgeManager.js';

function controllerFixture() {
  return Object.assign(new EventEmitter(), {
    account: { id: 'zalo1', label: 'Zalo HJ' },
    status: 'starting', listenerConnected: false, ready: Promise.resolve(),
    zalo: { selfProfile: { displayName: 'HJ' } },
    store: { useMongo: true, getCredentials: () => ({ saved: true }) },
    getZaloAiMode: () => 'off',
    logger: { warn: () => {} },
  });
}

test('login notifications preserve QR order and only confirm success after listener readiness', async () => {
  const controller = controllerFixture();
  const delivered = [];
  const observer = observeZaloLogin(controller, {
    onQr: async (image) => delivered.push(['qr', image]),
    onStatus: async (event) => delivered.push([event.type, event]),
  });
  controller.emit('qr', { qrImageBase64: 'qr-image' });
  controller.emit('qrScanned', { account: 'HJ' });
  controller.emit('credentialsSaved', { credentialsFile: 'private.json' });
  controller.status = 'running';
  controller.emit('change');
  await observer.flush();
  assert.deepEqual(delivered.map(([type]) => type), ['qr', 'scanned']);
  controller.listenerConnected = true;
  controller.emit('change');
  controller.emit('change');
  await observer.flush();
  assert.deepEqual(delivered.map(([type]) => type), ['qr', 'scanned', 'success']);
  const success = delivered.at(-1)[1];
  assert.equal(success.accountId, 'zalo1');
  assert.equal(success.accountName, 'HJ');
  assert.equal(success.mode, 'off');
  assert.equal(success.savedToMongo, true);
  assert.equal(controller.listenerCount('change'), 0);
  assert.equal(controller.listenerCount('qr'), 0);
});

test('listener can connect before bridge startup completes without premature success', async () => {
  const controller = controllerFixture();
  const delivered = [];
  const observer = observeZaloLogin(controller, { onStatus: (event) => delivered.push(event.type) });
  controller.listenerConnected = true;
  controller.emit('change');
  await observer.flush();
  assert.deepEqual(delivered, []);
  controller.status = 'running';
  controller.emit('change');
  await observer.flush();
  assert.deepEqual(delivered, ['success']);
});

test('starting an already connected account confirms status without restarting login', async () => {
  const controller = controllerFixture();
  controller.status = 'running';
  controller.listenerConnected = true;
  controller.snapshot = () => ({ status: controller.status });
  const manager = new BridgeManager();
  manager.accounts = [controller.account];
  manager.controllers.set('zalo1', controller);
  manager.updateAccount = async () => controller.account;
  const delivered = [];
  await manager.startManagedAccount('zalo1', null, (event) => delivered.push(event.type));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(delivered, ['success']);
  assert.equal(controller.listenerCount('change'), 0);
});

test('expired and declined QR notifications permit retries and do not report success on error', async () => {
  const controller = controllerFixture();
  const delivered = [];
  const observer = observeZaloLogin(controller, { onStatus: (event) => delivered.push(event) });
  controller.emit('qrExpired');
  controller.emit('qrDeclined');
  controller.status = 'error';
  controller.lastError = 'Login failed';
  controller.emit('change');
  controller.status = 'running';
  controller.listenerConnected = true;
  controller.emit('change');
  await observer.flush();
  assert.deepEqual(delivered.map((event) => event.type), ['expired', 'declined', 'error']);
  assert.equal(delivered.at(-1).error, 'Login failed');
  assert.equal(controller.listenerCount('change'), 0);
});

test('failed Telegram notification does not interrupt login or duplicate observers', async () => {
  const controller = controllerFixture();
  const old = [];
  observeZaloLogin(controller, { onStatus: (event) => old.push(event.type) });
  let warnings = 0;
  controller.logger.warn = () => { warnings += 1; };
  const delivered = [];
  const observer = observeZaloLogin(controller, {
    onQr: async () => { throw new Error('Telegram unavailable'); },
    onStatus: (event) => delivered.push(event.type),
  });
  controller.emit('qr', { qrImageBase64: 'image' });
  controller.emit('qrScanned', { account: 'HJ' });
  controller.status = 'running';
  controller.listenerConnected = true;
  controller.emit('change');
  await observer.flush();
  assert.deepEqual(old, []);
  assert.equal(warnings, 1);
  assert.deepEqual(delivered, ['scanned', 'success']);
});

test('manual stop ends pending login notifications', async () => {
  const controller = controllerFixture();
  const delivered = [];
  const observer = observeZaloLogin(controller, { onStatus: (event) => delivered.push(event.type) });
  controller.status = 'stopped';
  controller.emit('change');
  await observer.flush();
  assert.deepEqual(delivered, ['stopped']);
  assert.equal(controller.listenerCount('qrScanned'), 0);
});

test('pending login timeout is explicit and removes listeners', async () => {
  const controller = controllerFixture();
  const delivered = [];
  const observer = observeZaloLogin(controller, {
    timeoutMs: 1,
    onStatus: (event) => delivered.push(event.type),
  });
  await new Promise((resolve) => setTimeout(resolve, 10));
  await observer.flush();
  assert.deepEqual(delivered, ['timeout']);
  assert.equal(controller.listenerCount('change'), 0);
});
