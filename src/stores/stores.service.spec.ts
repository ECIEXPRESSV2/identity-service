import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { StoreStatus } from '@prisma/client';
import { StoresService } from './stores.service';

const mockPrisma = {
  store:         { findUnique: jest.fn(), findMany: jest.fn(), create: jest.fn(), update: jest.fn() },
  storeSchedule: { upsert: jest.fn(), findMany: jest.fn() },
  storeClosure:  { findFirst: jest.fn(), findMany: jest.fn(), create: jest.fn() },
  outboxEvent:   { create: jest.fn() },
  auditLog:      { create: jest.fn() },
  $transaction:  jest.fn(),
};

const mockScheduler = {
  scheduleClose:  jest.fn(),
  scheduleReopen: jest.fn(),
};

function makeService() {
  return new StoresService(mockPrisma as never, mockScheduler as never);
}

const OWNER_ID = 'owner-uuid';
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
      service.upsertSchedule(STORE_ID, { dayOfWeek: 1, openTime: '18:00', closeTime: '08:00', isActive: true }, OWNER_ID, false),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when openTime equals closeTime', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.upsertSchedule(STORE_ID, { dayOfWeek: 1, openTime: '08:00', closeTime: '08:00', isActive: true }, OWNER_ID, false),
    ).rejects.toThrow(BadRequestException);
  });

  it('upserts schedule with valid times', async () => {
    const service = makeService();
    const schedule = { id: 'sch-1', storeId: STORE_ID, dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true };
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeSchedule.upsert.mockResolvedValue(schedule);

    const result = await service.upsertSchedule(
      STORE_ID, { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true }, OWNER_ID, false,
    );
    expect(result.openTime).toBe('08:00');
  });

  it('throws ForbiddenException when non-owner tries to upsert schedule', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.upsertSchedule(STORE_ID, { dayOfWeek: 1, openTime: '08:00', closeTime: '18:00', isActive: true }, 'attacker', false),
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
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeSchedule.findMany.mockResolvedValue([{ id: '1', dayOfWeek: 0 }, { id: '2', dayOfWeek: 3 }]);

    const result = await service.getSchedules(STORE_ID);
    expect(result).toHaveLength(2);
  });

  // ── createClosure ──────────────────────────────────────────────────────────

  it('throws NotFoundException when store does not exist on createClosure', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(null);

    await expect(
      service.createClosure(STORE_ID, { startDate: future(1), endDate: future(2) }, OWNER_ID, CORR_ID),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when startDate is in the past', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    const past = new Date(Date.now() - 60_000);

    await expect(
      service.createClosure(STORE_ID, { startDate: past, endDate: future(1) }, OWNER_ID, CORR_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when endDate is not after startDate', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);

    await expect(
      service.createClosure(STORE_ID, { startDate: future(2), endDate: future(1) }, OWNER_ID, CORR_ID),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws ConflictException when dates overlap an existing closure', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeClosure.findFirst.mockResolvedValue({ id: 'existing' });

    await expect(
      service.createClosure(STORE_ID, { startDate: future(1), endDate: future(3) }, OWNER_ID, CORR_ID),
    ).rejects.toThrow(ConflictException);
  });

  it('creates closure, audit log, and schedules both BullMQ jobs', async () => {
    const service = makeService();
    const start = future(1);
    const end   = future(2);
    const fakeClosure = { id: 'closure-1', storeId: STORE_ID, startDate: start, endDate: end, reason: null, createdBy: OWNER_ID, createdAt: new Date() };

    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeClosure.findFirst.mockResolvedValue(null);
    mockPrisma.storeClosure.create.mockResolvedValue(fakeClosure);
    mockPrisma.auditLog.create.mockResolvedValue({});
    mockScheduler.scheduleClose.mockResolvedValue(undefined);
    mockScheduler.scheduleReopen.mockResolvedValue(undefined);

    const result = await service.createClosure(STORE_ID, { startDate: start, endDate: end }, OWNER_ID, CORR_ID);

    expect(mockPrisma.storeClosure.create).toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).toHaveBeenCalled();
    expect(mockScheduler.scheduleClose).toHaveBeenCalledWith(STORE_ID, start, fakeClosure.id);
    expect(mockScheduler.scheduleReopen).toHaveBeenCalledWith(STORE_ID, end, fakeClosure.id);
    expect(result.id).toBe('closure-1');
  });

  // ── listClosures ───────────────────────────────────────────────────────────

  it('returns only future closures', async () => {
    const service = makeService();
    mockPrisma.store.findUnique.mockResolvedValue(fakeStore);
    mockPrisma.storeClosure.findMany.mockResolvedValue([{ id: 'c-1' }]);

    const result = await service.listClosures(STORE_ID);

    expect(mockPrisma.storeClosure.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ endDate: expect.objectContaining({ gt: expect.any(Date) }) }),
      }),
    );
    expect(result).toHaveLength(1);
  });
});

// ─── Helpers ──────────────────────────────────────────────────────────────────

function future(hours: number): Date {
  return new Date(Date.now() + hours * 3_600_000);
}
