# Session Management Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Protect protected routes so that duplicating a browser tab forces re-authentication, while allowing multiple simultaneous sessions from different devices.

**Architecture:** A `UserSession` table in PostgreSQL tracks active sessions. On every `POST /auth/sync-profile` call a new `sessionId` (UUID) is generated and returned to the client; the client stores it in `sessionStorage`. Every subsequent protected request must include `X-Session-Id` in the header; `FirebaseAuthGuard` validates it against the DB. Tab duplication is caught on the frontend via the BroadcastChannel API (no backend changes needed for that part).

**Tech Stack:** NestJS, Prisma 7 + PostgreSQL, TypeScript strict mode, Jest.

## Global Constraints

- Never use `any` in TypeScript — type everything explicitly.
- Never use `console.log` — use Pino logger when logging.
- All DB changes go through Prisma; never write raw SQL in service code.
- Migration SQL must be idempotent-safe (use the `prisma db execute` + `prisma migrate resolve` workflow documented in CLAUDE.md — no `prisma migrate dev`).
- `sync-profile` is the ONLY endpoint that creates sessions — it must NOT require `X-Session-Id`.
- All other protected endpoints MUST require a valid `X-Session-Id`.
- Do not break any existing tests.
- Sessions expire after 8 hours.
- Multiple active sessions per user are allowed (Option B — different devices).

---

## File Map

| Action | File | Responsibility |
|--------|------|----------------|
| Modify | `prisma/schema.prisma` | Add `UserSession` model + relation on `User` |
| Create | `prisma/migrations/20260624000000_add_user_sessions/migration.sql` | DDL for `user_sessions` table |
| Create | `src/common/decorators/skip-session.decorator.ts` | `@SkipSessionValidation()` decorator |
| Create | `src/common/services/session.service.ts` | Create/validate sessions via Prisma |
| Create | `src/common/services/session.service.spec.ts` | Unit tests for SessionService |
| Modify | `src/common/common.module.ts` | Register + export `SessionService` |
| Modify | `src/common/guards/firebase-auth.guard.ts` | Inject `SessionService`; validate `X-Session-Id` |
| Modify | `src/common/guards/firebase-auth.guard.spec.ts` | Add session validation test cases |
| Modify | `src/users/users.controller.ts` | Inject `SessionService`; add `sessionId` to `syncProfile` response; add `@SkipSessionValidation()` |

---

## Task 1 — Prisma Schema + Migration

**Files:**
- Modify: `prisma/schema.prisma`
- Create: `prisma/migrations/20260624000000_add_user_sessions/migration.sql`

**Interfaces:**
- Produces: `prisma.userSession.create(...)`, `prisma.userSession.findFirst(...)` — used in Task 2.

- [ ] **Step 1: Add `UserSession` model to `prisma/schema.prisma`**

  Add the `sessions` relation field to the existing `User` model:
  ```prisma
  model User {
    // ... existing fields unchanged ...
    sessions     UserSession[]   // ADD THIS LINE after staffEntries
  }
  ```

  Add the new model at the end of the schema (before the closing of the file):
  ```prisma
  model UserSession {
    id        String   @id @default(uuid())
    userId    String
    sessionId String   @unique
    isActive  Boolean  @default(true)
    createdAt DateTime @default(now())
    expiresAt DateTime

    user User @relation(fields: [userId], references: [id])

    @@map("user_sessions")
  }
  ```

- [ ] **Step 2: Validate schema**

  Run: `npx prisma validate`
  Expected: `The schema at prisma/schema.prisma is valid 🎉`

- [ ] **Step 3: Create migration SQL file**

  Create the directory `prisma/migrations/20260624000000_add_user_sessions/` and write `migration.sql`:

  ```sql
  CREATE TABLE "user_sessions" (
      "id" TEXT NOT NULL,
      "userId" TEXT NOT NULL,
      "sessionId" TEXT NOT NULL,
      "isActive" BOOLEAN NOT NULL DEFAULT true,
      "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
      "expiresAt" TIMESTAMP(3) NOT NULL,

      CONSTRAINT "user_sessions_pkey" PRIMARY KEY ("id")
  );

  CREATE UNIQUE INDEX "user_sessions_sessionId_key" ON "user_sessions"("sessionId");

  ALTER TABLE "user_sessions" ADD CONSTRAINT "user_sessions_userId_fkey"
      FOREIGN KEY ("userId") REFERENCES "users"("id")
      ON DELETE RESTRICT ON UPDATE CASCADE;
  ```

