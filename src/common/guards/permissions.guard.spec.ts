import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { PermissionsGuard } from './permissions.guard';
import { PermissionsCacheService } from '../services/permissions-cache.service';

const mockPrisma = {
  userRole: { findMany: jest.fn() },
};

function makeContext(userId: string, handler: object = {}, classRef: object = {}): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => classRef,
    switchToHttp: () => ({ getRequest: () => ({ user: { userId } }) }),
  } as unknown as ExecutionContext;
}

function makeReflector(permissions: string[] | undefined): Reflector {
  return {
    getAllAndOverride: () => permissions,
  } as unknown as Reflector;
}

function makeUserRoles(roleNames: string[], perms: string[][] = []) {
  return roleNames.map((name, i) => ({
    role: {
      name,
      rolePermissions: (perms[i] ?? []).map((p) => {
        const [resource, action] = p.split(':');
        return { permission: { resource, action } };
      }),
    },
    expiresAt: null,
  }));
}

describe('PermissionsGuard', () => {
  let guard: PermissionsGuard;
  let cacheService: PermissionsCacheService;

  beforeEach(() => {
    jest.clearAllMocks();
    cacheService = new PermissionsCacheService();
    guard = new PermissionsGuard(makeReflector(undefined), mockPrisma as never, cacheService);
  });

  it('passes when no permissions are required on the endpoint', async () => {
    const result = await guard.canActivate(makeContext('user-1'));
    expect(result).toBe(true);
    expect(mockPrisma.userRole.findMany).not.toHaveBeenCalled();
  });

  it('passes when required is an empty array', async () => {
    guard = new PermissionsGuard(makeReflector([]), mockPrisma as never, cacheService);
    const result = await guard.canActivate(makeContext('user-1'));
    expect(result).toBe(true);
    expect(mockPrisma.userRole.findMany).not.toHaveBeenCalled();
  });

  it('bypasses permission check for ADMIN role', async () => {
    guard = new PermissionsGuard(makeReflector(['store:write']), mockPrisma as never, cacheService);
    mockPrisma.userRole.findMany.mockResolvedValue(makeUserRoles(['ADMIN'], [[]]));

    const result = await guard.canActivate(makeContext('admin-1'));
    expect(result).toBe(true);
  });

  it('passes when user has the required permission', async () => {
    guard = new PermissionsGuard(makeReflector(['store:read']), mockPrisma as never, cacheService);
    mockPrisma.userRole.findMany.mockResolvedValue(
      makeUserRoles(['VENDOR'], [['store:read', 'store:write']]),
    );

    const result = await guard.canActivate(makeContext('seller-1'));
    expect(result).toBe(true);
  });

  it('throws ForbiddenException when user lacks the required permission', async () => {
    guard = new PermissionsGuard(makeReflector(['user:deactivate']), mockPrisma as never, cacheService);
    mockPrisma.userRole.findMany.mockResolvedValue(
      makeUserRoles(['BUYER'], [['store:read']]),
    );

    await expect(guard.canActivate(makeContext('buyer-1'))).rejects.toThrow(ForbiddenException);
  });

  it('uses OR logic — passes if user has at least one of multiple required permissions', async () => {
    guard = new PermissionsGuard(
      makeReflector(['store:write', 'store:admin']),
      mockPrisma as never,
      cacheService,
    );
    mockPrisma.userRole.findMany.mockResolvedValue(
      makeUserRoles(['VENDOR'], [['store:write']]),
    );

    const result = await guard.canActivate(makeContext('seller-2'));
    expect(result).toBe(true);
  });

  it('uses cache on second request — DB is only queried once per TTL window', async () => {
    guard = new PermissionsGuard(makeReflector(['store:read']), mockPrisma as never, cacheService);
    mockPrisma.userRole.findMany.mockResolvedValue(
      makeUserRoles(['VENDOR'], [['store:read']]),
    );

    await guard.canActivate(makeContext('seller-3'));
    await guard.canActivate(makeContext('seller-3'));

    expect(mockPrisma.userRole.findMany).toHaveBeenCalledTimes(1);
  });

  it('re-queries DB after cache is invalidated', async () => {
    guard = new PermissionsGuard(makeReflector(['store:read']), mockPrisma as never, cacheService);
    mockPrisma.userRole.findMany.mockResolvedValue(
      makeUserRoles(['VENDOR'], [['store:read']]),
    );

    await guard.canActivate(makeContext('seller-4'));
    cacheService.invalidate('seller-4');
    await guard.canActivate(makeContext('seller-4'));

    expect(mockPrisma.userRole.findMany).toHaveBeenCalledTimes(2);
  });

  it('re-queries DB after TTL expires', async () => {
    guard = new PermissionsGuard(makeReflector(['store:read']), mockPrisma as never, cacheService);
    mockPrisma.userRole.findMany.mockResolvedValue(
      makeUserRoles(['VENDOR'], [['store:read']]),
    );

    jest.spyOn(Date, 'now')
      .mockReturnValueOnce(1000)   // cache set: expiresAt = 1000 + 60_000 = 61_000
      .mockReturnValueOnce(62_000) // cache check on 2nd call: 61_000 > 62_000 → expired
      .mockReturnValueOnce(62_000); // cache set again after re-query

    await guard.canActivate(makeContext('seller-5'));
    await guard.canActivate(makeContext('seller-5'));

    expect(mockPrisma.userRole.findMany).toHaveBeenCalledTimes(2);
    jest.restoreAllMocks();
  });
});
