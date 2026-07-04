import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, UserStatus } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import type { SyncProfileDto } from './dto/sync-profile.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}



  async listUsers(filters: {
    search?:   string;
    status?:   UserStatus;
    role?:     string;
    sortBy?:   'createdAt' | 'lastLoginAt';
  }, page: number, limit: number) {
    const where: Prisma.UserWhereInput = {};

    if (filters.search) {
      where.OR = [
        { email:    { contains: filters.search, mode: 'insensitive' } },
        { fullName: { contains: filters.search, mode: 'insensitive' } },
      ];
    }
    if (filters.status) where.status = filters.status;
    if (filters.role) {
      where.userRoles = { some: { role: { name: { equals: filters.role, mode: 'insensitive' } } } };
    }

    const orderBy: Prisma.UserOrderByWithRelationInput[] =
      filters.sortBy === 'lastLoginAt'
        ? [{ lastLoginAt: 'desc' }, { createdAt: 'desc' }]
        : [{ createdAt: 'desc' }];

    const skip = (page - 1) * limit;
    const [total, users] = await Promise.all([
      this.prisma.user.count({ where }),
      this.prisma.user.findMany({
        where,
        include: { userRoles: { include: { role: true } } },
        orderBy,
        skip,
        take: limit,
      }),
    ]);

    return {
      data:  users.map((u) => this.formatUser(u)),
      meta: { total, page, limit, totalPages: Math.ceil(total / limit) },
    };
  }

  async syncProfile(
    firebaseUid: string,
    email: string,
    dto: SyncProfileDto,
    correlationId: string,
  ) {
    if (!dto.phone) {
      // phone es obligatorio solo para usuarios nuevos; se valida aquí
      // porque el DTO lo mantiene opcional para re-sincronizaciones de usuarios existentes
      const alreadyExists = await this.prisma.user.findUnique({ where: { firebaseUid }, select: { id: true } });
      if (!alreadyExists) {
        throw new BadRequestException('El número de teléfono es obligatorio para el registro');
      }
    }

    const existing = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: { userRoles: { include: { role: true } } },
    });
    if (existing) {
      const updated = await this.prisma.user.update({
        where: { id: existing.id },
        data: { lastLoginAt: new Date() },
        include: { userRoles: { include: { role: true } } },
      });
      return { created: false, ...this.formatUser(updated) };
    }

    const buyerRole = await this.prisma.role.findFirst({
      where: { systemRole: 'BUYER' },
    });
    if (!buyerRole) {
      throw new InternalServerErrorException(
        'Rol BUYER no encontrado — ejecuta el seed: pnpm db:seed',
      );
    }

    const newUser = await this.prisma.$transaction(async (tx) => {
      const user = await tx.user.create({
        data: {
          firebaseUid,
          email,
          fullName: dto.fullName,
          phone: dto.phone ?? null,
          status: UserStatus.ACTIVE,
        },
      });

      await tx.userRole.create({
        data: { userId: user.id, roleId: buyerRole.id },
      });

      await tx.outboxEvent.create({
        data: {
          aggregateId:    user.id,
          aggregateType:  'User',
          eventType:      'UserRegistered',
          eventVersion:   1,
          idempotencyKey: randomUUID(),
          payload: {
            eventType:    'UserRegistered',
            eventVersion: 1,
            correlationId,
            occurredAt:   new Date().toISOString(),
            userId:      user.id,
            firebaseUid: user.firebaseUid,
            email:       user.email,
            fullName:    user.fullName,
            systemRole:  'BUYER',
          },
          status:     'PENDING',
          retryCount: 0,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: null,
          targetId: user.id,
          targetType: 'User',
          action: AuditAction.USER_CREATED,
          newValue: { firebaseUid, email, fullName: dto.fullName },
        },
      });

      return user;
    });

    return { created: true, ...this.formatUser({ ...newUser, userRoles: [{ role: buyerRole }] }) };
  }


  async findById(userId: string) {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return this.formatUser(user);
  }

  async findByFirebaseUid(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return this.formatUser(user);
  }


  async updateProfile(
    userId: string,
    dto: UpdateProfileDto,
    correlationId: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    const changedFields = (Object.keys(dto) as (keyof UpdateProfileDto)[]).filter(
      (k) => dto[k] !== undefined,
    );

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: userId },
        data: { ...dto },
        include: { userRoles: { include: { role: true } } },
      });

      await tx.outboxEvent.create({
        data: {
          aggregateId:    userId,
          aggregateType:  'User',
          eventType:      'UserProfileUpdated',
          eventVersion:   1,
          idempotencyKey: randomUUID(),
          payload: {
            eventType:    'UserProfileUpdated',
            eventVersion: 1,
            correlationId,
            occurredAt:   new Date().toISOString(),
            userId, changedFields, newValues: dto,
          },
          status:     'PENDING',
          retryCount: 0,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId: userId,
          targetId: userId,
          targetType: 'User',
          action: AuditAction.USER_UPDATED,
          oldValue: Object.fromEntries(changedFields.map((f) => [f, user[f as keyof typeof user]])) as never,
          newValue: dto as never,
        },
      });

      return u;
    });

    return this.formatUser(updated);
  }

  async updatePhone(userId: string, phone: string, correlationId: string) {
    return this.updateProfile(userId, { phone }, correlationId);
  }


  async updateStatus(
    targetId: string,
    status: UserStatus,
    actorId: string,
    correlationId: string,
    reason?: string,
  ) {
    if (actorId === targetId && status !== UserStatus.ACTIVE) {
      throw new ForbiddenException('Un administrador no puede desactivarse a sí mismo');
    }

    const user = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    if (status === UserStatus.ACTIVE && user.status === UserStatus.INACTIVE) {
      throw new BadRequestException('Una cuenta eliminada no puede reactivarse');
    }

    if (status !== UserStatus.ACTIVE && !reason?.trim()) {
      throw new BadRequestException('La justificacion es obligatoria para eliminar o suspender una cuenta');
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.user.update({
        where: { id: targetId },
        data: { status },
        include: { userRoles: { include: { role: true } } },
      });

      const auditAction =
        status === UserStatus.ACTIVE ? AuditAction.USER_UPDATED : AuditAction.USER_DEACTIVATED;

      await tx.auditLog.create({
        data: {
          actorId,
          targetId,
          targetType: 'User',
          action: auditAction,
          oldValue: { status: user.status },
          newValue: reason?.trim() ? { status, reason: reason.trim() } : { status },
        },
      });

      if (status === UserStatus.INACTIVE || status === UserStatus.SUSPENDED) {
        await tx.outboxEvent.create({
          data: {
            aggregateId:    targetId,
            aggregateType:  'User',
            eventType:      'UserDeactivated',
            eventVersion:   1,
            idempotencyKey: randomUUID(),
            payload: {
              eventType:    'UserDeactivated',
              eventVersion: 1,
              correlationId,
              occurredAt:   new Date().toISOString(),
              userId: targetId,
              reason: reason?.trim() || status,
            },
            status:     'PENDING',
            retryCount: 0,
          },
        });
      }

      return u;
    });

    return this.formatUser(updated);
  }


  async bulkUpdateStatus(
    userIds: string[],
    status: UserStatus,
    actorId: string,
    correlationId: string,
    reason?: string,
  ) {
    if (status !== UserStatus.ACTIVE && userIds.includes(actorId)) {
      throw new ForbiddenException('Un administrador no puede cambiar su propio estado');
    }

    if (status !== UserStatus.ACTIVE && !reason?.trim()) {
      throw new BadRequestException('La justificacion es obligatoria para eliminar o suspender cuentas');
    }

    if (status === UserStatus.ACTIVE) {
      const deletedCount = await this.prisma.user.count({
        where: { id: { in: userIds }, status: UserStatus.INACTIVE },
      });
      if (deletedCount > 0) {
        throw new BadRequestException('Una cuenta eliminada no puede reactivarse');
      }
    }

    const results = await Promise.all(
      userIds.map((id) => this.updateStatus(id, status, actorId, correlationId, reason)),
    );
    return { updated: results.length, users: results };
  }

  private formatUser(user: {
    id: string;
    firebaseUid: string;
    email: string;
    fullName: string;
    phone?: string | null;
    avatarUrl?: string | null;
    status?: UserStatus;
    lastLoginAt?: Date | null;
    createdAt?: Date | null;
    userRoles: { role: { name: string } }[];
  }) {
    return {
      id: user.id,
      userId: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone ?? null,
      avatarUrl: user.avatarUrl ?? null,
      status: user.status,
      lastLoginAt: user.lastLoginAt?.toISOString() ?? null,
      createdAt: user.createdAt?.toISOString() ?? null,
      roles: user.userRoles.map((ur) => ur.role.name),
    };
  }
}
