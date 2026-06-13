import { ClosureSchedulerService } from './closure-scheduler.service';

const mockPrisma = {
  store:        { update: jest.fn() },
  storeClosure: { findMany: jest.fn(), update: jest.fn() },
  outboxEvent:  { create: jest.fn() },
  $transaction: jest.fn(),
};

function makeScheduler() {
  return new ClosureSchedulerService(mockPrisma as never);
}

describe('ClosureSchedulerService — poll', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockPrisma.$transaction.mockImplementation(
      (fn: (tx: typeof mockPrisma) => Promise<unknown>) => fn(mockPrisma),
    );
  });

  describe('activateDueClosures', () => {
    it('does nothing when there are no due closures', async () => {
      mockPrisma.storeClosure.findMany.mockResolvedValue([]);

      await makeScheduler().poll();

      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('only marks closure ACTIVE when store is already TEMPORARILY_CLOSED', async () => {
      mockPrisma.storeClosure.findMany
        .mockResolvedValueOnce([{ id: 'c1', storeId: 's1', store: { status: 'TEMPORARILY_CLOSED' } }])
        .mockResolvedValueOnce([]);

      await makeScheduler().poll();

      expect(mockPrisma.storeClosure.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'ACTIVE' } }),
      );
      expect(mockPrisma.$transaction).not.toHaveBeenCalled();
    });

    it('sets store to TEMPORARILY_CLOSED and writes StoreStatusChanged outbox event', async () => {
      mockPrisma.storeClosure.findMany
        .mockResolvedValueOnce([{ id: 'c1', storeId: 's1', startDate: new Date(), store: { id: 's1', status: 'OPEN' } }])
        .mockResolvedValueOnce([]);

      await makeScheduler().poll();

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.store.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'TEMPORARILY_CLOSED' } }),
      );
      const outboxCall = mockPrisma.outboxEvent.create.mock.calls[0][0].data;
      expect(outboxCall.eventType).toBe('StoreStatusChanged');
      expect(outboxCall.payload.newStatus).toBe('TEMPORARILY_CLOSED');
      expect(outboxCall.payload.previousStatus).toBe('OPEN');
    });
  });

  describe('expireDueClosures', () => {
    it('sets store to OPEN, marks closure EXPIRED and writes both outbox events', async () => {
      mockPrisma.storeClosure.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ id: 'c1', storeId: 's1', endDate: new Date(), store: { id: 's1', status: 'TEMPORARILY_CLOSED' } }]);

      await makeScheduler().poll();

      expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
      expect(mockPrisma.store.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { status: 'OPEN' } }),
      );
      expect(mockPrisma.storeClosure.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: expect.objectContaining({ status: 'EXPIRED' }) }),
      );
      expect(mockPrisma.outboxEvent.create).toHaveBeenCalledTimes(2);

      const eventTypes = mockPrisma.outboxEvent.create.mock.calls.map(
        (c: [{ data: { eventType: string } }]) => c[0].data.eventType,
      );
      expect(eventTypes).toContain('StoreStatusChanged');
      expect(eventTypes).toContain('StoreClosureExpired');
    });
  });
});
