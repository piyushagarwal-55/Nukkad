import { env } from '../config/env.js';

export const loggerConfig =
  env.NODE_ENV === 'development'
    ? { transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss', ignore: 'pid,hostname' } } }
    : true;
