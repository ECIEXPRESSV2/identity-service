import {
  Injectable,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import { AuditAction, UserStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { SyncProfileDto } from './dto/sync-profile.dto';
import type { UpdateProfileDto } from './dto/update-profile.dto';

@Injectable()
export class UsersService {
  constructor(private readonly prisma: PrismaService) {}



  async syncProfile(
    firebaseUid: string,
    email: string,
    dto: SyncProfileDto,
    correlationId: string,
  ) {
    const existing = await this.prisma.user.findUnique({
      where: { firebaseUid },
      include: { userRoles: { include: { role: true } } },
    });
    if (existing) return this.formatUser(existing);

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
          aggregateId: user.id,
          aggregateType: 'User',
          eventType: 'UserRegistered',
          eventVersion: 1,
          payload: {
            eventType: 'UserRegistered',
            eventVersion: 1,
            correlationId,
            occurredAt: new Date().toISOString(),
            payload: {
              userId: user.id,
              firebaseUid: user.firebaseUid,
              email: user.email,
              fullName: user.fullName,
              systemRole: 'BUYER',
            },
          },
          status: 'PENDING',
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

    return this.formatUser({ ...newUser, userRoles: [{ role: buyerRole }] });
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
          aggregateId: userId,
          aggregateType: 'User',
          eventType: 'UserProfileUpdated',
          eventVersion: 1,
          payload: {
            eventType: 'UserProfileUpdated',
            eventVersion: 1,
            correlationId,
            occurredAt: new Date().toISOString(),
            payload: { userId, changedFields, newValues: dto },
          },
          status: 'PENDING',
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


  async updateStatus(
    targetId: string,
    status: UserStatus,
    actorId: string,
    correlationId: string,
  ) {
    const user = await this.prisma.user.findUnique({ where: { id: targetId } });
    if (!user) throw new NotFoundException('Usuario no encontrado');

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
          newValue: { status },
        },
      });

      if (status === UserStatus.INACTIVE || status === UserStatus.SUSPENDED) {
        await tx.outboxEvent.create({
          data: {
            aggregateId: targetId,
            aggregateType: 'User',
            eventType: 'UserDeactivated',
            eventVersion: 1,
            payload: {
              eventType: 'UserDeactivated',
              eventVersion: 1,
              correlationId,
              occurredAt: new Date().toISOString(),
              payload: { userId: targetId, reason: status },
            },
            status: 'PENDING',
            retryCount: 0,
          },
        });
      }

      return u;
    });

    return this.formatUser(updated);
  }


  private formatUser(user: {
    id: string;
    firebaseUid: string;
    email: string;
    fullName: string;
    phone?: string | null;
    avatarUrl?: string | null;
    status?: UserStatus;
    userRoles: { role: { name: string } }[];
  }) {
    return {
      userId: user.id,
      firebaseUid: user.firebaseUid,
      email: user.email,
      fullName: user.fullName,
      phone: user.phone ?? null,
      avatarUrl: user.avatarUrl ?? null,
      status: user.status,
      roles: user.userRoles.map((ur) => ur.role.name),
    };
  }
}
