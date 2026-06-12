import {
  Injectable,
  OnApplicationBootstrap,
  OnApplicationShutdown,
} from '@nestjs/common';
import type { OutboxEvent } from '@prisma/client';
import pino from 'pino';
import { PrismaService } from '../prisma/prisma.service';
import { RabbitMQService } from './rabbitmq.service';

const logger = pino({ name: 'outbox-worker' });

const MAX_RETRIES  = 5;
const BATCH_SIZE   = 50;
const POLL_MS      = 5_000;

/**
 * Derives the RabbitMQ routing key from aggregateType and eventType.
 * Strips the aggregateType prefix from eventType, then converts to snake_case.
 *
 * Examples:
 *   ("User", "UserRegistered")      → "identity.user.registered"
 *   ("User", "UserProfileUpdated")  → "identity.user.profile_updated"
 *   ("Store", "StoreStatusChanged") → "identity.store.status_changed"
 */
export function toRoutingKey(aggregateType: string, eventType: string): string {
  const suffix = eventType.startsWith(aggregateType)
    ? eventType.slice(aggregateType.length)
    : eventType;

  const snake = suffix.replace(
    /([A-Z])/g,
    (char, _, offset: number) => (offset === 0 ? char.toLowerCase() : `_${char.toLowerCase()}`),
  );

  return `identity.${aggregateType.toLowerCase()}.${snake}`;
}

@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnApplicationShutdown {
  private timer: ReturnType<typeof setInterval> | null = null;
  private isProcessing = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly rabbit: RabbitMQService,
  ) {}

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.processOutbox(), POLL_MS);
  }

  onApplicationShutdown(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async processOutbox(): Promise<void> {
    if (this.isProcessing) return;
    if (!this.rabbit.isConnected) return;

    this.isProcessing = true;
    try {
      const events = await this.prisma.outboxEvent.findMany({
        where: {
          status: 'PENDING',
          OR: [{ nextRetryAt: null }, { nextRetryAt: { lte: new Date() } }],
        },
        orderBy: { createdAt: 'asc' },
        take: BATCH_SIZE,
      });

      for (const event of events) {
        await this.publishEvent(event);
      }
    } catch (err) {
      logger.error({ err }, 'Outbox poll cycle failed');
    } finally {
      this.isProcessing = false;
    }
  }

  private async publishEvent(event: OutboxEvent): Promise<void> {
    const routingKey = toRoutingKey(event.aggregateType, event.eventType);

    const envelope = {
      ...(event.payload as object),
      source:        'identity-admin-service',
      idempotencyKey: event.idempotencyKey,
    };

    try {
      await this.rabbit.publish(routingKey, envelope);
      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: { status: 'PUBLISHED', publishedAt: new Date() },
      });
      logger.info(
        { eventId: event.id, routingKey, eventType: event.eventType },
        'Outbox event published',
      );
    } catch (err) {
      const newCount = event.retryCount + 1;
      const failed   = newCount >= MAX_RETRIES;

      await this.prisma.outboxEvent.update({
        where: { id: event.id },
        data: {
          retryCount: newCount,
          lastError:  (err as Error).message,
          status:     failed ? 'FAILED' : 'PENDING',
          nextRetryAt: failed ? null : new Date(Date.now() + Math.pow(2, newCount) * 1_000),
        },
      });

      if (failed) {
        logger.error({ eventId: event.id, routingKey, retryCount: newCount, err }, 'Outbox event permanently failed');
      } else {
        logger.warn({ eventId: event.id, routingKey, retryCount: newCount }, 'Outbox event publish failed — scheduled for retry');
      }
    }
  }
}