- [ ] **Step 4: Apply migration to database**

  ```bash
  npx prisma db execute --file ./prisma/migrations/20260624000000_add_user_sessions/migration.sql --schema prisma/schema.prisma
  npx prisma migrate resolve --applied 20260624000000_add_user_sessions
  ```

  Expected: No errors; `prisma migrate status` shows the migration as applied.

- [ ] **Step 5: Regenerate Prisma client**

  ```bash
  npx prisma generate
  ```

  Expected: `Generated Prisma Client` message with no errors.

- [ ] **Step 6: Commit**

  ```bash
  git add prisma/schema.prisma prisma/migrations/
  git commit -m "feat(sessions): add UserSession model and migration"
  ```

---

## Task 2 — SessionService + Unit Tests + CommonModule Registration

**Files:**
- Create: `src/common/services/session.service.ts`
- Create: `src/common/services/session.service.spec.ts`
- Modify: `src/common/common.module.ts`

**Interfaces:**
- Produces:
  - `SessionService.createSession(userId: string): Promise<string>` — returns the new `sessionId`
  - `SessionService.validateSession(userId: string, sessionId: string): Promise<boolean>` — returns `true` if valid

- [ ] **Step 1: Write the failing tests**

  Create `src/common/services/session.service.spec.ts`:

  ```typescript
  import { Test } from '@nestjs/testing';
  import { PrismaService } from '../../prisma/prisma.service';
  import { SessionService } from './session.service';

  function buildPrismaMock() {
    return {
      userSession: {
        create: jest.fn(),
        findFirst: jest.fn(),
      },
    };
  }

  describe('SessionService', () => {
    let service: SessionService;
    let prisma: ReturnType<typeof buildPrismaMock>;

    beforeEach(async () => {
      prisma = buildPrismaMock();

      const module = await Test.createTestingModule({
        providers: [
          SessionService,
          { provide: PrismaService, useValue: prisma },
        ],
      }).compile();

      service = module.get(SessionService);
    });

    afterEach(() => jest.clearAllMocks());

    describe('createSession', () => {
      it('crea un registro en user_sessions y retorna el sessionId', async () => {
        const sessionId = 'generated-uuid';
        prisma.userSession.create.mockResolvedValue({ sessionId });

        const result = await service.createSession('user-123');

        expect(prisma.userSession.create).toHaveBeenCalledWith(
          expect.objectContaining({
            data: expect.objectContaining({
              userId: 'user-123',
              isActive: true,
            }),
          }),
        );
        expect(typeof result).toBe('string');
        expect(result).toHaveLength(36); // UUID v4
      });
    });

    describe('validateSession', () => {
      it('retorna true si la sesión existe, está activa y no expiró', async () => {
        prisma.userSession.findFirst.mockResolvedValue({ id: 'sess-1' });

        const result = await service.validateSession('user-123', 'valid-session-id');

        expect(result).toBe(true);
        expect(prisma.userSession.findFirst).toHaveBeenCalledWith(
          expect.objectContaining({
            where: expect.objectContaining({
              userId: 'user-123',
              sessionId: 'valid-session-id',
              isActive: true,
            }),
          }),
        );
      });

      it('retorna false si la sesión no existe', async () => {
        prisma.userSession.findFirst.mockResolvedValue(null);

        const result = await service.validateSession('user-123', 'bad-session-id');

        expect(result).toBe(false);
      });
    });
  });
  ```

- [ ] **Step 2: Run tests to confirm they fail**

  ```bash
  npx jest src/common/services/session.service.spec.ts --no-coverage
  ```

  Expected: FAIL — `Cannot find module './session.service'`

- [ ] **Step 3: Implement `SessionService`**

  Create `src/common/services/session.service.ts`:

  ```typescript
  import { Injectable } from '@nestjs/common';
  import { randomUUID } from 'node:crypto';
  import { PrismaService } from '../../prisma/prisma.service';

  const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

  @Injectable()
  export class SessionService {
    constructor(private readonly prisma: PrismaService) {}

    async createSession(userId: string): Promise<string> {
      const sessionId = randomUUID();
      await this.prisma.userSession.create({
        data: {
          id: randomUUID(),
          userId,
          sessionId,
          isActive: true,
          expiresAt: new Date(Date.now() + SESSION_TTL_MS),
        },
      });
      return sessionId;
    }

    async validateSession(userId: string, sessionId: string): Promise<boolean> {
      const session = await this.prisma.userSession.findFirst({
        where: {
          userId,
          sessionId,
          isActive: true,
          expiresAt: { gt: new Date() },
        },
      });
      return session !== null;
    }
  }
  ```

