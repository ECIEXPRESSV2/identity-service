import { NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { InternalService } from './internal.service';

function buildPrismaMock() {
  return {
    user: { findUnique: jest.fn() },
    store: { findUnique: jest.fn() },
    storeStaff: { findMany: jest.fn() },
  };
}

describe('InternalService.resolveByFirebaseUid', () => {
  let service: InternalService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const module = await Test.createTestingModule({
      providers: [InternalService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(InternalService);
  });

  afterEach(() => jest.clearAllMocks());

  it('devuelve userId local, roles y la tienda en propiedad (vendedor)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-uuid-1',
      status: UserStatus.ACTIVE,
      userRoles: [{ role: { name: 'VENDOR' } }],
      ownedStores: [{ id: 'store-uuid-1' }],
      staffEntries: [],
    });

    const result = await service.resolveByFirebaseUid('firebase-uid-abc');

    expect(result).toEqual({
      userId: 'user-uuid-1',
      roles: ['VENDOR'],
      storeId: 'store-uuid-1',
      status: UserStatus.ACTIVE,
    });
    // Filtra roles expirados igual que /auth/validate.
    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { firebaseUid: 'firebase-uid-abc' } }),
    );
  });

  it('devuelve storeId null cuando el usuario no es dueño de ninguna tienda (comprador)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-uuid-2',
      status: UserStatus.ACTIVE,
      userRoles: [{ role: { name: 'BUYER' } }],
      ownedStores: [],
      staffEntries: [],
    });

    const result = await service.resolveByFirebaseUid('firebase-uid-buyer');

    expect(result).toEqual({
      userId: 'user-uuid-2',
      roles: ['BUYER'],
      storeId: null,
      status: UserStatus.ACTIVE,
    });
  });

  it('devuelve la primera tienda (más antigua) si el usuario posee varias (dato inconsistente con regla de negocio)', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-uuid-3',
      status: UserStatus.ACTIVE,
      userRoles: [{ role: { name: 'VENDOR' } }],
      ownedStores: [{ id: 'store-old' }, { id: 'store-new' }],
      staffEntries: [],
    });

    const result = await service.resolveByFirebaseUid('firebase-uid-multi');

    expect(result.storeId).toBe('store-old');
  });

  it('incluye el status aunque el usuario esté desactivado', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-uuid-4',
      status: UserStatus.SUSPENDED,
      userRoles: [{ role: { name: 'BUYER' } }],
      ownedStores: [],
      staffEntries: [],
    });

    const result = await service.resolveByFirebaseUid('firebase-uid-suspended');

    expect(result.status).toBe(UserStatus.SUSPENDED);
  });

  it('lanza 404 si el firebaseUid no tiene perfil local', async () => {
    prisma.user.findUnique.mockResolvedValue(null);

    await expect(
      service.resolveByFirebaseUid('firebase-uid-sin-perfil'),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('devuelve storeId de la asignación de staff cuando el usuario es staff activo pero no dueño', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-uuid-staff',
      status: UserStatus.ACTIVE,
      userRoles: [{ role: { name: 'VENDOR' } }],
      ownedStores: [],
      staffEntries: [{ storeId: 'store-uuid-staff' }],
    });

    const result = await service.resolveByFirebaseUid('firebase-uid-staff');

    expect(result).toEqual({
      userId:  'user-uuid-staff',
      roles:   ['VENDOR'],
      storeId: 'store-uuid-staff',
      status:  UserStatus.ACTIVE,
    });
  });

  it('prefiere storeId en propiedad sobre la asignación de staff si el usuario tiene ambos', async () => {
    prisma.user.findUnique.mockResolvedValue({
      id: 'user-uuid-owner-and-staff',
      status: UserStatus.ACTIVE,
      userRoles: [{ role: { name: 'VENDOR' } }],
      ownedStores: [{ id: 'store-owned' }],
      staffEntries: [{ storeId: 'store-other' }],
    });

    const result = await service.resolveByFirebaseUid('firebase-uid-owner-and-staff');

    expect(result.storeId).toBe('store-owned');
  });
});

describe('InternalService.getUserProfile', () => {
  let service: InternalService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();
    const module = await Test.createTestingModule({
      providers: [InternalService, { provide: PrismaService, useValue: prisma }],
    }).compile();
    service = module.get(InternalService);
  });

  afterEach(() => jest.clearAllMocks());

  it('devuelve nombre y avatar del usuario, para mostrarlos en el chat del vendedor', async () => {
    prisma.user.findUnique.mockResolvedValue({ fullName: 'Ana Cliente', avatarUrl: 'https://x/ana.png' });

    const result = await service.getUserProfile('user-uuid-1');

    expect(result).toEqual({ fullName: 'Ana Cliente', avatarUrl: 'https://x/ana.png' });
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: 'user-uuid-1' },
      select: { fullName: true, avatarUrl: true },
    });
  });

  it('lanza 404 si el usuario no existe', async () => {
    prisma.user.findUnique.mockResolvedValue(null);
    await expect(service.getUserProfile('no-existe')).rejects.toBeInstanceOf(NotFoundException);
  });
});
