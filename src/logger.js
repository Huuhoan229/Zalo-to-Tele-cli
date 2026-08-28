import util from 'node:util';

const LEVEL_ORDER = {
  trace: 10,
  debug: 20,
  info: 30,
  warn: 40,
  error: 50,
  fatal: 60,
};

function levelEnabled(active, level) {
  return LEVEL_ORDER[level] >= LEVEL_ORDER[active];
}

function formatValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  return value;
}

function extractEntry(args) {
  const parts = Array.from(args);
  const error = parts.find((item) => item instanceof Error) || null;
  const stringPart = parts.find((item) => typeof item === 'string') || '';
  const objectPart = parts.find(
    (item) => item && typeof item === 'object' && !(item instanceof Error) && !Array.isArray(item),
  );

  return {
    message: stringPart,
    data: objectPart ? util.inspect(formatValue(objectPart), { depth: 4, colors: false }) : null,
    error: error ? formatValue(error) : null,
  };
}

function consoleLine(entry) {
  const ts = new Date(entry.timestamp).toISOString().split('T')[1].replace('Z', '');
  const scope = entry.scope ? ` (${entry.scope})` : '';
  const suffix = entry.data ? ` ${entry.data}` : '';
  const error = entry.error ? ` ${entry.error.message}` : '';
  return `[${ts}] ${entry.level.toUpperCase()}${scope}: ${entry.message || ''}${error}${suffix}`.trim();
}

export function createLogger({ level = 'info', scope = 'app', onLog, consoleOutput = false } = {}) {
  function emit(nextLevel, args) {
    if (!levelEnabled(level, nextLevel)) return;
    const extracted = extractEntry(args);
    const entry = {
      timestamp: new Date().toISOString(),
      level: nextLevel,
      scope,
      message: extracted.message,
      data: extracted.data,
      error: extracted.error,
    };

    onLog?.(entry);
    if (consoleOutput) {
      const line = consoleLine(entry);
      if (nextLevel === 'error' || nextLevel === 'fatal') {
        console.error(line);
      } else if (nextLevel === 'warn') {
        console.warn(line);
      } else {
        console.log(line);
      }
    }
  }

  const logger = {};
  for (const levelName of Object.keys(LEVEL_ORDER)) {
    logger[levelName] = (...args) => emit(levelName, args);
  }

  logger.child = (bindings = {}) =>
    createLogger({
      level,
      scope: bindings.scope || bindings.name || bindings.accountId || scope,
      onLog,
      consoleOutput,
    });

  return logger;
}
