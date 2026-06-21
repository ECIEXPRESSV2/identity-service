import { Injectable, NotFoundException } from '@nestjs/common';
import { ClosureStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

@Injectable()
export class InternalService {
  constructor(private readonly prisma: PrismaService) {}

  async validateUser(userId: string) {
    const user = await this.prisma.user.findUnique({
      where:   { id: userId },
      include: { userRoles: { include: { role: true } } },
    });

    if (!user) {
      return { exists: false, isActive: false, roles: [], effectiveRole: null };
    }

    const roles        = user.userRoles.map((ur) => ur.role.name);
    const effectiveRole = this.resolveEffectiveRole(roles);
    const isActive      = user.status === 'ACTIVE';

    return { exists: true, isActive, roles, effectiveRole, userId: user.id, email: user.email };
  }

  async checkStoreAvailability(storeId: string, pickupAt?: Date) {
    const store = await this.prisma.store.findUnique({
      where:   { id: storeId },
      include: {
        schedules: { where: { isActive: true } },
        closures:  { where: { status: { in: [ClosureStatus.SCHEDULED, ClosureStatus.ACTIVE] } } },
      },
    });

    if (!store) throw new NotFoundException('Tienda no encontrada');

    if (!store.isActive) return { available: false, reason: 'INACTIVE' };

    const checkAt = pickupAt ?? new Date();

    const activeClosure = store.closures.find(
      (c) => c.startDate <= checkAt && c.endDate >= checkAt,
    );
    if (activeClosure) {
      return {
        available: false,
        reason:    'TEMPORARILY_CLOSED',
        endsAt:    activeClosure.endDate,
        closureReason: activeClosure.reason ?? null,
      };
    }

    const dayOfWeek  = checkAt.getDay();
    const timeStr    = `${String(checkAt.getHours()).padStart(2, '0')}:${String(checkAt.getMinutes()).padStart(2, '0')}`;
    const schedule   = store.schedules.find(
      (s) => s.dayOfWeek === dayOfWeek && s.openTime <= timeStr && timeStr < s.closeTime,
    );

    if (!schedule) {
      return { available: false, reason: 'OUT_OF_SCHEDULE' };
    }

    return { available: true, reason: null };
  }

  async getStoreStaff(storeId: string) {
    const store = await this.prisma.store.findUnique({ where: { id: storeId } });
    if (!store) throw new NotFoundException('Tienda no encontrada');

    const staff = await this.prisma.storeStaff.findMany({
      where:   { storeId, isActive: true },
      include: { user: { select: { id: true, email: true, fullName: true } } },
    });

    return staff.map((s) => ({
      userId:   s.userId,
      fullName: s.user.fullName,
      email:    s.user.email,
      role:     'VENDOR',
    }));
  }

  private resolveEffectiveRole(roles: string[]): string | null {
    if (roles.includes('ADMIN'))  return 'ADMIN';
    if (roles.includes('VENDOR')) return 'VENDOR';
    if (roles.includes('BUYER'))  return 'BUYER';
    return roles[0] ?? null;
  }
}
