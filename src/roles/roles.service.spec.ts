import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { RolesService } from './roles.service';
import { PermissionsCacheService } from '../common/services/permissions-cache.service';

const mockPrisma = {
  user: { findUnique: jest.fn() },
  role: { findUnique: jest.fn(), findMany: jest.fn() },
  userRole: { findFirst: jest.fn(), findMany: jest.fn(), count: jest.fn(), create: jest.fn(), delete: jest.fn() },
  auditLog: { create: jest.fn() },
  $transaction: jest.fn(),
};

function makeService() {
  const cache = new PermissionsCacheService();
  jest.spyOn(cache, 'invalidate');
  return { service: new RolesService(mockPrisma as never, cache), cache };
}

const ACTOR_ID = 'actor-uuid';
const USER_ID  = 'user-uuid';
const ROLE_ID  = 'role-uuid';

const fakeUser = { id: USER_ID, email: 'u@eci.edu.co' };
const fakeRole = { id: ROLE_ID, name: 'SELLER' };
const fakeAssignment = { id: 'assignment-uuid', userId: USER_ID, roleId: ROLE_ID };

describe('RolesService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation((fn: (tx: typeof mockPrisma) => Promise<unknown>) =>
      fn(mockPrisma),
    );
    mockPrisma.userRole.findMany.mockResolvedValue([
      { role: { id: ROLE_ID, name: 'SELLER' } },
    ]);
  });

  // ── listRoles ──────────────────────────────────────────────────────────────

  it('returns all roles', async () => {
    const { service } = makeService();
    mockPrisma.role.findMany.mockResolvedValue([fakeRole]);
    const result = await service.listRoles();
    expect(result).toEqual([fakeRole]);
  });

  // ── assignRole ─────────────────────────────────────────────────────────────

  it('throws NotFoundException when user does not exist', async () => {
    const { service } = makeService();
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.role.findUnique.mockResolvedValue(fakeRole);

    await expect(service.assignRole(USER_ID, ROLE_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when role does not exist', async () => {
    const { service } = makeService();
    mockPrisma.user.findUnique.mockResolvedValue(fakeUser);
    mockPrisma.role.findUnique.mockResolvedValue(null);

    await expect(service.assignRole(USER_ID, ROLE_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
  });

  it('is idempotent — returns existing roles without creating a duplicate', async () => {
    const { service, cache } = makeService();
    mockPrisma.user.findUnique.mockResolvedValue(fakeUser);
    mockPrisma.role.findUnique.mockResolvedValue(fakeRole);
    mockPrisma.userRole.findFirst.mockResolvedValue(fakeAssignment);

    const result = await service.assignRole(USER_ID, ROLE_ID, ACTOR_ID);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
    expect(result.userId).toBe(USER_ID);
  });

  it('creates userRole and audit log, then invalidates cache', async () => {
    const { service, cache } = makeService();
    mockPrisma.user.findUnique.mockResolvedValue(fakeUser);
    mockPrisma.role.findUnique.mockResolvedValue(fakeRole);
    mockPrisma.userRole.findFirst.mockResolvedValue(null);
    mockPrisma.userRole.create.mockResolvedValue(fakeAssignment);
    mockPrisma.auditLog.create.mockResolvedValue({});

    const result = await service.assignRole(USER_ID, ROLE_ID, ACTOR_ID);

    expect(mockPrisma.userRole.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ userId: USER_ID, roleId: ROLE_ID }) }),
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledWith(USER_ID);
    expect(result.userId).toBe(USER_ID);
  });

  // ── revokeRole ─────────────────────────────────────────────────────────────

  it('throws NotFoundException when user does not exist on revoke', async () => {
    const { service } = makeService();
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.role.findUnique.mockResolvedValue(fakeRole);

    await expect(service.revokeRole(USER_ID, ROLE_ID, ACTOR_ID)).rejects.toThrow(NotFoundException);
  });

  it('throws ConflictException when role is not assigned to the user', async () => {
    const { service } = makeService();
    mockPrisma.user.findUnique.mockResolvedValue(fakeUser);
    mockPrisma.role.findUnique.mockResolvedValue(fakeRole);
    mockPrisma.userRole.findFirst.mockResolvedValue(null);

    await expect(service.revokeRole(USER_ID, ROLE_ID, ACTOR_ID)).rejects.toThrow(ConflictException);
  });

  it('throws BadRequestException when revoking the only role', async () => {
    const { service } = makeService();
    mockPrisma.user.findUnique.mockResolvedValue(fakeUser);
    mockPrisma.role.findUnique.mockResolvedValue(fakeRole);
    mockPrisma.userRole.findFirst.mockResolvedValue(fakeAssignment);
    mockPrisma.userRole.count.mockResolvedValue(1);

    await expect(service.revokeRole(USER_ID, ROLE_ID, ACTOR_ID)).rejects.toThrow(BadRequestException);
  });

  it('deletes userRole and audit log, then invalidates cache', async () => {
    const { service, cache } = makeService();
    mockPrisma.user.findUnique.mockResolvedValue(fakeUser);
    mockPrisma.role.findUnique.mockResolvedValue(fakeRole);
    mockPrisma.userRole.findFirst.mockResolvedValue(fakeAssignment);
    mockPrisma.userRole.count.mockResolvedValue(2);
    mockPrisma.userRole.delete.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    const result = await service.revokeRole(USER_ID, ROLE_ID, ACTOR_ID);

    expect(mockPrisma.userRole.delete).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: fakeAssignment.id } }),
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(cache.invalidate).toHaveBeenCalledWith(USER_ID);
    expect(result.userId).toBe(USER_ID);
  });
});
