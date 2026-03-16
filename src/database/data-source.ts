import { DataSource } from 'typeorm';
import * as dotenv from 'dotenv';
import { join, resolve } from 'path';
import * as fs from 'fs';

const env = process.env.NODE_ENV || 'development';
const envFile = `.env.${env}`;
const envPath = resolve(process.cwd(), envFile);

if (fs.existsSync(envPath)) {
  const envConfig = dotenv.parse(fs.readFileSync(envPath));
  for (const k in envConfig) {
    process.env[k] = envConfig[k];
  }
  console.log(`✅ Chief, Master Key loaded: ${envFile}`);
} else {
  dotenv.config();
}

export const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.DB_HOST ?? 'localhost',
  port: parseInt(process.env.DB_PORT ?? '5432', 10),
  username: process.env.DB_USERNAME,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  synchronize: false,
  logging: false,

  entities: [
    join(process.cwd(), 'src', 'modules', '**', 'entity', '*.entity.ts'),
    join(process.cwd(), 'src', 'modules', '**', 'entity', '*.entity.js'),
  ],

  migrations: [
    join(process.cwd(), 'src', 'database', 'migrations', '*.ts'),
    join(process.cwd(), 'src', 'database', 'migrations', '*.js'),
  ],

  migrationsTableName: 'typeorm_migrations',

  ssl: process.env.DB_SSL === 'true'
    ? { rejectUnauthorized: false }
    : false,
});