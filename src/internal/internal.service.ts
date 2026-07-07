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

  /**
   * Enriquecimiento de identidad para el API Gateway: dado el firebaseUid (que el
   * gateway ya extrajo de un token Firebase YA validado), traduce al identificador
   * local del usuario + su rol y su tienda, para que el gateway los inyecte como
   * headers (x-user-id / x-user-role / x-user-store) a los servicios downstream.
   *
   * - `roles`: mismo formato y filtro que `/auth/validate` (vía FirebaseAuthGuard.loadUser):
   *   solo roles ACTIVOS (expiresAt null o futuro). Difiere a propósito de `validateUser`,
   *   que no filtra expiración; aquí se replica `/auth/validate` para no divergir.
   * - `storeId`: tienda sobre la que el usuario puede operar. Un usuario opera como DUEÑO
   *   (Store.ownerId) o como STAFF activo (StoreStaff.isActive). Esto refleja la misma
   *   lógica OR que usa StoresService.getMyStores(). El negocio garantiza una sola tienda
   *   por vendedor, pero el modelo NO impone esa unicidad (StoreStaff.@@unique es sobre el
   *   par storeId+userId, no sobre userId solo; y un dueño puede tener N tiendas).
   *   Si hay más de una, se devuelve la primera de forma determinista (propiedad primero,
   *   luego staff por assignedAt asc) y no se falla.
   *   TODO(store-unicidad): añadir constraint en BD o validación en StoresService si el
   *   negocio quiere garantizar formalmente la unicidad (hoy es solo regla no forzada).
   *
   * Lanza NotFoundException (404) si el firebaseUid no tiene perfil local todavía
   * (caso típico: el usuario validó token en Firebase pero aún no ejecutó sync-profile).
   */
  async resolveByFirebaseUid(firebaseUid: string) {
    const user = await this.prisma.user.findUnique({
      where:   { firebaseUid },
      include: {
        userRoles: {
          where:   { OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }] },
          include: { role: true },
        },
        ownedStores: {
          orderBy: { createdAt: 'asc' },
          select:  { id: true },
        },
        staffEntries: {
          where:   { isActive: true },
          select:  { storeId: true },
          orderBy: { assignedAt: 'asc' },
        },
      },
    });

    if (!user) {
      throw new NotFoundException({
        code:    'USER_NOT_FOUND',
        message:
          'No existe un usuario local para el firebaseUid proporcionado. ' +
          'Probablemente validó token en Firebase pero aún no ejecutó sync-profile.',
      });
    }

    // Propiedad tiene precedencia; si no es dueño, se usa la primera asignación de staff.
    const storeId = user.ownedStores[0]?.id ?? user.staffEntries[0]?.storeId ?? null;

    return {
      userId:  user.id,
      roles:   user.userRoles.map((ur) => ur.role.name),
      storeId,
      // status se incluye para que el gateway pueda rechazar usuarios no ACTIVE
      // (INACTIVE / SUSPENDED) sin un segundo viaje a Identity.
      status:  user.status,
    };
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

  /**
   * Perfil público mínimo de un usuario (nombre + avatar) para que otros servicios
   * (Order, en el chat comprador-vendedor) muestren "con quién se está hablando" sin
   * necesitar el permiso `user:read` que protege `GET /users/:id`.
   */
  async getUserProfile(userId: string) {
    const user = await this.prisma.user.findUnique({
      where:  { id: userId },
      select: { fullName: true, avatarUrl: true },
    });
    if (!user) throw new NotFoundException('Usuario no encontrado');
    return { fullName: user.fullName, avatarUrl: user.avatarUrl };
  }

  /**
   * Miembros de la tienda que pueden operarla (y ver sus chats): el staff activo MÁS el
   * dueño. El dueño se incluye SIEMPRE aunque no tenga fila en `store_staff` —de lo
   * contrario un dueño no podría ver los chats de su propia tienda (Order valida el acceso
   * consultando esta lista). El staff va primero (para que Order elija un vendedor de
   * atención por defecto antes que al dueño); el dueño se añade al final si no está ya.
   */
  async getStoreStaff(storeId: string) {
    const store = await this.prisma.store.findUnique({
      where:   { id: storeId },
      include: { owner: { select: { id: true, email: true, fullName: true } } },
    });
    if (!store) throw new NotFoundException('Tienda no encontrada');

    const staff = await this.prisma.storeStaff.findMany({
      where:   { storeId, isActive: true },
      include: { user: { select: { id: true, email: true, fullName: true } } },
    });

    const members = staff.map((s) => ({
      userId:   s.userId,
      fullName: s.user.fullName,
      email:    s.user.email,
      role:     'VENDOR',
    }));

    if (store.owner && !members.some((m) => m.userId === store.owner!.id)) {
      members.push({
        userId:   store.owner.id,
        fullName: store.owner.fullName,
        email:    store.owner.email,
        role:     'OWNER',
      });
    }

    return members;
  }

  private resolveEffectiveRole(roles: string[]): string | null {
    if (roles.includes('ADMIN'))  return 'ADMIN';
    if (roles.includes('VENDOR')) return 'VENDOR';
    if (roles.includes('BUYER'))  return 'BUYER';
    return roles[0] ?? null;
  }
}
