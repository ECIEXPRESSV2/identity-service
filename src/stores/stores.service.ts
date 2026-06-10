import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import { AuditAction, ClosureStatus, StoreStatus, StoreType } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { ClosureSchedulerService } from './closure-scheduler.service';
import type { CreateStoreDto } from './dto/create-store.dto';
import type { UpdateStoreDto } from './dto/update-store.dto';
import type { UpdateStoreStatusDto } from './dto/update-store-status.dto';
import type { CreateScheduleDto } from './dto/create-schedule.dto';
import type { UpdateScheduleDto } from './dto/update-schedule.dto';
import type { CreateClosureDto } from './dto/create-closure.dto';
import type { AssignStaffDto } from './dto/assign-staff.dto';

@Injectable()
export class StoresService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly scheduler: ClosureSchedulerService,
  ) {}

  async createStore(ownerId: string, dto: CreateStoreDto, correlationId: string) {
    const store = await this.prisma.$transaction(async (tx) => {
      const created = await tx.store.create({
        data: { ownerId, ...dto, status: StoreStatus.OPEN, isActive: true },
      });

      await tx.outboxEvent.create({
        data: {
          aggregateId:    created.id,
          aggregateType:  'Store',
          eventType:      'StoreCreated',
          eventVersion:   1,
          idempotencyKey: randomUUID(),
          payload: {
            eventType:    'StoreCreated',
            eventVersion: 1,
            correlationId,
            occurredAt:   new Date().toISOString(),
            payload: {
              storeId:  created.id,
              ownerId,
              name:     created.name,
              type:     created.type,
              location: created.location,
              status:   'OPEN',
            },
          },
          status:     'PENDING',
          retryCount: 0,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId:    ownerId,
          targetId:   created.id,
          targetType: 'Store',
          action:     AuditAction.STORE_CREATED,
          newValue:   { name: created.name, type: created.type, location: created.location } as never,
        },
      });

      return created;
    });

    return this.formatStore(store);
  }

  async listStores() {
    const stores = await this.prisma.store.findMany({
      where: { isActive: true },
      orderBy: { createdAt: 'desc' },
    });
    return stores.map(this.formatStore);
  }

  async findById(id: string) {
    const store = await this.prisma.store.findUnique({
      where: { id },
      include: { schedules: { orderBy: { dayOfWeek: 'asc' } } },
    });
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return { ...this.formatStore(store), schedules: store.schedules };
  }

  async updateStore(
    id: string,
    dto: UpdateStoreDto,
    actorId: string,
    isAdmin: boolean,
  ) {
    const store = await this.loadStore(id);
    this.assertOwnership(store.ownerId, actorId, isAdmin);

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.store.update({ where: { id }, data: dto });

      await tx.auditLog.create({
        data: {
          actorId,
          targetId:   id,
          targetType: 'Store',
          action:     AuditAction.STORE_UPDATED,
          oldValue:   this.pickChangedOld(store, dto) as never,
          newValue:   dto as never,
        },
      });

      return u;
    });

    return this.formatStore(updated);
  }

  async updateStatus(
    id: string,
    dto: UpdateStoreStatusDto,
    actorId: string,
    isAdmin: boolean,
    correlationId: string,
  ) {
    const store = await this.loadStore(id);
    this.assertOwnership(store.ownerId, actorId, isAdmin);

    if (store.status === dto.status) {
      return this.formatStore(store);
    }

    const newStatus = dto.status as StoreStatus;

    const updated = await this.prisma.$transaction(async (tx) => {
      const u = await tx.store.update({
        where: { id },
        data: { status: newStatus },
      });

      await tx.outboxEvent.create({
        data: {
          aggregateId:    id,
          aggregateType:  'Store',
          eventType:      'StoreStatusChanged',
          eventVersion:   1,
          idempotencyKey: randomUUID(),
          payload: {
            eventType:    'StoreStatusChanged',
            eventVersion: 1,
            correlationId,
            occurredAt:   new Date().toISOString(),
            payload: {
              storeId:        id,
              previousStatus: store.status,
              newStatus,
              reason:         dto.reason ?? null,
            },
          },
          status:     'PENDING',
          retryCount: 0,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId,
          targetId:   id,
          targetType: 'Store',
          action:     AuditAction.STORE_UPDATED,
          oldValue:   { status: store.status } as never,
          newValue:   { status: newStatus } as never,
        },
      });

      return u;
    });

    return this.formatStore(updated);
  }

  async upsertSchedule(
    storeId: string,
    dto: CreateScheduleDto,
    actorId: string,
    isAdmin: boolean,
  ) {
    const store = await this.loadStore(storeId);
    this.assertOwnership(store.ownerId, actorId, isAdmin);

    if (dto.openTime >= dto.closeTime) {
      throw new BadRequestException('openTime debe ser anterior a closeTime');
    }

    return this.prisma.storeSchedule.upsert({
      where: { storeId_dayOfWeek: { storeId, dayOfWeek: dto.dayOfWeek } },
      update: {
        openTime:  dto.openTime,
        closeTime: dto.closeTime,
        isActive:  dto.isActive,
      },
      create: { storeId, ...dto },
    });
  }

  async getSchedules(storeId: string) {
    await this.loadStore(storeId);
    return this.prisma.storeSchedule.findMany({
      where: { storeId },
      orderBy: { dayOfWeek: 'asc' },
    });
  }

  async createClosure(
    storeId: string,
    dto: CreateClosureDto,
    actorId: string,
    correlationId: string,
  ) {
    await this.loadStore(storeId);

    if (dto.startDate <= new Date()) {
      throw new BadRequestException('startDate debe ser una fecha futura');
    }
    if (dto.endDate <= dto.startDate) {
      throw new BadRequestException('endDate debe ser posterior a startDate');
    }

    const overlap = await this.prisma.storeClosure.findFirst({
      where: {
        storeId,
        status: { in: ['SCHEDULED', 'ACTIVE'] },
        AND: [
          { startDate: { lt: dto.endDate } },
          { endDate:   { gt: dto.startDate } },
        ],
      },
    });
    if (overlap) {
      throw new ConflictException('Ya existe un cierre que se solapa con el rango indicado');
    }

    const closure = await this.prisma.$transaction(async (tx) => {
      const c = await tx.storeClosure.create({
        data: {
          storeId,
          startDate: dto.startDate,
          endDate:   dto.endDate,
          reason:    dto.reason ?? null,
          createdBy: actorId,
        },
      });

      await tx.auditLog.create({
        data: {
          actorId,
          targetId:   c.id,
          targetType: 'StoreClosure',
          action:     AuditAction.STORE_CLOSURE_CREATED,
          newValue:   { storeId, startDate: dto.startDate, endDate: dto.endDate } as never,
        },
      });

      return c;
    });

    await this.scheduler.scheduleClose(storeId, closure.startDate, closure.id);
    await this.scheduler.scheduleReopen(storeId, closure.endDate, closure.id);

    return closure;
  }

  async listClosures(storeId: string) {
    await this.loadStore(storeId);
    return this.prisma.storeClosure.findMany({
      where: {
        storeId,
        status: { in: ['SCHEDULED', 'ACTIVE'] },
        endDate: { gt: new Date() },
      },
      orderBy: { startDate: 'asc' },
    });
  }

  // ─── Public / Buyer endpoints ────────────────────────────────────────────────

  async listAvailable(type?: StoreType) {
    const stores = await this.prisma.store.findMany({
      where:   { isActive: true, ...(type ? { type } : {}) },
      include: { schedules: { where: { isActive: true } } },
      orderBy: { name: 'asc' },
    });
    return stores.map((s) => ({ ...this.formatStore(s), schedules: s.schedules }));
  }

  async getPublicDetail(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where:   { id: storeId, isActive: true },
      include: { schedules: { where: { isActive: true }, orderBy: { dayOfWeek: 'asc' } } },
    });
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return { ...this.formatStore(store), schedules: store.schedules };
  }

  async getMyStores(userId: string) {
    const stores = await this.prisma.store.findMany({
      where: {
        isActive: true,
        OR: [
          { ownerId: userId },
          { staff: { some: { userId, isActive: true } } },
        ],
      },
      include: { schedules: { where: { isActive: true } } },
      orderBy: { name: 'asc' },
    });
    return stores.map((s) => ({ ...this.formatStore(s), schedules: s.schedules }));
  }

  // ─── Schedule update / delete ────────────────────────────────────────────────

  async updateSchedule(
    storeId:    string,
    scheduleId: string,
    dto:        UpdateScheduleDto,
    actorId:    string,
    isAdmin:    boolean,
  ) {
    const store = await this.loadStore(storeId);
    this.assertOwnership(store.ownerId, actorId, isAdmin);

    const schedule = await this.prisma.storeSchedule.findFirst({
      where: { id: scheduleId, storeId },
    });
    if (!schedule) throw new NotFoundException('Horario no encontrado');

    const openTime  = dto.openTime  ?? schedule.openTime;
    const closeTime = dto.closeTime ?? schedule.closeTime;
    if (openTime >= closeTime) {
      throw new BadRequestException('openTime debe ser anterior a closeTime');
    }

    return this.prisma.storeSchedule.update({
      where: { id: scheduleId },
      data:  { openTime, closeTime, isActive: dto.isActive ?? schedule.isActive },
    });
  }

  async deleteSchedule(
    storeId:    string,
    scheduleId: string,
    actorId:    string,
    isAdmin:    boolean,
  ) {
    const store = await this.loadStore(storeId);
    this.assertOwnership(store.ownerId, actorId, isAdmin);

    const schedule = await this.prisma.storeSchedule.findFirst({
      where: { id: scheduleId, storeId },
    });
    if (!schedule) throw new NotFoundException('Horario no encontrado');

    await this.prisma.storeSchedule.delete({ where: { id: scheduleId } });
    return { message: 'Horario eliminado' };
  }

  // ─── Closure cancel ──────────────────────────────────────────────────────────

  async cancelClosure(storeId: string, closureId: string, actorId: string) {
    await this.loadStore(storeId);

    const closure = await this.prisma.storeClosure.findFirst({
      where: { id: closureId, storeId },
    });
    if (!closure) throw new NotFoundException('Cierre temporal no encontrado');
    if (closure.status === ClosureStatus.EXPIRED || closure.status === ClosureStatus.CANCELLED) {
      throw new BadRequestException('Solo se pueden cancelar cierres activos o programados');
    }

    await this.prisma.$transaction(async (tx) => {
      await tx.storeClosure.update({
        where: { id: closureId },
        data:  { status: ClosureStatus.CANCELLED, cancelledBy: actorId, cancelledAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          targetId:   closureId,
          targetType: 'StoreClosure',
          action:     AuditAction.STORE_CLOSURE_CANCELLED,
          oldValue:   { status: closure.status } as never,
          newValue:   { status: ClosureStatus.CANCELLED } as never,
        },
      });
    });

    return { message: 'Cierre temporal cancelado' };
  }

  // ─── Staff management ────────────────────────────────────────────────────────

  async assignStaff(storeId: string, dto: AssignStaffDto, actorId: string) {
    await this.loadStore(storeId);

    const user = await this.prisma.user.findUnique({
      where:   { id: dto.userId },
      include: { userRoles: { include: { role: true } } },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');

    const hasOperativeRole = user.userRoles.some(
      (ur) => ur.role.name === 'VENDOR' || ur.role.name === 'ADMIN',
    );
    if (!hasOperativeRole) {
      throw new UnprocessableEntityException(
        'El usuario debe tener rol VENDOR o ADMIN para ser asignado como staff',
      );
    }

    const existing = await this.prisma.storeStaff.findUnique({
      where: { storeId_userId: { storeId, userId: dto.userId } },
    });
    if (existing?.isActive) {
      throw new ConflictException('El usuario ya está asignado a este punto de venta');
    }

    await this.prisma.$transaction(async (tx) => {
      if (existing) {
        await tx.storeStaff.update({
          where: { id: existing.id },
          data:  { isActive: true, assignedBy: actorId, assignedAt: new Date(), removedBy: null, removedAt: null },
        });
      } else {
        await tx.storeStaff.create({
          data: { storeId, userId: dto.userId, assignedBy: actorId },
        });
      }
      await tx.auditLog.create({
        data: {
          actorId,
          targetId:   storeId,
          targetType: 'Store',
          action:     AuditAction.STORE_STAFF_ASSIGNED,
          newValue:   { userId: dto.userId } as never,
        },
      });
    });

    return { storeId, userId: dto.userId, message: 'Vendedor asignado correctamente' };
  }

  async removeStaff(storeId: string, staffUserId: string, actorId: string) {
    await this.loadStore(storeId);

    const entry = await this.prisma.storeStaff.findUnique({
      where: { storeId_userId: { storeId, userId: staffUserId } },
    });
    if (!entry?.isActive) throw new NotFoundException('El vendedor no está asignado a este punto de venta');

    await this.prisma.$transaction(async (tx) => {
      await tx.storeStaff.update({
        where: { id: entry.id },
        data:  { isActive: false, removedBy: actorId, removedAt: new Date() },
      });
      await tx.auditLog.create({
        data: {
          actorId,
          targetId:   storeId,
          targetType: 'Store',
          action:     AuditAction.STORE_STAFF_REMOVED,
          oldValue:   { userId: staffUserId } as never,
        },
      });
    });

    return { message: 'Vendedor removido del punto de venta' };
  }

  // ─── Helpers ────────────────────────────────────────────────────────────────

  private async loadStore(id: string) {
    const store = await this.prisma.store.findUnique({ where: { id } });
    if (!store) throw new NotFoundException('Tienda no encontrada');
    return store;
  }

  private assertOwnership(ownerId: string, actorId: string, isAdmin: boolean): void {
    if (!isAdmin && ownerId !== actorId) {
      throw new ForbiddenException('Solo el dueño de la tienda o un administrador puede realizar esta acción');
    }
  }

  private pickChangedOld(
    store: Record<string, unknown>,
    dto: UpdateStoreDto,
  ): Record<string, unknown> {
    return Object.fromEntries(
      Object.keys(dto)
        .filter((k) => dto[k as keyof UpdateStoreDto] !== undefined)
        .map((k) => [k, store[k]]),
    );
  }

  private formatStore(store: {
    id: string;
    ownerId: string;
    name: string;
    type: StoreType;
    description?: string | null;
    location: string;
    imageUrl?: string | null;
    status: StoreStatus;
    isActive: boolean;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id:          store.id,
      ownerId:     store.ownerId,
      name:        store.name,
      type:        store.type,
      description: store.description ?? null,
      location:    store.location,
      imageUrl:    store.imageUrl ?? null,
      status:      store.status,
      isActive:    store.isActive,
      createdAt:   store.createdAt,
      updatedAt:   store.updatedAt,
    };
  }
}
