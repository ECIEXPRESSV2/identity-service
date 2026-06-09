import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { FirebaseAuthGuard } from './firebase-auth.guard';
import { PrismaService } from '../../prisma/prisma.service';

const mockVerifyIdToken = jest.fn();
jest.mock('firebase-admin', () => ({
  apps: [],
  initializeApp: jest.fn(),
  credential: { cert: jest.fn() },
  auth: () => ({ verifyIdToken: mockVerifyIdToken }),
}));


jest.mock('../../config/firebase.config', () => ({
  initFirebase: jest.fn(),
  admin: {
    auth: () => ({ verifyIdToken: mockVerifyIdToken }),
  },
}));



const mockUser = {
  id: 'user-uuid',
  firebaseUid: 'firebase-uid-123',
  email: 'ana@eci.edu.co',
  userRoles: [
    {
      expiresAt: null,
      role: {
        name: 'BUYER',
        rolePermissions: [
          { permission: { resource: 'store', action: 'read' } },
        ],
      },
    },
  ],
};

function buildContext(
  authHeader: string | undefined,
  isPublic = false,
): ExecutionContext {
  const req = {
    headers: {
      ...(authHeader ? { authorization: authHeader } : {}),
    },
  };
  return {
    switchToHttp: () => ({ getRequest: () => req }),
    getHandler: () => ({}),
    getClass: () => ({}),
    _isPublic: isPublic,
  } as unknown as ExecutionContext;
}



describe('FirebaseAuthGuard', () => {
  let guard: FirebaseAuthGuard;
  let reflector: Reflector;
  let prisma: { user: { findUnique: jest.Mock } };

  beforeEach(async () => {
    prisma = { user: { findUnique: jest.fn() } };

    const module = await Test.createTestingModule({
      providers: [
        FirebaseAuthGuard,
        {
          provide: Reflector,
          useValue: { getAllAndOverride: jest.fn().mockReturnValue(false) },
        },
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    guard = module.get(FirebaseAuthGuard);
    reflector = module.get(Reflector);
  });

  afterEach(() => jest.clearAllMocks());

  describe('rutas públicas (@Public)', () => {
    it('deja pasar sin verificar token', async () => {
      jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
      const ctx = buildContext(undefined, true);

      const result = await guard.canActivate(ctx);

      expect(result).toBe(true);
      expect(mockVerifyIdToken).not.toHaveBeenCalled();
    });
  });

  describe('token válido', () => {
    it('adjunta el usuario al request con roles y permisos', async () => {
      mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-123' });
      prisma.user.findUnique.mockResolvedValue(mockUser);

      const ctx = buildContext('Bearer valid-token');
      const req = ctx.switchToHttp().getRequest<{ user: unknown }>();

      await guard.canActivate(ctx);

      expect(req.user).toMatchObject({
        userId: 'user-uuid',
        firebaseUid: 'firebase-uid-123',
        email: 'ana@eci.edu.co',
        roles: ['BUYER'],
        permissions: ['store:read'],
      });
    });

    it('genera correlationId si no viene en el header', async () => {
      mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-123' });
      prisma.user.findUnique.mockResolvedValue(mockUser);

      const ctx = buildContext('Bearer valid-token');
      const req = ctx.switchToHttp().getRequest<{ correlationId: string }>();

      await guard.canActivate(ctx);

      expect(req.correlationId).toMatch(
        /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
      );
    });
  });

  describe('errores de token', () => {
    it('lanza UnauthorizedException si no hay header Authorization', async () => {
      const ctx = buildContext(undefined);

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Token de autorización requerido'),
      );
    });

    it('lanza UnauthorizedException si el token está expirado', async () => {
      mockVerifyIdToken.mockRejectedValue({ code: 'auth/id-token-expired' });
      const ctx = buildContext('Bearer expired-token');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Token expirado'),
      );
    });

    it('lanza UnauthorizedException si el token está revocado', async () => {
      mockVerifyIdToken.mockRejectedValue({ code: 'auth/id-token-revoked' });
      const ctx = buildContext('Bearer revoked-token');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Token revocado'),
      );
    });

    it('lanza UnauthorizedException si el token está malformado', async () => {
      mockVerifyIdToken.mockRejectedValue({ code: 'auth/argument-error' });
      const ctx = buildContext('Bearer bad-token');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        new UnauthorizedException('Token inválido'),
      );
    });
  });

  describe('usuario no encontrado en DB', () => {
    it('lanza UnauthorizedException si el firebaseUid no tiene perfil', async () => {
      mockVerifyIdToken.mockResolvedValue({ uid: 'uid-sin-perfil' });
      prisma.user.findUnique.mockResolvedValue(null);

      const ctx = buildContext('Bearer valid-token');

      await expect(guard.canActivate(ctx)).rejects.toThrow(
        UnauthorizedException,
      );
    });
  });
});
