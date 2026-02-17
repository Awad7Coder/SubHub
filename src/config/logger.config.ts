import { format, transports } from 'winston';
import 'winston-daily-rotate-file';

export const winstonConfig = {
  transports: [
    new transports.Console({
      format: format.combine(
        format.timestamp(),
        format.colorize(),
        format.printf(({ timestamp, level, message, context }) => {
          return `${timestamp} [${context || 'Application'}] ${level}: ${message}`;
        }),
      ),
    }),

    new transports.DailyRotateFile({
      filename: 'logs/error-%DATE%.log',
      level: 'error',
      datePattern: 'YYYY-MM-DD',
      zippedArchive: true,
      maxSize: '20m',
      maxFiles: '14d',
      format: format.combine(format.timestamp(), format.json()),
    }),
  ],
};