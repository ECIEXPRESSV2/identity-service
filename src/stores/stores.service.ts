import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, StoreStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { ClosureSchedulerService } from './closure-scheduler.service';
import type { CreateStoreDto } from './dto/create-store.dto';
import type { UpdateStoreDto } from './dto/update-store.dto';
import type { UpdateStoreStatusDto } from './dto/update-store-status.dto';
import type { CreateScheduleDto } from './dto/create-schedule.dto';
import type { CreateClosureDto } from './dto/create-closure.dto';

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
          aggregateId:   created.id,
          aggregateType: 'Store',
          eventType:     'StoreCreated',
          eventVersion:  1,
          payload: {
            eventType:    'StoreCreated',
            eventVersion: 1,
            correlationId,
            occurredAt:   new Date().toISOString(),
            payload: {
              storeId:  created.id,
              ownerId,
              name:     created.name,
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
          newValue:   { name: created.name, location: created.location } as never,
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
          aggregateId:   id,
          aggregateType: 'Store',
          eventType:     'StoreStatusChanged',
          eventVersion:  1,
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
    _correlationId: string,
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
      where: { storeId, endDate: { gt: new Date() } },
      orderBy: { startDate: 'asc' },
    });
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
