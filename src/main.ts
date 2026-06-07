import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { exec } from 'child_process';

const SERVICE_NAME = 'identity-service';
const LOCK_FILE = path.join(os.tmpdir(), `${SERVICE_NAME}-swagger.lock`);

function openBrowser(url: string): void {
  const platform = process.platform;
  let cmd: string;
  if (platform === 'win32') {
    cmd = `start "" "${url}"`;
  } else if (platform === 'darwin') {
    cmd = `open "${url}"`;
  } else {
    cmd = `xdg-open "${url}"`;
  }
  exec(cmd);
}

function openSwaggerSingleton(url: string): void {
  if (fs.existsSync(LOCK_FILE)) return;
  fs.writeFileSync(LOCK_FILE, process.pid.toString(), 'utf-8');
  openBrowser(url);
}

function cleanupLock(): void {
  if (fs.existsSync(LOCK_FILE)) fs.unlinkSync(LOCK_FILE);
}

process.on('SIGTERM', () => {
  cleanupLock();
  process.exit(0);
});

process.on('SIGINT', () => {
  cleanupLock();
  process.exit(0);
});

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const config = new DocumentBuilder()
    .setTitle('Identity Service')
    .setDescription('Identity Service API documentation')
    .setVersion('1.0')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document);

  const port = process.env.PORT ?? 3000;
  await app.listen(port);

  openSwaggerSingleton(`http://localhost:${port}/api`);
}
bootstrap();
