# Event Catalog — identity-service

Exchange compartido: `eciexpress_events` (topic)
Fuente de todos los eventos: Transactional Outbox → worker BullMQ → RabbitMQ
Binding pattern sugerido para consumidores: `identity.#`

---

## Envelope común (todos los eventos publicados)

Los campos de negocio van al mismo nivel que los metadatos — no existe un campo `payload` anidado.

```json
{
  "eventType": "UserRegistered",
  "eventVersion": 1,
  "source": "identity-admin-service",
  "correlationId": "<uuid-v4>",
  "occurredAt": "<ISO8601>",
  "idempotencyKey": "<uuid-v4>",
  "userId": "...",
  "..."
}
```

---

## Eventos consumidos (entrada)

> **MVP:** Identity no consume eventos de RabbitMQ. Todas las validaciones cruzadas
> (p. ej. pedidos activos antes de cerrar una tienda) se resuelven de forma síncrona
> mediante la API interna de Order & Communication.


---

## Eventos publicados (salida)

### Dominio Usuario

| Routing key | Cuándo se emite | Campos de negocio |
|---|---|---|
| `identity.user.registered` | Primer login / sync-profile exitoso | `userId`, `firebaseUid`, `email`, `fullName`, `systemRole` |
| `identity.user.profile_updated` | `PATCH /profile` exitoso | `userId`, `changedFields[]`, `newValues` |
| `identity.user.deactivated` | Estado cambia a `INACTIVE` o `SUSPENDED` | `userId`, `reason` |
| `identity.user.role_changed` | Asignación o revocación de rol a un usuario | `userId`, `roleId`, `roleName`, `action`, `performedBy` |

### Dominio Roles

| Routing key | Cuándo se emite | Campos de negocio |
|---|---|---|
| `identity.role.updated` | `PUT /roles/:id/permissions` exitoso | `roleId`, `permissionIds[]`, `performedBy` |

### Dominio Tienda

| Routing key | Cuándo se emite | Campos de negocio |
|---|---|---|
| `identity.store.created` | `POST /stores` exitoso | `storeId`, `ownerId`, `name`, `type`, `location`, `isActive` |
| `identity.store.updated` | `PATCH /stores/:id` exitoso | `storeId`, `changedFields[]`, `performedBy` |
| `identity.store.status_changed` | Cambio de estado manual **o** job automático al expirar cierre | `storeId`, `previousStatus`, `newStatus`, `reason`, `performedBy`* |
| `identity.store.schedule_changed` | `POST/PATCH/DELETE /stores/:id/schedules` | `storeId`, `scheduleId`, `action`, `dayOfWeek`, `performedBy` |
| `identity.store.temporarily_closed` | `POST /stores/:id/closures` exitoso | `storeId`, `closureId`, `startDate`, `endDate`, `reason`, `performedBy` |
| `identity.store.closure_cancelled` | `DELETE /stores/:id/closures/:id` exitoso | `storeId`, `closureId`, `performedBy` |
| `identity.store.closure_expired` | Job BullMQ al vencer un cierre temporal | `storeId`, `closureId` |
| `identity.store.staff_changed` | `POST/DELETE /stores/:id/staff` exitoso | `storeId`, `userId`, `action`, `performedBy` |

> \* `performedBy` es `null` cuando el cambio lo genera el job automático (expiración de cierre).

---

## Quién consume cada evento

| Routing key | Consumidor | Para qué |
|---|---|---|
| `identity.user.registered` | Notification | Enviar email de bienvenida |
| `identity.user.registered` | Reporting | Analytics de registros |
| `identity.user.deactivated` | Order & Communication | Invalidar sesiones activas del usuario |
| `identity.user.deactivated` | Reporting | Analytics |
| `identity.store.created` | Product Management | Crear espacio de catálogo para la tienda |
| `identity.store.status_changed` | Order & Communication | Bloquear nuevos pedidos si la tienda cerró |
| `identity.store.status_changed` | Notification | Alertar al vendedor del cambio de estado |
| `identity.store.*` | Reporting | Analytics operativos generales |

---

## Valores de enums relevantes

| Campo | Valores posibles |
|---|---|
| `systemRole` | `BUYER` \| `VENDOR` \| `ADMIN` \| `ANALYST` |
| `previousStatus` / `newStatus` | `OPEN` \| `CLOSED` \| `TEMPORARILY_CLOSED` |
| `type` (tienda) | `CAFETERIA` \| `PAPELERIA` \| `RESTAURANTE` |
| `action` (rol) | `assigned` \| `revoked` |
| `action` (staff) | `assigned` \| `removed` |
| `action` (schedule) | `upserted` \| `updated` \| `deleted` |
