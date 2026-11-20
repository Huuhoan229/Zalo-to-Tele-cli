const observers = new WeakMap();

// Subscribe before starting login. Keep Telegram failures out of the login flow.
export function observeZaloLogin(controller, { onQr, onStatus, timeoutMs = 5 * 60 * 1000 } = {}) {
  observers.get(controller)?.dispose();
  let queue = Promise.resolve();
  let finished = false;
  let timer;
  let lastState = null;
  const listeners = [];
  const info = () => ({
    accountId: controller.account.id,
    accountName: controller.zalo?.selfProfile?.displayName ||
      controller.zalo?.selfProfile?.zaloName || controller.account.label,
    mode: controller.getZaloAiMode(),
    savedToMongo: Boolean(controller.store.useMongo && controller.store.getCredentials?.()),
  });
  const enqueue = (action) => {
    queue = queue.then(action).catch((error) => {
      controller.logger.warn({ error, accountId: controller.account.id }, 'Could not deliver Zalo login notification.');
    });
  };
  const notify = (type, extra = {}) => {
    const event = { type, ...info(), ...extra };
    enqueue(() => onStatus?.(event));
  };
  const dispose = () => {
    finished = true;
    clearTimeout(timer);
    for (const [name, handler] of listeners) controller.off(name, handler);
    if (observers.get(controller) === observer) observers.delete(controller);
  };
  const finish = (type, extra) => {
    if (finished) return;
    notify(type, extra);
    dispose();
  };
  const listen = (name, handler) => {
    listeners.push([name, handler]);
    controller.on(name, handler);
  };
  const checkState = () => {
    if (finished) return;
    if (controller.status === 'running' && controller.listenerConnected) {
      finish('success');
    } else if (controller.status === 'error') {
      finish('error', { error: controller.lastError || 'Không kết nối được tài khoản Zalo.' });
    } else if (controller.status === 'stopped') {
      finish('stopped');
    } else if (controller.status === 'reconnecting' && lastState !== 'reconnecting') {
      notify('reconnecting');
    }
    lastState = controller.status;
  };
  const observer = { dispose, flush: () => queue };
  observers.set(controller, observer);
  listen('qr', ({ qrImageBase64 }) => enqueue(() => onQr?.(qrImageBase64)));
  listen('qrScanned', ({ account }) => notify('scanned', { scannedName: account }));
  listen('qrExpired', () => notify('expired'));
  listen('qrDeclined', () => notify('declined'));
  listen('change', checkState);
  timer = setTimeout(() => finish('timeout'), timeoutMs);
  timer.unref?.();
  Promise.resolve(controller.ready).catch((error) => finish('error', { error: error?.message || String(error) }));
  if (controller.qrImageBase64) enqueue(() => onQr?.(controller.qrImageBase64));
  checkState();
  return observer;
}
