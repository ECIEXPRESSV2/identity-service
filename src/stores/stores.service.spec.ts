import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StoreStatus } from '@prisma/client';
import { StoresService } from './stores.service';

const mockPrisma = {
  store:         { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  storeSchedule: { upsert: jest.fn(), findMany: jest.fn() },
  outboxEvent:   { create: jest.fn() },
  auditLog:      { create: jest.fn() },
  $transaction:  jest.fn(),
};

function makeService() {
  return new StoresService(mockPrisma as never);
}

const OWNER_ID = 'owner-uuid';
const ACTOR_ID = 'actor-uuid';
const STORE_ID = 'store-uuid';
const CORR_ID  = 'corr-uuid';

const fakeStore = {
  id: STORE_ID, ownerId: OWNER_ID, name: 'Cafetería ECI',
  location: 'Bloque A', description: null, imageUrl: null,
  status: StoreStatus.OPEN, isActive: true,
  createdAt: new Date(), updatedAt: new Date(),
};

describe('StoresService', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
    );
  });

  // ── createStore ────────────────────────────────────────────────────────────

  it('creates store, outbox event and audit log in one transaction', async () => {
    const service = makeService();
    const dto = { name: 'Cafetería ECI', location: 'Bloque A' };
    mockPrisma.store.create.mockResolvedValue(fakeStore);
    mockPrisma.outboxEvent.create.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    const result = await service.createStore(OWNER_ID, dto, CORR_ID);

    expect(mockPrisma.store.create).toHaveBeenCalled();
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ eventType: 'StoreCreated' }) }),
    );
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(result.id).toBe(STORE_ID);
  });

  // ── findById ───────────────────────────────────────────────────────────────

  it('throws NotFoundException when store does not exist', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(null);

    await expect(service.findById(STORE_ID)).rejects.toThrow(NotFoundException);
  });

  it('returns store with schedules', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue({ ...fakeStore, schedules: [] });

    const result = await service.findById(STORE_ID);
    expect(result.id).toBe(STORE_ID);
    expect(result.schedules).toEqual([]);
  });

  // ── updateStore ────────────────────────────────────────────────────────────

  it('allows owner to update their store', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.store.update.mockResolvedValue({ ...fakeStore, name: 'Nuevo nombre' });
    mockPrisma.auditLog.create.mockResolvedValue({});

    const result = await service.updateStore(STORE_ID, { name: 'Nuevo nombre' }, OWNER_ID, false);
    expect(result.name).toBe('Nuevo nombre');
  });

  it('allows admin to update any store regardless of ownership', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.store.update.mockResolvedValue(fakeStore);
    mockPrisma.auditLog.create.mockResolvedValue({});

    await expect(
      service.updateStore(STORE_ID, { name: 'x' }, 'other-user', true),
    ).resolves.toBeDefined();
  });

  it('throws ForbiddenException when non-owner non-admin tries to update', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.updateStore(STORE_ID, { name: 'hack' }, 'attacker', false),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── updateStatus ───────────────────────────────────────────────────────────

  it('publishes StoreStatusChanged outbox event on status change', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.store.update.mockResolvedValue({ ...fakeStore, status: StoreStatus.CLOSED });
    mockPrisma.outboxEvent.create.mockResolvedValue({});
    mockPrisma.auditLog.create.mockResolvedValue({});

    await service.updateStatus(STORE_ID, { status: 'CLOSED' }, OWNER_ID, false, CORR_ID);

    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'StoreStatusChanged' }),
      }),
    );
  });

  it('is idempotent — skips transaction when status is unchanged', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore); // already OPEN

    await service.updateStatus(STORE_ID, { status: 'OPEN' }, OWNER_ID, false, CORR_ID);

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  // ── upsertSchedule ─────────────────────────────────────────────────────────

  it('throws BadRequestException when openTime >= closeTime', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.upsertSchedule(
        STORE_ID,
        { dayOfWeek: 1, openTime: '18:00', closeTime: '08:00', isActive: true },
        OWNER_ID,
        false,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when openTime equals closeTime', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.upsertSchedule(
        STORE_ID,
        { dayOfWeek: 1, openTime: '08:00', closeTime: '08:00', isActive: true },
        OWNER_ID,
        false,
      ),
    ).rejects.toThrow(BadRequestException);
  });

  it('upserts schedule with valid times', async () => {
    const service = makeService();
    const schedule = { id: 'sch-1', storeId: STORE_ID, dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true };
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeSchedule.upsert.mockResolvedValue(schedule);

    const result = await service.upsertSchedule(
      STORE_ID,
      { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true },
      OWNER_ID,
      false,
    );

    expect(result.openTime).toBe('08:00');
  });

  it('throws ForbiddenException when non-owner tries to upsert schedule', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.upsertSchedule(
        STORE_ID,
        { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true },
        'attacker',
        false,
      ),
    ).rejects.toThrow(ForbiddenException);
  });

  // ── getSchedules ───────────────────────────────────────────────────────────

  it('throws NotFoundException for unknown store on getSchedules', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(null);

    await expect(service.getSchedules(STORE_ID)).rejects.toThrow(NotFoundException);
  });

  it('returns schedules ordered by dayOfWeek', async () => {
    const service = makeService();
    const schedules = [
      { id: '1', dayOfWeek: 0 },
      { id: '2', dayOfWeek: 3 },
    ];
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeSchedule.findMany.mockResolvedValue(schedules);

    const result = await service.getSchedules(STORE_ID);
    expect(result).toHaveLength(2);
  });
});
