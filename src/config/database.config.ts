import { registerAs } from '@nestjs/config';
import { TypeOrmModuleOptions } from '@nestjs/typeorm';
import { join } from 'path';

export default registerAs('database', (): TypeOrmModuleOptions => ({
  type: 'postgres',
  host: process.env.DB_HOST,
  port: parseInt(process.env.DB_PORT || '', 10) || 5432,
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  autoLoadEntities: process.env.AUTO_LOAD === 'true',

  synchronize: process.env.NODE_ENV === 'test'
    ? true
    : process.env.DB_SYNC === 'true',

  logging: process.env.NODE_ENV === 'development' 
    ? ['error', 'warn', 'query'] 
    : ['error', 'warn'],

  migrations: [
    join(__dirname, '..', 'database', 'migrations', '*.{ts,js}'),
  ],
  migrationsTableName: 'typeorm_migrations',
  migrationsRun: process.env.NODE_ENV === 'production',
}));