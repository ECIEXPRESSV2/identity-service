import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { PrismaService } from '../prisma/prisma.service';

const logger = pino({ name: 'closure-scheduler' });

const POLL_MS = 30_000;

@Injectable()
export class ClosureSchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly prisma: PrismaService) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.poll(), POLL_MS);
    logger.info('Closure scheduler started (polling every 30s)');
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async poll(): Promise<void> {
    await Promise.all([this.activateDueClosures(), this.expireDueClosures()]);
  }

  private async activateDueClosures(): Promise<void> {
    const due = await this.prisma.storeClosure.findMany({
      where: { status: 'SCHEDULED', startDate: { lte: new Date() } },
      include: { store: true },
    });

    for (const closure of due) {
      if (closure.store.status === 'TEMPORARILY_CLOSED') {
        await this.prisma.storeClosure.update({
          where: { id: closure.id },
          data: { status: 'ACTIVE' },
        });
        continue;
      }

      const correlationId = randomUUID();
      const now = new Date().toISOString();

      await this.prisma.$transaction(async (tx) => {
        await tx.storeClosure.update({ where: { id: closure.id }, data: { status: 'ACTIVE' } });
        await tx.store.update({ where: { id: closure.storeId }, data: { status: 'TEMPORARILY_CLOSED' } });
        await tx.outboxEvent.create({
          data: {
            aggregateId:    closure.storeId,
            aggregateType:  'Store',
            eventType:      'StoreStatusChanged',
            eventVersion:   1,
            idempotencyKey: randomUUID(),
            payload: {
              eventType:    'StoreStatusChanged',
              eventVersion: 1,
              correlationId,
              occurredAt:   now,
              storeId:        closure.storeId,
              previousStatus: closure.store.status,
              newStatus:      'TEMPORARILY_CLOSED',
              reason:         'Cierre temporal programado',
            },
            status:     'PENDING',
            retryCount: 0,
          },
        });
      });

      logger.info({ storeId: closure.storeId, closureId: closure.id }, 'Store set to TEMPORARILY_CLOSED');
    }
  }

  private async expireDueClosures(): Promise<void> {
    const due = await this.prisma.storeClosure.findMany({
      where: { status: 'ACTIVE', endDate: { lte: new Date() } },
      include: { store: true },
    });

    for (const closure of due) {
      const correlationId = randomUUID();
      const now = new Date().toISOString();

      await this.prisma.$transaction(async (tx) => {
        await tx.storeClosure.update({
          where: { id: closure.id },
          data: { status: 'EXPIRED', processedAt: new Date() },
        });
        await tx.store.update({ where: { id: closure.storeId }, data: { status: 'OPEN' } });

        await tx.outboxEvent.create({
          data: {
            aggregateId:    closure.storeId,
            aggregateType:  'Store',
            eventType:      'StoreStatusChanged',
            eventVersion:   1,
            idempotencyKey: randomUUID(),
            payload: {
              eventType:    'StoreStatusChanged',
              eventVersion: 1,
              correlationId,
              occurredAt:   now,
              storeId:        closure.storeId,
              previousStatus: 'TEMPORARILY_CLOSED',
              newStatus:      'OPEN',
              reason:         'Reapertura tras cierre temporal',
            },
            status:     'PENDING',
            retryCount: 0,
          },
        });

        await tx.outboxEvent.create({
          data: {
            aggregateId:    closure.storeId,
            aggregateType:  'Store',
            eventType:      'StoreClosureExpired',
            eventVersion:   1,
            idempotencyKey: randomUUID(),
            payload: {
              eventType:    'StoreClosureExpired',
              eventVersion: 1,
              source:       'identity-admin-service',
              correlationId,
              occurredAt:   now,
              storeId: closure.storeId, closureId: closure.id,
            },
            status:     'PENDING',
            retryCount: 0,
          },
        });
      });

      logger.info({ storeId: closure.storeId, closureId: closure.id }, 'Closure expired — store set to OPEN');
    }
  }
}
