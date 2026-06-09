import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter });

async function main() {
  // ─── Roles del sistema ──────────────────────────────────────────────────────
  const roles = [
    { name: 'BUYER',   systemRole: 'BUYER',   description: 'Comprador — estudiante o personal ECI' },
    { name: 'SELLER',  systemRole: 'SELLER',  description: 'Vendedor — dueño de punto de venta' },
    { name: 'ADMIN',   systemRole: 'ADMIN',   description: 'Administrador de la plataforma' },
    { name: 'ANALYST', systemRole: 'ANALYST', description: 'Analista — acceso a reportes' },
  ] as const;

  for (const role of roles) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: { name: role.name, systemRole: role.systemRole, isSystem: true, description: role.description },
    });
  }

  // ─── Permisos base ──────────────────────────────────────────────────────────
  const permissions = [
    { resource: 'user',  action: 'read',       description: 'Ver perfil de cualquier usuario' },
    { resource: 'user',  action: 'deactivate', description: 'Activar/suspender/desactivar usuario' },
    { resource: 'role',  action: 'read',       description: 'Listar roles' },
    { resource: 'role',  action: 'assign',     description: 'Asignar rol a usuario' },
    { resource: 'role',  action: 'revoke',     description: 'Revocar rol de usuario' },
    { resource: 'store', action: 'read',       description: 'Ver detalle y cierres de store' },
    { resource: 'store', action: 'write',      description: 'Crear y actualizar store' },
    { resource: 'store', action: 'close',      description: 'Crear cierre temporal' },
  ];

  for (const perm of permissions) {
    await prisma.permission.upsert({
      where: { resource_action: { resource: perm.resource, action: perm.action } },
      update: {},
      create: perm,
    });
  }

  console.log('Seed completado: roles y permisos creados.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
