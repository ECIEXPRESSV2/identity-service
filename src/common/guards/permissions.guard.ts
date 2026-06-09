import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PERMISSIONS_KEY } from '../decorators/require-permission.decorator';
import { PrismaService } from '../../prisma/prisma.service';
import { PermissionsCacheService } from '../services/permissions-cache.service';
import type { RequestWithUser } from './firebase-auth.guard';

@Injectable()
export class PermissionsGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
    private readonly cache: PermissionsCacheService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const required = this.reflector.getAllAndOverride<string[]>(PERMISSIONS_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (!required || required.length === 0) return true;

    const { user } = context.switchToHttp().getRequest<RequestWithUser>();

    const { roles, permissions } = await this.getEffectiveAccess(user.userId);

    if (roles.includes('ADMIN')) return true;

    const hasPermission = required.some((p) => permissions.includes(p));
    if (!hasPermission) {
      throw new ForbiddenException(
        `Se requiere uno de los siguientes permisos: ${required.join(', ')}`,
      );
    }

    return true;
  }

  private async getEffectiveAccess(
    userId: string,
  ): Promise<{ roles: string[]; permissions: string[] }> {
    const cached = this.cache.get(userId);
    if (cached) return cached;

    const userRoles = await this.prisma.userRole.findMany({
      where: {
        userId,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        role: {
          include: {
            rolePermissions: { include: { permission: true } },
          },
        },
      },
    });

    const roles = userRoles.map((ur) => ur.role.name);
    const permissions = [
      ...new Set(
        userRoles.flatMap((ur) =>
          ur.role.rolePermissions.map(
            (rp) => `${rp.permission.resource}:${rp.permission.action}`,
          ),
        ),
      ),
    ];

    this.cache.set(userId, roles, permissions);

    return { roles, permissions };
  }
}