- [ ] **Step 4: Run tests to confirm they pass**

  ```bash
  npx jest src/common/services/session.service.spec.ts --no-coverage
  ```

  Expected: PASS — 3 tests passing.

- [ ] **Step 5: Register `SessionService` in `CommonModule`**

  Replace the contents of `src/common/common.module.ts`:

  ```typescript
  import { Global, Module } from '@nestjs/common';
  import { PermissionsCacheService } from './services/permissions-cache.service';
  import { SessionService } from './services/session.service';

  @Global()
  @Module({
    providers: [PermissionsCacheService, SessionService],
    exports: [PermissionsCacheService, SessionService],
  })
  export class CommonModule {}
  ```

- [ ] **Step 6: Run all tests to confirm nothing is broken**

  ```bash
  npx jest --no-coverage
  ```

  Expected: All pre-existing tests pass.

- [ ] **Step 7: Commit**

  ```bash
  git add src/common/services/session.service.ts src/common/services/session.service.spec.ts src/common/common.module.ts
  git commit -m "feat(sessions): add SessionService with create/validate and register in CommonModule"
  ```

---

## Task 3 — `@SkipSessionValidation()` Decorator

**Files:**
- Create: `src/common/decorators/skip-session.decorator.ts`

**Interfaces:**
- Produces: `SKIP_SESSION_KEY = 'skipSessionValidation'` constant and `SkipSessionValidation()` decorator — consumed by Task 4.

- [ ] **Step 1: Create the decorator**

  Create `src/common/decorators/skip-session.decorator.ts`:

  ```typescript
  import { SetMetadata } from '@nestjs/common';

  export const SKIP_SESSION_KEY = 'skipSessionValidation';

  /** Mark a route so FirebaseAuthGuard skips X-Session-Id validation.
   *  Use ONLY on endpoints that bootstrap a session (sync-profile). */
  export const SkipSessionValidation = () => SetMetadata(SKIP_SESSION_KEY, true);
  ```

- [ ] **Step 2: Commit**

  ```bash
  git add src/common/decorators/skip-session.decorator.ts
  git commit -m "feat(sessions): add SkipSessionValidation decorator"
  ```

---

## Task 4 — Update `FirebaseAuthGuard` + Tests

**Files:**
- Modify: `src/common/guards/firebase-auth.guard.ts`
- Modify: `src/common/guards/firebase-auth.guard.spec.ts`

**Interfaces:**
- Consumes:
  - `SessionService.validateSession(userId, sessionId): Promise<boolean>` (from Task 2)
  - `SKIP_SESSION_KEY` (from Task 3)
- `AuthenticatedUser` interface: **no changes** — `sessionId` is not part of the user context.

