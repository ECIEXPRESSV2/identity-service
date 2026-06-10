import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PermissionsCacheService } from '../common/services/permissions-cache.service';

@Injectable()
export class RolesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly cache: PermissionsCacheService,
  ) {}

  async createRole(name: string, description?: string, actorId?: string) {
    const existing = await this.prisma.role.findUnique({ where: { name } });
    if (existing) throw new ConflictException(`Ya existe un rol con el nombre "${name}"`);

    const role = await this.prisma.$transaction(async (tx) => {
      const r = await tx.role.create({
        data: { name, description: description ?? null, isSystem: false },
      });
      await tx.auditLog.create({
        data: {
          actorId:    actorId ?? null,
          targetId:   r.id,
          targetType: 'Role',
          action:     AuditAction.ROLE_ASSIGNED,
          newValue:   { name, description } as never,
        },
      });
      return r;
    });

    return role;
  }

  async listPermissions(resource?: string) {
    return this.prisma.permission.findMany({
      where:   resource ? { resource } : undefined,
      orderBy: [{ resource: 'asc' }, { action: 'asc' }],
      select:  { id: true, resource: true, action: true, description: true },
    });
  }

  async setRolePermissions(roleId: string, permissionIds: string[], actorId: string) {
    const role = await this.prisma.role.findUnique({ where: { id: roleId } });
    if (!role) throw new NotFoundException('Rol no encontrado');
    if (role.isSystem) throw new UnprocessableEntityException('Los roles de sistema no pueden modificarse');

    const perms = await this.prisma.permission.findMany({
      where: { id: { in: permissionIds } },
    });
    if (perms.length !== permissionIds.length) {
      const found = new Set(perms.map((p) => p.id));
      const missing = permissionIds.filter((id) => !found.has(id));
      throw new BadRequestException(`Permisos no encontrados: ${missing.join(', ')}`);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { roleId } });
      if (permissionIds.length > 0) {
        await tx.rolePermission.createMany({
          data: permissionIds.map((permissionId) => ({ roleId, permissionId })),
        });
      }
      await tx.auditLog.create({
        data: {
          actorId,
          targetId:   roleId,
          targetType: 'Role',
          action:     AuditAction.PERMISSION_GRANTED,
          newValue:   { permissionIds } as never,
        },
      });
    });

    // Invalidar caché de todos los usuarios que tengan este rol
    const affected = await this.prisma.userRole.findMany({ where: { roleId }, select: { userId: true } });
    affected.forEach(({ userId }) => this.cache.invalidate(userId));
    return this.prisma.role.findUnique({
      where:   { id: roleId },
      include: { rolePermissions: { include: { permission: { select: { id: true, resource: true, action: true } } } } },
    });
  }

  async listRoles() {
    return this.prisma.role.findMany({
      select: { id: true, name: true, systemRole: true, description: true },
      orderBy: { name: 'asc' },
    });
  }

  async assignRole(userId: string, roleId: string, actorId: string) {
    const [user, role] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.role.findUnique({ where: { id: roleId } }),
    ]);

    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (!role) throw new NotFoundException('Rol no encontrado');

    const existing = await this.prisma.userRole.findFirst({
      where: { userId, roleId },
    });

    if (existing) {
      return this.buildResponse(userId);
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.create({
        data: { userId, roleId, assignedBy: actorId },
      });

      await tx.auditLog.create({
        data: {
          actorId,
          targetId: userId,
          targetType: 'User',
          action: AuditAction.ROLE_ASSIGNED,
          newValue: { roleId, roleName: role.name } as never,
        },
      });
    });

    this.cache.invalidate(userId);
    return this.buildResponse(userId);
  }

  async revokeRole(userId: string, roleId: string, actorId: string) {
    const [user, role] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId } }),
      this.prisma.role.findUnique({ where: { id: roleId } }),
    ]);

    if (!user) throw new NotFoundException('Usuario no encontrado');
    if (!role) throw new NotFoundException('Rol no encontrado');

    if (actorId === userId && role.systemRole === 'ADMIN') {
      throw new ConflictException('Un administrador no puede revocar su propio rol ADMIN');
    }

    const assignment = await this.prisma.userRole.findFirst({
      where: { userId, roleId },
    });

    if (!assignment) {
      throw new ConflictException('El usuario no tiene ese rol asignado');
    }

    const totalRoles = await this.prisma.userRole.count({ where: { userId } });
    if (totalRoles <= 1) {
      throw new BadRequestException(
        'No se puede revocar el único rol del usuario',
      );
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.userRole.delete({ where: { id: assignment.id } });

      await tx.auditLog.create({
        data: {
          actorId,
          targetId: userId,
          targetType: 'User',
          action: AuditAction.ROLE_REVOKED,
          oldValue: { roleId, roleName: role.name } as never,
        },
      });
    });

    this.cache.invalidate(userId);
    return this.buildResponse(userId);
  }

  private async buildResponse(userId: string) {
    const userRoles = await this.prisma.userRole.findMany({
      where: { userId },
      include: { role: { select: { id: true, name: true } } },
    });

    return {
      userId,
      roles: userRoles.map((ur) => ({ id: ur.role.id, name: ur.role.name })),
    };
  }
}
