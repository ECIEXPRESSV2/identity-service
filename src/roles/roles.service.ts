import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
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