- [ ] **Step 1: Write the failing tests**

  Replace `src/common/guards/firebase-auth.guard.spec.ts` with this (preserves all existing tests and adds new ones):

  ```typescript
  import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
  import { Reflector } from '@nestjs/core';
  import { Test } from '@nestjs/testing';
  import { FirebaseAuthGuard } from './firebase-auth.guard';
  import { PrismaService } from '../../prisma/prisma.service';
  import { SessionService } from '../services/session.service';

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
    sessionHeader?: string,
    isPublic = false,
    skipSession = false,
  ): ExecutionContext {
    const req = {
      headers: {
        ...(authHeader ? { authorization: authHeader } : {}),
        ...(sessionHeader ? { 'x-session-id': sessionHeader } : {}),
      },
    };
    return {
      switchToHttp: () => ({ getRequest: () => req }),
      getHandler: () => ({}),
      getClass: () => ({}),
      _isPublic: isPublic,
      _skipSession: skipSession,
    } as unknown as ExecutionContext;
  }

  describe('FirebaseAuthGuard', () => {
    let guard: FirebaseAuthGuard;
    let reflector: Reflector;
    let prisma: { user: { findUnique: jest.Mock } };
    let sessionService: { validateSession: jest.Mock };

    beforeEach(async () => {
      prisma = { user: { findUnique: jest.fn() } };
      sessionService = { validateSession: jest.fn() };

      const module = await Test.createTestingModule({
        providers: [
          FirebaseAuthGuard,
          {
            provide: Reflector,
            useValue: {
              getAllAndOverride: jest.fn().mockReturnValue(false),
            },
          },
          { provide: PrismaService, useValue: prisma },
          { provide: SessionService, useValue: sessionService },
        ],
      }).compile();

      guard = module.get(FirebaseAuthGuard);
      reflector = module.get(Reflector);
    });

    afterEach(() => jest.clearAllMocks());

    describe('rutas públicas (@Public)', () => {
      it('deja pasar sin verificar token ni sesión', async () => {
        jest.spyOn(reflector, 'getAllAndOverride').mockReturnValue(true);
        const ctx = buildContext(undefined, undefined, true);

        const result = await guard.canActivate(ctx);

        expect(result).toBe(true);
        expect(mockVerifyIdToken).not.toHaveBeenCalled();
        expect(sessionService.validateSession).not.toHaveBeenCalled();
      });
    });

    describe('token válido con sesión válida', () => {
      it('adjunta el usuario al request con roles y permisos', async () => {
        mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-123' });
        prisma.user.findUnique.mockResolvedValue(mockUser);
        sessionService.validateSession.mockResolvedValue(true);

        const ctx = buildContext('Bearer valid-token', 'valid-session-id');
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
        sessionService.validateSession.mockResolvedValue(true);

        const ctx = buildContext('Bearer valid-token', 'valid-session-id');
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
        const ctx = buildContext('Bearer expired-token', 'any-session');

        await expect(guard.canActivate(ctx)).rejects.toThrow(
          new UnauthorizedException('Token expirado'),
        );
      });

      it('lanza UnauthorizedException si el token está revocado', async () => {
        mockVerifyIdToken.mockRejectedValue({ code: 'auth/id-token-revoked' });
        const ctx = buildContext('Bearer revoked-token', 'any-session');

        await expect(guard.canActivate(ctx)).rejects.toThrow(
          new UnauthorizedException('Token revocado'),
        );
      });

      it('lanza UnauthorizedException si el token está malformado', async () => {
        mockVerifyIdToken.mockRejectedValue({ code: 'auth/argument-error' });
        const ctx = buildContext('Bearer bad-token', 'any-session');

        await expect(guard.canActivate(ctx)).rejects.toThrow(
          new UnauthorizedException('Token inválido'),
        );
      });
    });

    describe('validación de sesión', () => {
      it('lanza UnauthorizedException si falta el header X-Session-Id', async () => {
        mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-123' });
        prisma.user.findUnique.mockResolvedValue(mockUser);

        const ctx = buildContext('Bearer valid-token'); // sin sessionHeader

        await expect(guard.canActivate(ctx)).rejects.toThrow(
          new UnauthorizedException('Sesión no iniciada — ejecuta sync-profile'),
        );
      });

      it('lanza UnauthorizedException si el sessionId no está en la DB', async () => {
        mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-123' });
        prisma.user.findUnique.mockResolvedValue(mockUser);
        sessionService.validateSession.mockResolvedValue(false);

        const ctx = buildContext('Bearer valid-token', 'expired-or-wrong-session');

        await expect(guard.canActivate(ctx)).rejects.toThrow(
          new UnauthorizedException('Sesión inválida o expirada'),
        );
      });

      it('omite la validación de sesión en rutas con @SkipSessionValidation()', async () => {
        // Simula que el reflector devuelve true para SKIP_SESSION_KEY
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
          if (key === 'skipSessionValidation') return true;
          return false; // isPublic = false
        });

        mockVerifyIdToken.mockResolvedValue({ uid: 'firebase-uid-123' });
        prisma.user.findUnique.mockResolvedValue(mockUser);

        const ctx = buildContext('Bearer valid-token'); // sin sessionHeader

        const result = await guard.canActivate(ctx);

        expect(result).toBe(true);
        expect(sessionService.validateSession).not.toHaveBeenCalled();
      });
    });

    describe('usuario no encontrado en DB', () => {
      it('permite el request con userId vacío para que sync-profile pueda crear el perfil', async () => {
        mockVerifyIdToken.mockResolvedValue({ uid: 'uid-sin-perfil', email: 'nuevo@eci.edu.co' });
        prisma.user.findUnique.mockResolvedValue(null);

        // sync-profile tiene @SkipSessionValidation(), así que el reflector lo indica
        jest.spyOn(reflector, 'getAllAndOverride').mockImplementation((key: string) => {
          if (key === 'skipSessionValidation') return true;
          return false;
        });

        const ctx = buildContext('Bearer valid-token');
        const result = await guard.canActivate(ctx);

        expect(result).toBe(true);
        const req = ctx.switchToHttp().getRequest();
        expect(req.user.userId).toBe('');
        expect(req.user.firebaseUid).toBe('uid-sin-perfil');
        expect(req.user.roles).toEqual([]);
        expect(sessionService.validateSession).not.toHaveBeenCalled();
      });
    });
  });
  ```

