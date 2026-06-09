import { OutboxWorker, toRoutingKey } from './outbox.worker';

// ─── toRoutingKey ────────────────────────────────────────────────────────────

describe('toRoutingKey', () => {
  it.each([
    ['User',  'UserRegistered',     'identity.user.registered'],
    ['User',  'UserProfileUpdated', 'identity.user.profile_updated'],
    ['User',  'UserDeactivated',    'identity.user.deactivated'],
    ['Store', 'StoreCreated',       'identity.store.created'],
    ['Store', 'StoreStatusChanged', 'identity.store.status_changed'],
  ])('(%s, %s) → %s', (aggregateType, eventType, expected) => {
    expect(toRoutingKey(aggregateType, eventType)).toBe(expected);
  });
});

// ─── OutboxWorker.processOutbox ──────────────────────────────────────────────

const mockPrisma = {
  outboxEvent: {
    findMany: jest.fn(),
    update:   jest.fn(),
  },
};

const mockRabbit = {
  isConnected: true,
  publish: jest.fn(),
};

function makeWorker() {
  return new OutboxWorker(mockPrisma as never, mockRabbit as never);
}

function makePendingEvent(overrides: Partial<{
  id: string;
  retryCount: number;
  nextRetryAt: Date | null;
}> = {}) {
  return {
    id:            overrides.id           ?? 'event-1',
    aggregateType: 'User',
    eventType:     'UserRegistered',
    payload:       { userId: 'u-1' },
    status:        'PENDING',
    retryCount:    overrides.retryCount   ?? 0,
    nextRetryAt:   overrides.nextRetryAt  ?? null,
  };
}

describe('OutboxWorker.processOutbox', () => {
  beforeEach(() => jest.clearAllMocks());

  it('skips run when RabbitMQ is not connected', async () => {
    const worker = makeWorker();
    mockRabbit.isConnected = false;

    await worker.processOutbox();

    expect(mockPrisma.outboxEvent.findMany).not.toHaveBeenCalled();
    mockRabbit.isConnected = true;
  });

  it('does nothing when there are no pending events', async () => {
    const worker = makeWorker();
    mockPrisma.outboxEvent.findMany.mockResolvedValue([]);

    await worker.processOutbox();

    expect(mockPrisma.outboxEvent.update).not.toHaveBeenCalled();
  });

  it('marks event as PUBLISHED on successful publish', async () => {
    const worker = makeWorker();
    const event = makePendingEvent();
    mockPrisma.outboxEvent.findMany.mockResolvedValue([event]);
    mockPrisma.outboxEvent.update.mockResolvedValue({});
    mockRabbit.publish.mockResolvedValue(undefined);

    await worker.processOutbox();

    expect(mockRabbit.publish).toHaveBeenCalledWith(
      'identity.user.registered',
      event.payload,
    );
    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: event.id },
        data: expect.objectContaining({ status: 'PUBLISHED' }),
      }),
    );
  });

  it('increments retryCount and sets nextRetryAt on publish failure', async () => {
    const worker = makeWorker();
    const event = makePendingEvent({ retryCount: 0 });
    mockPrisma.outboxEvent.findMany.mockResolvedValue([event]);
    mockPrisma.outboxEvent.update.mockResolvedValue({});
    mockRabbit.publish.mockRejectedValue(new Error('connection refused'));

    await worker.processOutbox();

    const updateCall = mockPrisma.outboxEvent.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('PENDING');
    expect(updateCall.data.retryCount).toBe(1);
    expect(updateCall.data.nextRetryAt).toBeInstanceOf(Date);
  });

  it('marks event as FAILED after MAX_RETRIES (5) attempts', async () => {
    const worker = makeWorker();
    const event = makePendingEvent({ retryCount: 4 });
    mockPrisma.outboxEvent.findMany.mockResolvedValue([event]);
    mockPrisma.outboxEvent.update.mockResolvedValue({});
    mockRabbit.publish.mockRejectedValue(new Error('timeout'));

    await worker.processOutbox();

    const updateCall = mockPrisma.outboxEvent.update.mock.calls[0][0];
    expect(updateCall.data.status).toBe('FAILED');
    expect(updateCall.data.retryCount).toBe(5);
    expect(updateCall.data.nextRetryAt).toBeNull();
  });

  it('backoff grows exponentially — nextRetryAt is approx 2^retryCount seconds from now', async () => {
    const worker = makeWorker();
    const before = Date.now();

    for (const retryCount of [0, 1, 2, 3]) {
      const event = makePendingEvent({ id: `e-${retryCount}`, retryCount });
      mockPrisma.outboxEvent.findMany.mockResolvedValue([event]);
      mockPrisma.outboxEvent.update.mockResolvedValue({});
      mockRabbit.publish.mockRejectedValue(new Error('fail'));

      await worker.processOutbox();

      const updateCall = mockPrisma.outboxEvent.update.mock.calls.at(-1)![0];
      const nextRetry  = (updateCall.data.nextRetryAt as Date).getTime();
      const expectedMs = Math.pow(2, retryCount + 1) * 1_000;

      expect(nextRetry).toBeGreaterThanOrEqual(before + expectedMs - 50);
      expect(nextRetry).toBeLessThanOrEqual(before + expectedMs + 200);
    }
  });

  it('processes multiple events in a single tick', async () => {
    const worker = makeWorker();
    const events = [makePendingEvent({ id: 'e-1' }), makePendingEvent({ id: 'e-2' })];
    mockPrisma.outboxEvent.findMany.mockResolvedValue(events);
    mockPrisma.outboxEvent.update.mockResolvedValue({});
    mockRabbit.publish.mockResolvedValue(undefined);

    await worker.processOutbox();

    expect(mockRabbit.publish).toHaveBeenCalledTimes(2);
    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledTimes(2);
  });

  it('continues processing remaining events even if one fails', async () => {
    const worker = makeWorker();
    const events = [makePendingEvent({ id: 'e-1' }), makePendingEvent({ id: 'e-2' })];
    mockPrisma.outboxEvent.findMany.mockResolvedValue(events);
    mockPrisma.outboxEvent.update.mockResolvedValue({});
    mockRabbit.publish
      .mockRejectedValueOnce(new Error('fail'))
      .mockResolvedValueOnce(undefined);

    await worker.processOutbox();

    expect(mockPrisma.outboxEvent.update).toHaveBeenCalledTimes(2);
    const secondUpdate = mockPrisma.outboxEvent.update.mock.calls[1][0];
    expect(secondUpdate.data.status).toBe('PUBLISHED');
  });

  it('prevents concurrent runs — second call while first is running is a no-op', async () => {
    const worker = makeWorker();
    let resolve!: () => void;
    const blocker = new Promise<void>((r) => { resolve = r; });

    mockPrisma.outboxEvent.findMany.mockReturnValueOnce(blocker.then(() => []));

    const first  = worker.processOutbox();
    const second = worker.processOutbox();

    resolve();
    await Promise.all([first, second]);

    expect(mockPrisma.outboxEvent.findMany).toHaveBeenCalledTimes(1);
  });
});
