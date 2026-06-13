import { ClosureSchedulerService } from './closure-scheduler.service';

type WithProcessJob = {
  processJob(job: { name: string; data: { storeId: string; closureId: string; correlationId: string } }): Promise<void>;
};

const mockPrisma = {
  store:        { findUnique: jest.fn(), update: jest.fn() },
  storeClosure: { updateMany: jest.fn() },
  outboxEvent:  { create: jest.fn() },
  $transaction: jest.fn(),
};

function makeScheduler() {
  return new ClosureSchedulerService(mockPrisma as never);
}

function makeJob(name: string, storeId = 'store-1', closureId = 'closure-1') {
  return { name, data: { storeId, closureId, correlationId: 'corr-1' } };
}

describe('ClosureSchedulerService — processJob', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
    );
  });

  it('does nothing when store is not found', async () => {
    const scheduler = makeScheduler();
    mockPrisma.store.findUnique.mockResolvedValue(null);

    await (scheduler as unknown as WithProcessJob).processJob(makeJob('close-store'));

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('does nothing when store already has target status (close-store)', async () => {
    const scheduler = makeScheduler();
    mockPrisma.store.findUnique.mockResolvedValue({ id: 'store-1', status: 'TEMPORARILY_CLOSED' });

    await (scheduler as unknown as WithProcessJob).processJob(makeJob('close-store'));

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('does nothing when store already has target status (reopen-store)', async () => {
    const scheduler = makeScheduler();
    mockPrisma.store.findUnique.mockResolvedValue({ id: 'store-1', status: 'OPEN' });

    await (scheduler as unknown as WithProcessJob).processJob(makeJob('reopen-store'));

    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('sets TEMPORARILY_CLOSED and writes StoreStatusChanged outbox event', async () => {
    const scheduler = makeScheduler();
    mockPrisma.store.findUnique.mockResolvedValue({ id: 'store-1', status: 'OPEN' });
    mockPrisma.outboxEvent.create.mockResolvedValue({});

    await (scheduler as unknown as WithProcessJob).processJob(makeJob('close-store'));

    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ eventType: 'StoreStatusChanged' }),
      }),
    );
    const payload = mockPrisma.outboxEvent.create.mock.calls[0][0].data.payload.payload;
    expect(payload.newStatus).toBe('TEMPORARILY_CLOSED');
    expect(payload.previousStatus).toBe('OPEN');
  });

  it('sets OPEN, marks closure EXPIRED and writes StoreStatusChanged + StoreClosureExpired on reopen', async () => {
    const scheduler = makeScheduler();
    mockPrisma.store.findUnique.mockResolvedValue({ id: 'store-1', status: 'TEMPORARILY_CLOSED' });
    mockPrisma.outboxEvent.create.mockResolvedValue({});
    mockPrisma.storeClosure.updateMany.mockResolvedValue({ count: 1 });

    await (scheduler as unknown as WithProcessJob).processJob(makeJob('reopen-store'));

    // First outbox event: StoreStatusChanged
    const statusPayload = mockPrisma.outboxEvent.create.mock.calls[0][0].data.payload.payload;
    expect(statusPayload.newStatus).toBe('OPEN');
    expect(statusPayload.previousStatus).toBe('TEMPORARILY_CLOSED');

    // Second outbox event: StoreClosureExpired
    expect(mockPrisma.outboxEvent.create).toHaveBeenCalledTimes(2);
    expect(mockPrisma.outboxEvent.create.mock.calls[1][0].data.eventType).toBe('StoreClosureExpired');

    // Closure record marked EXPIRED
    expect(mockPrisma.storeClosure.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'EXPIRED' }) }),
    );
  });
});