- [ ] **Step 2: Run tests to confirm new tests fail**

  ```bash
  npx jest src/common/guards/firebase-auth.guard.spec.ts --no-coverage
  ```

  Expected: The new session validation tests FAIL; the pre-existing tests PASS.

- [ ] **Step 3: Update `FirebaseAuthGuard` to validate sessions**

  Replace the contents of `src/common/guards/firebase-auth.guard.ts`:

  ```typescript
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
  import { SessionService } from '../services/session.service';
  import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
  import { SKIP_SESSION_KEY } from '../decorators/skip-session.decorator';

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
      private readonly sessionService: SessionService,
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

      if (isPublic) return true;

      const skipSession = this.reflector.getAllAndOverride<boolean>(SKIP_SESSION_KEY, [
        context.getHandler(),
        context.getClass(),
      ]);

      const token = this.extractToken(req);
      const { uid, email } = await this.verifyToken(token);
      req.user = await this.loadUser(uid, email, req.correlationId);

      if (!skipSession && req.user.userId) {
        await this.validateSession(req);
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

    private async validateSession(req: RequestWithUser): Promise<void> {
      const sessionId = req.headers['x-session-id'] as string | undefined;

      if (!sessionId) {
        throw new UnauthorizedException('Sesión no iniciada — ejecuta sync-profile');
      }

      const valid = await this.sessionService.validateSession(req.user.userId, sessionId);
      if (!valid) {
        throw new UnauthorizedException('Sesión inválida o expirada');
      }
    }
  }
  ```

- [ ] **Step 4: Run all guard tests to confirm they pass**

  ```bash
  npx jest src/common/guards/firebase-auth.guard.spec.ts --no-coverage
  ```

  Expected: All tests PASS (existing + new).

- [ ] **Step 5: Run full test suite**

  ```bash
  npx jest --no-coverage
  ```

  Expected: All tests pass.

- [ ] **Step 6: Commit**

  ```bash
  git add src/common/guards/firebase-auth.guard.ts src/common/guards/firebase-auth.guard.spec.ts
  git commit -m "feat(sessions): validate X-Session-Id in FirebaseAuthGuard"
  ```

---

## Task 5 — Update `UsersController` (sync-profile returns sessionId)

**Files:**
- Modify: `src/users/users.controller.ts`

**Interfaces:**
- Consumes:
  - `SessionService.createSession(userId: string): Promise<string>` (Task 2)
  - `SkipSessionValidation()` decorator (Task 3)
- Produces: `POST /auth/sync-profile` response now includes `sessionId: string` field.

> **Note:** No changes needed in `UsersModule` — `SessionService` is available globally via `CommonModule` (`@Global()`).

