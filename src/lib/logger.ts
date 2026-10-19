type LogLevel = 'DEBUG' | 'INFO' | 'WARNING' | 'ERROR';

interface LogPayload {
  [key: string]: unknown;
}

function log(level: LogLevel, message: string, payload?: LogPayload): void {
  const entry = {
    timestamp: new Date().toISOString(),
    severity: level,
    message,
    ...(payload ? payload : {}),
  };

  if (level === 'ERROR') {
    console.error(JSON.stringify(entry));
  } else if (level === 'WARNING') {
    console.warn(JSON.stringify(entry));
  } else {
    console.log(JSON.stringify(entry));
  }
}

export const logger = {
  debug: (message: string, payload?: LogPayload) => log('DEBUG', message, payload),
  info: (message: string, payload?: LogPayload) => log('INFO', message, payload),
  warn: (message: string, payload?: LogPayload) => log('WARNING', message, payload),
  error: (message: string, payload?: LogPayload) => log('ERROR', message, payload),
};
