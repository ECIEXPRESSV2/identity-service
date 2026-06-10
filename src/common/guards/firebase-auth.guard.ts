import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { randomUUID } from 'node:crypto';
import type { Request } from 'express';
import { admin, initFirebase } from '../../config/firebase.config';
import { PrismaService } from '../../prisma/prisma.service';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';

export interface AuthenticatedUser {
  userId: string;
  firebaseUid: string;
  email: string;
  roles: string[];
  permissions: string[];
  correlationId: string;
}

export type RequestWithUser = Request & {
  user: AuthenticatedUser;
  correlationId: string;
};

@Injectable()
export class FirebaseAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly prisma: PrismaService,
  ) {
    initFirebase();
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    const req = context.switchToHttp().getRequest<RequestWithUser>();

    req.correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID();

    if (!isPublic) {
      const token = this.extractToken(req);
      const { uid, email } = await this.verifyToken(token);
      req.user = await this.loadUser(uid, email, req.correlationId);
    }

    return true;
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private extractToken(req: Request): string {
    const header = req.headers['authorization'];
    if (!header?.startsWith('Bearer ')) {
      throw new UnauthorizedException('Token de autorización requerido');
    }
    return header.slice(7);
  }

  private async verifyToken(token: string): Promise<{ uid: string; email: string }> {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      return { uid: decoded.uid, email: decoded.email ?? '' };
    } catch (err: unknown) {
      const code = (err as { code?: string }).code ?? '';
      if (code === 'auth/id-token-expired') {
        throw new UnauthorizedException('Token expirado');
      }
      if (code === 'auth/id-token-revoked') {
        throw new UnauthorizedException('Token revocado');
      }
      throw new UnauthorizedException('Token inválido');
    }
  }

  private async loadUser(
    firebaseUid: string,
    email: string,
    correlationId: string,
  ): Promise<AuthenticatedUser> {
    const dbUser = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: {
        userRoles: {
          where: {
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          include: {
            role: {
              include: {
                rolePermissions: { include: { permission: true } },
              },
            },
          },
        },
      },
    });

    // Usuario verificado por Firebase pero sin perfil local todavía.
    // Solo sync-profile necesita este estado; los demás endpoints
    // fallarán por falta de userId o permisos, que es el comportamiento correcto.
    if (!dbUser) {
      return { userId: '', firebaseUid, email, roles: [], permissions: [], correlationId };
    }

    const roles = dbUser.userRoles.map((ur) => ur.role.name);
    const permissions = dbUser.userRoles.flatMap((ur) =>
      ur.role.rolePermissions.map(
        (rp) => `${rp.permission.resource}:${rp.permission.action}`,
      ),
    );

    return {
      userId: dbUser.id,
      firebaseUid: dbUser.firebaseUid,
      email: dbUser.email,
      roles,
      permissions,
      correlationId,
    };
  }
}