- [ ] **Step 1: Update `UsersController`**

  In `src/users/users.controller.ts`:

  1. Add these two imports at the top:
     ```typescript
     import { SessionService } from '../common/services/session.service';
     import { SkipSessionValidation } from '../common/decorators/skip-session.decorator';
     ```

  2. Add `SessionService` to the constructor:
     ```typescript
     constructor(
       private readonly usersService: UsersService,
       private readonly sessionService: SessionService,
     ) {}
     ```

  3. Add `@SkipSessionValidation()` to `syncProfile` and update the method to create a session:
     ```typescript
     @Post('auth/sync-profile')
     @SkipSessionValidation()
     @ApiOperation({ ... }) // keep existing @ApiOperation unchanged
     // keep existing @ApiBody, @ApiResponse decorators unchanged
     async syncProfile(
       @CurrentUser() user: AuthenticatedUser,
       @Body(new ZodValidationPipe(SyncProfileSchema)) dto: SyncProfileDto,
       @Res({ passthrough: true }) res: Response,
     ) {
       const { created, ...profile } = await this.usersService.syncProfile(
         user.firebaseUid,
         user.email,
         dto,
         user.correlationId,
       );
       const sessionId = await this.sessionService.createSession(profile.id);
       res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
       return { ...profile, sessionId };
     }
     ```

  The full updated file content for `src/users/users.controller.ts`:

  ```typescript
  import { Body, Controller, Get, HttpStatus, Param, Patch, Post, Put, Query, Res } from '@nestjs/common';
  import type { Response } from 'express';
  import {
    ApiBearerAuth,
    ApiBody,
    ApiOperation,
    ApiParam,
    ApiResponse,
    ApiTags,
  } from '@nestjs/swagger';
  import { UsersService } from './users.service';
  import { SessionService } from '../common/services/session.service';
  import { CurrentUser } from '../common/decorators/current-user.decorator';
  import { RequirePermission } from '../common/decorators/require-permission.decorator';
  import { SkipSessionValidation } from '../common/decorators/skip-session.decorator';
  import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
  import { SyncProfileSchema, type SyncProfileDto } from './dto/sync-profile.dto';
  import { UpdateProfileSchema, type UpdateProfileDto } from './dto/update-profile.dto';
  import { UpdateStatusSchema, type UpdateStatusDto } from './dto/update-status.dto';
  import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';
  import { UserStatus } from '@prisma/client';

  const USER_SCHEMA = {
    type: 'object',
    properties: {
      id:          { type: 'string', format: 'uuid' },
      firebaseUid: { type: 'string' },
      email:       { type: 'string', format: 'email' },
      fullName:    { type: 'string' },
      phone:       { type: 'string', nullable: true },
      avatarUrl:   { type: 'string', nullable: true },
      status:      { type: 'string', enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'] },
      lastLoginAt: { type: 'string', format: 'date-time', nullable: true },
      createdAt:   { type: 'string', format: 'date-time' },
      updatedAt:   { type: 'string', format: 'date-time' },
    },
    example: {
      id:          'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
      firebaseUid: 'firebase-uid-abc123',
      email:       'maria.garcia@eci.edu.co',
      fullName:    'María García',
      phone:       '+57 300 123 4567',
      avatarUrl:   null,
      status:      'ACTIVE',
      lastLoginAt: null,
      createdAt:   '2026-06-10T00:57:54.338Z',
      updatedAt:   '2026-06-10T00:57:54.338Z',
    },
  };

  @ApiTags('Users')
  @ApiBearerAuth()
  @Controller()
  export class UsersController {
    constructor(
      private readonly usersService: UsersService,
      private readonly sessionService: SessionService,
    ) {}

    @Post('auth/sync-profile')
    @SkipSessionValidation()
    @ApiOperation({
      summary: 'Registrar o sincronizar perfil de usuario',
      description:
        'Crea el perfil local en PostgreSQL vinculado al Firebase UID del token. ' +
        'Si el perfil ya existe es idempotente: retorna el perfil existente sin crear duplicados. ' +
        'Debe llamarse en el primer login exitoso desde el cliente. ' +
        'Asigna el rol **BUYER** por defecto y publica el evento `UserRegistered` al bus. ' +
        'Retorna un `sessionId` que el cliente debe guardar en `sessionStorage` y enviar ' +
        'como header `X-Session-Id` en todas las peticiones posteriores.',
    })
    @ApiBody({
      schema: {
        type: 'object',
        required: ['fullName'],
        properties: {
          fullName: { type: 'string', minLength: 2, maxLength: 100, example: 'María García' },
          phone:    { type: 'string', example: '+57 300 123 4567' },
        },
      },
    })
    @ApiResponse({
      status: 201,
      description: 'Perfil creado exitosamente',
      schema: {
        allOf: [{ type: 'object', properties: { sessionId: { type: 'string', format: 'uuid' } } }],
      },
    })
    @ApiResponse({ status: 200, description: 'Perfil ya existente — retornado sin cambios' })
    @ApiResponse({ status: 400, description: 'Validación fallida — fullName es obligatorio' })
    @ApiResponse({ status: 401, description: 'Token de Firebase ausente, expirado o inválido' })
    async syncProfile(
      @CurrentUser() user: AuthenticatedUser,
      @Body(new ZodValidationPipe(SyncProfileSchema)) dto: SyncProfileDto,
      @Res({ passthrough: true }) res: Response,
    ) {
      const { created, ...profile } = await this.usersService.syncProfile(
        user.firebaseUid,
        user.email,
        dto,
        user.correlationId,
      );
      const sessionId = await this.sessionService.createSession(profile.id);
      res.status(created ? HttpStatus.CREATED : HttpStatus.OK);
      return { ...profile, sessionId };
    }

    @Get('users')
    @RequirePermission('user:read')
    @ApiOperation({
      summary: 'Listar usuarios',
      description: 'Lista paginada de usuarios con filtros opcionales. Requiere permiso `user:read`.',
    })
    @ApiResponse({
      status: 200,
      description: 'Lista paginada de usuarios',
      schema: {
        type: 'object',
        properties: {
          data:  { type: 'array', items: USER_SCHEMA },
          meta: {
            type: 'object',
            properties: {
              total:      { type: 'number' },
              page:       { type: 'number' },
              limit:      { type: 'number' },
              totalPages: { type: 'number' },
            },
          },
        },
      },
    })
    @ApiResponse({ status: 401, description: 'Token inválido' })
    @ApiResponse({ status: 403, description: 'Permiso `user:read` requerido' })
    listUsers(
      @Query('page')   page   = '1',
      @Query('limit')  limit  = '20',
      @Query('search') search?: string,
      @Query('status') status?: string,
      @Query('role')   role?:   string,
    ) {
      return this.usersService.listUsers(
        { search, status: status as UserStatus | undefined, role },
        Math.max(1, Number.parseInt(page, 10) || 1),
        Math.min(100, Math.max(1, Number.parseInt(limit, 10) || 20)),
      );
    }

    @Get('users/me')
    @ApiOperation({
      summary: 'Obtener perfil propio',
      description: 'Retorna el perfil del usuario autenticado incluyendo sus roles activos.',
    })
    @ApiResponse({ status: 200, description: 'Perfil del usuario autenticado', schema: USER_SCHEMA })
    @ApiResponse({ status: 401, description: 'Token inválido o usuario sin perfil — ejecutar sync-profile' })
    getMe(@CurrentUser() user: AuthenticatedUser) {
      return this.usersService.findByFirebaseUid(user.firebaseUid);
    }

    @Put('users/me')
    @ApiOperation({
      summary: 'Actualizar perfil propio',
      description:
        'Actualiza los campos del perfil del usuario autenticado. ' +
        'Solo se actualizan los campos enviados (patch semántico). ' +
        'Publica el evento `UserProfileUpdated` con los campos modificados.',
    })
    @ApiBody({
      schema: {
        type: 'object',
        properties: {
          fullName:  { type: 'string', minLength: 2, maxLength: 100, example: 'María García López' },
          phone:     { type: 'string', example: '+57 300 123 4567' },
          avatarUrl: { type: 'string', format: 'uri', example: 'https://storage.googleapis.com/avatar.jpg' },
        },
      },
    })
    @ApiResponse({ status: 200, description: 'Perfil actualizado', schema: USER_SCHEMA })
    @ApiResponse({ status: 400, description: 'Validación fallida — ningún campo válido enviado' })
    @ApiResponse({ status: 401, description: 'Token inválido' })
    @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
    updateMe(
      @CurrentUser() user: AuthenticatedUser,
      @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto,
    ) {
      return this.usersService.updateProfile(user.userId, dto, user.correlationId);
    }

    @Get('users/:id')
    @RequirePermission('user:read')
    @ApiOperation({
      summary: 'Ver perfil de cualquier usuario',
      description: 'Requiere permiso `user:read`. Solo accesible por administradores.',
    })
    @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
    @ApiResponse({ status: 200, description: 'Perfil del usuario', schema: USER_SCHEMA })
    @ApiResponse({ status: 401, description: 'Token inválido' })
    @ApiResponse({ status: 403, description: 'Permiso `user:read` requerido' })
    @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
    getUser(@Param('id') id: string) {
      return this.usersService.findById(id);
    }

    @Patch('users/:id/status')
    @RequirePermission('user:deactivate')
    @ApiOperation({
      summary: 'Cambiar estado de un usuario',
      description:
        'Activa, suspende o desactiva un usuario. Requiere permiso `user:deactivate`. ' +
        'Al desactivar, publica el evento `UserDeactivated`.',
    })
    @ApiParam({ name: 'id', description: 'UUID del usuario', format: 'uuid' })
    @ApiBody({
      schema: {
        type: 'object',
        required: ['status'],
        properties: {
          status: {
            type: 'string',
            enum: ['ACTIVE', 'INACTIVE', 'SUSPENDED'],
            description: 'ACTIVE = reactivar | INACTIVE = baja | SUSPENDED = suspender temporalmente',
          },
        },
      },
    })
    @ApiResponse({ status: 200, description: 'Estado actualizado', schema: USER_SCHEMA })
    @ApiResponse({ status: 400, description: 'Status inválido' })
    @ApiResponse({ status: 401, description: 'Token inválido' })
    @ApiResponse({ status: 403, description: 'Permiso `user:deactivate` requerido' })
    @ApiResponse({ status: 404, description: 'Usuario no encontrado' })
    updateStatus(
      @Param('id') id: string,
      @Body(new ZodValidationPipe(UpdateStatusSchema)) dto: UpdateStatusDto,
      @CurrentUser() actor: AuthenticatedUser,
    ) {
      return this.usersService.updateStatus(
        id,
        dto.status as UserStatus,
        actor.userId,
        actor.correlationId,
      );
    }
  }
  ```

