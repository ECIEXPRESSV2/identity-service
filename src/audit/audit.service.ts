import { Injectable } from '@nestjs/common';
import { AuditAction } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  async listAuditLogs(filters: {
    actorId?:    string;
    targetId?:   string;
    targetType?: string;
    action?:     AuditAction;
    from?:       Date;
    to?:         Date;
  }, page: number, limit: number) {
    const where: Prisma.AuditLogWhereInput = {};

    if (filters.actorId)    where.actorId    = filters.actorId;
    if (filters.targetId)   where.targetId   = filters.targetId;
    if (filters.targetType) where.targetType = filters.targetType;
    if (filters.action)     where.action     = filters.action;
    if (filters.from || filters.to) {
      where.createdAt = {
        ...(filters.from ? { gte: filters.from } : {}),
        ...(filters.to   ? { lte: filters.to   } : {}),
      };
    }

    const skip = (page - 1) * limit;
    const [total, logs] = await Promise.all([
      this.prisma.auditLog.count({ where }),
      this.prisma.auditLog.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip,
        take: limit,
      }),
    ]);

    return {
      data: logs,
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }
}
