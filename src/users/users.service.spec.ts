import { InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { AuditAction, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { UsersService } from './users.service';


const buyerRole = { id: 'role-buyer', name: 'BUYER', systemRole: 'BUYER' };

const dbUser = {
  id: 'user-123',
  firebaseUid: 'firebase-uid-abc',
  email: 'ana@eci.edu.co',
  fullName: 'Ana García',
  phone: null,
  avatarUrl: null,
  status: UserStatus.ACTIVE,
  userRoles: [{ role: buyerRole }],
};

const syncDto = { fullName: 'Ana García', phone: '+573001234567' };
const correlationId = 'corr-uuid-001';

function buildPrismaMock() {
  return {
    user: {
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    role: { findFirst: jest.fn() },
    userRole: { create: jest.fn() },
    outboxEvent: { create: jest.fn() },
    auditLog: { create: jest.fn() },
    $transaction: jest.fn(),
  };
}


describe('UsersService', () => {
  let service: UsersService;
  let prisma: ReturnType<typeof buildPrismaMock>;

  beforeEach(async () => {
    prisma = buildPrismaMock();

    const module = await Test.createTestingModule({
      providers: [
        UsersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();

    service = module.get(UsersService);
  });

  afterEach(() => jest.clearAllMocks());


  describe('syncProfile', () => {
    it('retorna el perfil existente sin crear nada (idempotente)', async () => {
      prisma.user.findUnique.mockResolvedValue(dbUser);
      prisma.user.update.mockResolvedValue(dbUser);

      const result = await service.syncProfile(
        dbUser.firebaseUid, dbUser.email, syncDto, correlationId,
      );

      expect(result.firebaseUid).toBe(dbUser.firebaseUid);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('crea el usuario con rol BUYER en transacción si no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findFirst.mockResolvedValue(buyerRole);
      prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
      prisma.user.create.mockResolvedValue(dbUser);
      prisma.userRole.create.mockResolvedValue({});
      prisma.outboxEvent.create.mockResolvedValue({});
      prisma.auditLog.create.mockResolvedValue({});

      const result = await service.syncProfile(
        dbUser.firebaseUid, dbUser.email, syncDto, correlationId,
      );

      expect(prisma.user.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ firebaseUid: dbUser.firebaseUid }),
        }),
      );
      expect(prisma.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'UserRegistered' }),
        }),
      );
      expect(prisma.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ action: AuditAction.USER_CREATED }),
        }),
      );
      expect(result.roles).toContain('BUYER');
    });

    it('lanza InternalServerErrorException si el rol BUYER no existe en DB', async () => {
      prisma.user.findUnique.mockResolvedValue(null);
      prisma.role.findFirst.mockResolvedValue(null);

      await expect(
        service.syncProfile(dbUser.firebaseUid, dbUser.email, syncDto, correlationId),
      ).rejects.toThrow(InternalServerErrorException);
    });
  });


  describe('findById', () => {
    it('retorna el usuario formateado', async () => {
      prisma.user.findUnique.mockResolvedValue(dbUser);

      const result = await service.findById('user-123');

      expect(result.userId).toBe('user-123');
      expect(result.roles).toEqual(['BUYER']);
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findById('no-existe')).rejects.toThrow(NotFoundException);
    });
  });


  describe('updateProfile', () => {
    it('actualiza el perfil y escribe en outbox y audit', async () => {
      prisma.user.findUnique.mockResolvedValue(dbUser);
      prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
      prisma.user.update.mockResolvedValue({ ...dbUser, fullName: 'Ana Nueva' });
      prisma.outboxEvent.create.mockResolvedValue({});
      prisma.auditLog.create.mockResolvedValue({});

      const result = await service.updateProfile(
        'user-123', { fullName: 'Ana Nueva' }, correlationId,
      );

      expect(prisma.user.update).toHaveBeenCalled();
      expect(prisma.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'UserProfileUpdated' }),
        }),
      );
      expect(result.fullName).toBe('Ana Nueva');
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateProfile('no-existe', { fullName: 'Test' }, correlationId),
      ).rejects.toThrow(NotFoundException);
    });

    it('actualiza solo el numero de celular del usuario', async () => {
      prisma.user.findUnique.mockResolvedValue(dbUser);
      prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
      prisma.user.update.mockResolvedValue({ ...dbUser, phone: '+573001112233' });
      prisma.outboxEvent.create.mockResolvedValue({});
      prisma.auditLog.create.mockResolvedValue({});

      const result = await service.updatePhone(
        'user-123', '+573001112233', correlationId,
      );

      expect(prisma.user.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { phone: '+573001112233' },
        }),
      );
      expect(result.phone).toBe('+573001112233');
    });
  });



  describe('updateStatus', () => {
    it('publica UserDeactivated al desactivar un usuario', async () => {
      prisma.user.findUnique.mockResolvedValue(dbUser);
      prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => Promise<unknown>) => fn(prisma));
      prisma.user.update.mockResolvedValue({ ...dbUser, status: UserStatus.INACTIVE });
      prisma.auditLog.create.mockResolvedValue({});
      prisma.outboxEvent.create.mockResolvedValue({});

      await service.updateStatus('user-123', UserStatus.INACTIVE, 'admin-id', correlationId, 'Solicitud administrativa');

      expect(prisma.outboxEvent.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ eventType: 'UserDeactivated' }),
        }),
      );
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateStatus('no-existe', UserStatus.INACTIVE, 'admin-id', correlationId),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
