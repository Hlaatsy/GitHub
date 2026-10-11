import pino from 'pino';

export const logger = pino({
  level: process.env.LOG_LEVEL ?? 'info',
  base: undefined,
  redact: {
    paths: ['accessToken', '*.accessToken', 'headers.authorization', '*.headers.authorization'],
    censor: '[redacted]',
  },
});

export type Logger = pino.Logger;
