import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import type { Prisma } from '@prisma/client';

@Injectable()
export class OutboxService {
  constructor(private readonly prisma: PrismaService) {}

  /** Write an outbox event inside an existing transaction. */
  buildCreateEvent(
    aggregateId: string,
    aggregateType: string,
    eventType: string,
    payload: Record<string, unknown>,
  ): Prisma.OutboxEventCreateInput {
    return {
      aggregateId,
      aggregateType,
      eventType,
      eventVersion: 1,
      payload: payload as Prisma.InputJsonValue,
      status: 'PENDING',
      retryCount: 0,
    };
  }
}
