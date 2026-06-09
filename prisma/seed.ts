import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '@prisma/client';

const adapter = new PrismaPg({ connectionString: process.env['DATABASE_URL'] });
const prisma = new PrismaClient({ adapter });

// Qué permisos tiene cada rol del sistema.
// ADMIN bypasea el guard, pero se le asignan todos para que /auth/validate
// retorne el conjunto completo al API Gateway.
const ROLE_PERMISSIONS: Record<string, string[]> = {
  ADMIN: [
    'user:read', 'user:deactivate',
    'role:read', 'role:assign', 'role:revoke',
    'store:read', 'store:write', 'store:close',
  ],
  SELLER:  ['store:read', 'store:write'],
  ANALYST: ['user:read', 'store:read'],
  BUYER:   [],
};

async function main() {
  // ─── Roles ──────────────────────────────────────────────────────────────────
  const roleDefs = [
    { name: 'BUYER',   systemRole: 'BUYER',   description: 'Comprador — estudiante o personal ECI' },
    { name: 'SELLER',  systemRole: 'SELLER',  description: 'Vendedor — dueño de punto de venta' },
    { name: 'ADMIN',   systemRole: 'ADMIN',   description: 'Administrador de la plataforma' },
    { name: 'ANALYST', systemRole: 'ANALYST', description: 'Analista — acceso a reportes' },
  ] as const;

  for (const role of roleDefs) {
    await prisma.role.upsert({
      where: { name: role.name },
      update: {},
      create: { name: role.name, systemRole: role.systemRole, isSystem: true, description: role.description },
    });
  }

  // ─── Permisos ────────────────────────────────────────────────────────────────
  const permDefs = [
    { resource: 'user',  action: 'read',       description: 'Ver perfil de cualquier usuario' },
    { resource: 'user',  action: 'deactivate', description: 'Activar/suspender/desactivar usuario' },
    { resource: 'role',  action: 'read',       description: 'Listar roles' },
    { resource: 'role',  action: 'assign',     description: 'Asignar rol a usuario' },
    { resource: 'role',  action: 'revoke',     description: 'Revocar rol de usuario' },
    { resource: 'store', action: 'read',       description: 'Ver detalle y cierres de store' },
    { resource: 'store', action: 'write',      description: 'Crear y actualizar store' },
    { resource: 'store', action: 'close',      description: 'Crear cierre temporal' },
  ];

  for (const perm of permDefs) {
    await prisma.permission.upsert({
      where: { resource_action: { resource: perm.resource, action: perm.action } },
      update: {},
      create: perm,
    });
  }

  // ─── Asignación de permisos a roles ─────────────────────────────────────────
  const [roles, permissions] = await Promise.all([
    prisma.role.findMany(),
    prisma.permission.findMany(),
  ]);

  const roleMap = new Map(roles.map((r) => [r.name, r.id]));
  const permMap = new Map(permissions.map((p) => [`${p.resource}:${p.action}`, p.id]));

  for (const [roleName, permKeys] of Object.entries(ROLE_PERMISSIONS)) {
    const roleId = roleMap.get(roleName);
    if (!roleId) continue;

    for (const key of permKeys) {
      const permissionId = permMap.get(key);
      if (!permissionId) continue;

      await prisma.rolePermission.upsert({
        where: { roleId_permissionId: { roleId, permissionId } },
        update: {},
        create: { roleId, permissionId },
      });
    }
  }

  console.log('Seed completado: roles, permisos y asignaciones creados.');
}

main()
  .catch((e) => { console.error(e); process.exit(1); })
  .finally(() => prisma.$disconnect());
