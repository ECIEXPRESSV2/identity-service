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

    // Genera o propaga correlationId antes de cualquier throw
    req.correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID();

    if (!isPublic) {
      const token = this.extractToken(req);
      const firebaseUid = await this.verifyToken(token);
      req.user = await this.loadUser(firebaseUid, req.correlationId);
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

  private async verifyToken(token: string): Promise<string> {
    try {
      const decoded = await admin.auth().verifyIdToken(token);
      return decoded.uid;
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

    if (!dbUser) {
      throw new UnauthorizedException(
        'Usuario no encontrado — realiza POST /auth/sync-profile primero',
      );
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