- [ ] **Step 2: Run full test suite**

  ```bash
  npx jest --no-coverage
  ```

  Expected: All tests pass.

- [ ] **Step 3: Commit**

  ```bash
  git add src/users/users.controller.ts
  git commit -m "feat(sessions): return sessionId from sync-profile and skip session validation on that endpoint"
  ```

---

## Frontend Snippet (Reference — not a backend task)

The client must store `sessionId` in `sessionStorage` and include it as `X-Session-Id` on every request. Additionally, a BroadcastChannel listener detects tab duplication and forces re-authentication on the duplicate tab.

```typescript
// After calling POST /auth/sync-profile
const { sessionId, ...profile } = await api.post('/auth/sync-profile', { fullName });
sessionStorage.setItem('sessionId', sessionId);

// Axios/fetch interceptor — add to every request
headers['X-Session-Id'] = sessionStorage.getItem('sessionId') ?? '';

// Tab duplication detection — run once on app load
const TAB_ID = crypto.randomUUID();
const channel = new BroadcastChannel('auth_session');
let isPrimary = false;

channel.postMessage({ type: 'CLAIM_PRIMARY', tabId: TAB_ID });

const claimTimeout = setTimeout(() => { isPrimary = true; }, 150);

channel.onmessage = (e: MessageEvent<{ type: string; tabId?: string; forTabId?: string }>) => {
  if (e.data.type === 'CLAIM_PRIMARY' && isPrimary) {
    channel.postMessage({ type: 'PRIMARY_EXISTS', forTabId: e.data.tabId });
  }
  if (e.data.type === 'PRIMARY_EXISTS' && e.data.forTabId === TAB_ID) {
    clearTimeout(claimTimeout);
    sessionStorage.removeItem('sessionId');
    window.location.href = '/login';
  }
};
```

