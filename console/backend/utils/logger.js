function isJsonLogging() {
  return process.env.LOG_FORMAT === 'json' || process.env.NODE_ENV === 'production';
}

function formatArg(arg) {
  if (arg instanceof Error) {
    return {
      error: {
        name: arg.name || 'Error',
        message: arg.message,
        stack: arg.stack
      }
    };
  }
  return arg;
}

function formatJsonLog(level, args) {
  let message = '';
  const meta = [];

  for (let i = 0; i < args.length; i++) {
    const formatted = formatArg(args[i]);
    if (typeof formatted === 'string') {
      message = message ? `${message} ${formatted}` : formatted;
    } else if (typeof formatted === 'object' && formatted !== null) {
      meta.push(formatted);
    } else {
      message = message ? `${message} ${String(formatted)}` : String(formatted);
    }
  }

  const logEntry = {
    timestamp: new Date().toISOString(),
    level,
    message: message || '',
    service: 'neronet-control-plane'
  };

  if (meta.length === 1 && typeof meta[0] === 'object' && !Array.isArray(meta[0])) {
    Object.assign(logEntry, meta[0]);
  } else if (meta.length > 0) {
    logEntry.meta = meta;
  }

  return JSON.stringify(logEntry);
}

const logger = {
  isJsonLogging,
  info: (...args) => {
    if (isJsonLogging()) {
      console.log(formatJsonLog('info', args));
    } else {
      console.log('\x1b[34m[INFO]\x1b[0m', ...args);
    }
  },
  warn: (...args) => {
    if (isJsonLogging()) {
      console.warn(formatJsonLog('warn', args));
    } else {
      console.warn('\x1b[33m[WARN]\x1b[0m', ...args);
    }
  },
  error: (...args) => {
    if (isJsonLogging()) {
      console.error(formatJsonLog('error', args));
    } else {
      console.error('\x1b[31m[ERROR]\x1b[0m', ...args);
    }
  },
  debug: (...args) => {
    if (process.env.DEBUG || process.env.NODE_ENV === 'development') {
      if (isJsonLogging()) {
        console.log(formatJsonLog('debug', args));
      } else {
        console.log('\x1b[35m[DEBUG]\x1b[0m', ...args);
      }
    }
  }
};

module.exports = logger;
