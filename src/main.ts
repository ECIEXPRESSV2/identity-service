import 'dotenv/config';
import { NestFactory } from '@nestjs/core';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import { AppModule } from './app.module';
import { execSync, exec } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

const SERVICE_NAME = 'identity-service';
const LOCK_FILE = path.join(os.tmpdir(), `${SERVICE_NAME}-swagger.lock`);
const HOT_RELOAD_WINDOW_MS = 10_000;

function isBrowserRunning(): boolean {
  try {
    if (process.platform === 'win32') {
      const out = execSync('tasklist /nh', {
        encoding: 'utf-8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      return /chrome\.exe|msedge\.exe|firefox\.exe|brave\.exe|opera\.exe/i.test(out);
    }
    const out = execSync('ps aux', { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
    return /Google Chrome|Safari|firefox|Brave Browser|Chromium/i.test(out);
  } catch {
    return false;
  }
}

function openBrowser(url: string): void {
  if (process.platform === 'win32') {
    exec(`start "" "${url}"`, { windowsHide: true });
  } else if (process.platform === 'darwin') {
    exec(`open "${url}"`);
  } else {
    exec(`xdg-open "${url}"`);
  }
}

function openSwaggerIfBrowserOpen(url: string): void {
  if (fs.existsSync(LOCK_FILE)) {
    try {
      const { timestamp } = JSON.parse(fs.readFileSync(LOCK_FILE, 'utf-8')) as {
        timestamp: number;
      };
      if (Date.now() - timestamp < HOT_RELOAD_WINDOW_MS) return;
    } catch {
    }
  }

  if (!isBrowserRunning()) return;

  fs.writeFileSync(LOCK_FILE, JSON.stringify({ timestamp: Date.now() }), 'utf-8');
  openBrowser(url);
}

function cleanupLock(): void {
  try { fs.unlinkSync(LOCK_FILE); } catch { }
}

process.on('SIGTERM', () => { cleanupLock(); process.exit(0); });
process.on('SIGINT',  () => { cleanupLock(); process.exit(0); });

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors({
    origin: ['http://localhost:5173', 'http://localhost:4173'],
    methods: ['GET', 'HEAD', 'PUT', 'PATCH', 'POST', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization', 'Idempotency-Key', 'X-Correlation-Id'],
    exposedHeaders: ['X-Correlation-Id'],
    credentials: true,
  });

  const config = new DocumentBuilder()
    .setTitle('Identity & Administration Service')
    .setDescription(
      `Microservicio de identidad y administración de la plataforma **ECIxpress**.\n\n` +
      `## Autenticación\n` +
      `Todos los endpoints protegidos requieren un **Firebase ID Token** en el header:\n` +
      "`Authorization: Bearer <idToken>`\n\n" +
      `El token se obtiene autenticándose con Firebase Auth (email/password o Google).\n\n` +
      `## Roles del sistema\n` +
      `| Rol | Descripción |\n` +
      `|-----|-------------|\n` +
      `| BUYER | Comprador — rol por defecto al registrarse |\n` +
      `| VENDOR | Vendedor — operador de puntos de venta |\n` +
      `| ADMIN | Administrador — acceso total |\n` +
      `| ANALYST | Analista — solo lectura |\n\n` +
      `## Exportar especificación\n` +
      `- JSON: \`GET /api-json\`\n` +
      `- YAML: \`GET /api-yaml\``
    )
    .setVersion('1.0')
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'Firebase ID Token' },
      'bearer',
    )
    .addTag('Auth',   'Autenticación, sincronización de perfil y validación de tokens')
    .addTag('Users',  'Gestión de perfiles de usuario')
    .addTag('Roles',  'Asignación y revocación de roles a usuarios')
    .addTag('Stores', 'Puntos de venta, horarios regulares y cierres temporales')
    .build();

  const document = SwaggerModule.createDocument(app, config);
  SwaggerModule.setup('api', app, document, {
    swaggerOptions: { persistAuthorization: true },
  });

  const port = process.env.PORT ?? 3001;
  await app.listen(port);

  openSwaggerIfBrowserOpen(`http://localhost:${port}/api`);
}
bootstrap();
