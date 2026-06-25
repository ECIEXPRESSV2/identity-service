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
