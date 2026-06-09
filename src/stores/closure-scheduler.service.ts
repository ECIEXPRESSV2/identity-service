import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import { Queue, Worker, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import pino from 'pino';
import { PrismaService } from '../prisma/prisma.service';

const logger = pino({ name: 'closure-scheduler' });

const QUEUE_NAME = 'store-closures';

interface ClosureJobData {
  storeId:       string;
  closureId:     string;
  correlationId: string;
}

@Injectable()
export class ClosureSchedulerService implements OnApplicationBootstrap, OnApplicationShutdown {
  private queue:  Queue  | null = null;
  private worker: Worker | null = null;

  constructor(private readonly prisma: PrismaService) {}

  async onApplicationBootstrap(): Promise<void> {
    const url = process.env['REDIS_URL'];
    if (!url) {
      logger.warn('REDIS_URL not configured — closure scheduling disabled');
      return;
    }

    try {
      const connection = new Redis(url, { maxRetriesPerRequest: null });
      this.queue  = new Queue(QUEUE_NAME, { connection });
      this.worker = new Worker<ClosureJobData>(
        QUEUE_NAME,
        (job) => this.processJob(job),
        { connection },
      );
      logger.info('Closure scheduler started');
    } catch (err) {
      logger.error({ err }, 'Failed to start closure scheduler — scheduling disabled');
    }
  }

  async onApplicationShutdown(): Promise<void> {
    await this.worker?.close();
    await this.queue?.close();
  }

  async scheduleClose(storeId: string, startDate: Date, closureId: string): Promise<void> {
    if (!this.queue) return;
    const delay = Math.max(0, startDate.getTime() - Date.now());
    await this.queue.add(
      'close-store',
      { storeId, closureId, correlationId: randomUUID() },
      { delay, jobId: `close-${closureId}` },
    );
    logger.info({ storeId, closureId, delay }, 'Scheduled close-store job');
  }

  async scheduleReopen(storeId: string, endDate: Date, closureId: string): Promise<void> {
    if (!this.queue) return;
    const delay = Math.max(0, endDate.getTime() - Date.now());
    await this.queue.add(
      'reopen-store',
      { storeId, closureId, correlationId: randomUUID() },
      { delay, jobId: `reopen-${closureId}` },
    );
    logger.info({ storeId, closureId, delay }, 'Scheduled reopen-store job');
  }

  private async processJob(job: Job<ClosureJobData>): Promise<void> {
    const { storeId, correlationId } = job.data;
    const isClose  = job.name === 'close-store';
    const newStatus = isClose ? 'TEMPORARILY_CLOSED' : 'OPEN';

    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) {
      logger.warn({ storeId, jobName: job.name }, 'Store not found — skipping job');
      return;
    }

    if (store.status === newStatus) {
      logger.info({ storeId, status: newStatus }, 'Store already in target status — skipping');
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.store.update({ where: { id: storeId }, data: { status: newStatus } });

      await tx.outboxEvent.create({
        data: {
          aggregateId:   storeId,
          aggregateType: 'Store',
          eventType:     'StoreStatusChanged',
          eventVersion:  1,
          payload: {
            eventType:    'StoreStatusChanged',
            eventVersion: 1,
            correlationId,
            occurredAt:   new Date().toISOString(),
            payload: {
              storeId,
              previousStatus: store.status,
              newStatus,
              reason: isClose
                ? 'Cierre temporal programado'
                : 'Reapertura tras cierre temporal',
            },
          },
          status:     'PENDING',
          retryCount: 0,
        },
      });
    });

    logger.info({ storeId, newStatus, jobName: job.name }, 'Store status updated by closure job');
  }
}