---

## Self-Review

**Spec coverage:**
- ✅ `UserSession` table in Postgres — Task 1
- ✅ `SessionService.createSession` / `validateSession` — Task 2
- ✅ `@SkipSessionValidation()` decorator — Task 3
- ✅ Guard validates `X-Session-Id` for all protected routes — Task 4
- ✅ Guard skips session check for `@Public()` and `@SkipSessionValidation()` — Task 4
- ✅ Guard skips session check when `userId === ''` (no local profile yet) — Task 4 (`if (!skipSession && req.user.userId)`)
- ✅ `sync-profile` returns `sessionId` + marked `@SkipSessionValidation()` — Task 5
- ✅ Multiple sessions per user allowed (no `updateMany` to deactivate old sessions) — Task 2
- ✅ All existing tests preserved — Tasks 2, 4
- ✅ Frontend BroadcastChannel snippet documented — Reference section

**Placeholder scan:** No TBD/TODO/placeholder found.

**Type consistency:**
- `SessionService.createSession(userId: string): Promise<string>` — used the same in Task 4 guard and Task 5 controller.
- `SessionService.validateSession(userId: string, sessionId: string): Promise<boolean>` — used identically in Task 4 guard and tested in Task 2 spec.
- `SKIP_SESSION_KEY = 'skipSessionValidation'` — defined in Task 3 and read in Task 4 guard.
