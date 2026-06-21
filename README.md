# Identity & Administration Service

Microservicio de identidad y administración de la plataforma **ECIxpress** — sistema de pedidos anticipados en el campus de la Escuela Colombiana de Ingeniería Julio Garavito.

> **Responsable:** Elizabeth Correa  
> **Puerto por defecto:** `3001`  
> **Swagger UI:** `http://localhost:3001/api`  
> **Spec JSON:** `http://localhost:3001/api-json`

---

## Tabla de contenidos

1. [¿Qué hace este servicio?](#1-qué-hace-este-servicio)
2. [Rol en la arquitectura ECIxpress](#2-rol-en-la-arquitectura-eciexpress)
3. [Flujo de autenticación](#3-flujo-de-autenticación)
4. [Stack tecnológico](#4-stack-tecnológico)
5. [Estructura de carpetas](#5-estructura-de-carpetas)
6. [Modelo de datos](#6-modelo-de-datos)
7. [Roles y permisos](#7-roles-y-permisos)
8. [API Endpoints](#8-api-endpoints)
9. [Eventos publicados a RabbitMQ](#9-eventos-publicados-a-rabbitmq)
10. [Eventos consumidos](#10-eventos-consumidos)
11. [Endpoints internos (para otros microservicios)](#11-endpoints-internos-para-otros-microservicios)
12. [Patrones de diseño implementados](#12-patrones-de-diseño-implementados)
13. [Variables de entorno](#13-variables-de-entorno)
14. [Cómo ejecutar el proyecto](#14-cómo-ejecutar-el-proyecto)
15. [Base de datos — migraciones y seed](#15-base-de-datos--migraciones-y-seed)
16. [Tests](#16-tests)
17. [Reglas de negocio clave](#17-reglas-de-negocio-clave)
18. [Headers obligatorios](#18-headers-obligatorios)

---

## 1. ¿Qué hace este servicio?

Este microservicio es la **fuente de verdad de identidad y acceso** de toda la plataforma ECIxpress. Gestiona:

- **Identidad:** perfiles de usuario vinculados a Firebase Auth por `firebaseUid`, sin almacenar contraseñas.
- **RBAC:** roles (`BUYER`, `VENDOR`, `ADMIN`, `ANALYST`) y permisos granulares por recurso.
- **Administración de puntos de venta:** CRUD de stores, horarios regulares por día de semana y cierres temporales programados.
- **Eventos de dominio:** publicación confiable al bus RabbitMQ mediante patrón Transactional Outbox.
- **Auditoría:** log append-only de acciones sensibles.

### Lo que NO hace

| Responsabilidad | Servicio dueño |
|---|---|
| Guardar contraseñas o generar tokens | Firebase Auth |
| Catálogo de productos, inventario | Product Management |
| Crear o gestionar pedidos | Order & Communication |
| Pagos, recargas, reembolsos | Financial |
| Generar/validar QR de retiro | Fulfillment |
| Enviar emails, push, WhatsApp | Notification |
| Reportes y dashboards | Reporting & Analytics |

---

## 2. Rol en la arquitectura ECIxpress

```
┌─────────────────────────────────────────────────────────────────┐
│                        API Gateway / BFF                         │
│              (puerta de entrada única — REST HTTPS)              │
└──────────┬──────────┬──────────┬──────────┬────────────────────┘
           │          │          │          │
    ┌──────▼───┐ ┌────▼────┐ ┌──▼──────┐ ┌▼──────────┐
    │ Identity  │ │ Product │ │  Order  │ │ Financial │
    │ & Admin   │ │  Mgmt   │ │ & Chat  │ │           │
    └──────┬────┘ └────┬────┘ └──┬──────┘ └┬──────────┘
           │           │         │          │
           └───────────┴─────────┴──────────┘
                              │ RabbitMQ (bus de eventos)
           ┌───────────┬──────┴──────┬──────────────┐
    ┌──────▼──┐  ┌─────▼───┐  ┌─────▼────┐
    │Fulfillmt│  │Notificat│  │Reporting │
    │  (QR)   │  │         │  │Analytics │
    └─────────┘  └─────────┘  └──────────┘
```

**Comunicación:**
- **Síncrona REST:** el API Gateway llama a `GET /auth/validate` para verificar cada request del cliente.
- **REST interno:** Order y Product llaman a `/internal/stores/:id/availability` antes de crear pedidos.
- **Asíncrona RabbitMQ:** este servicio publica eventos de dominio; Notification, Order y Reporting los consumen.

---

## 3. Flujo de autenticación

```
Cliente (Mobile/Web)
  │
  ├─► Firebase Auth SDK (Google o email/password)
  │   → obtiene Firebase ID Token (JWT firmado por Google)
  │
  ▼
API Gateway
  │   Authorization: Bearer <firebaseIdToken>
  ▼
Identity Service
  │   1. Verifica token con Firebase Admin SDK
  │   2. Extrae firebaseUid → busca User en PostgreSQL
  │   3. Carga roles y permisos desde DB local
  │   4. Retorna { userId, roles, permissions, effectiveRole }
  ▼
API Gateway ─► reenvía request + contexto de usuario al microservicio destino
```

**Regla de oro:** Las credenciales nunca tocan nuestra base de datos. Firebase Auth es la única fuente de verdad de autenticación. Nuestra DB guarda el perfil de negocio vinculado por `firebaseUid`.

### Primer login — sincronización de perfil

```
POST /auth/sync-profile
Authorization: Bearer <firebaseIdToken>
{ "fullName": "María García" }
```

El cliente debe llamar este endpoint **una sola vez** tras el primer login. Si el perfil ya existe, es idempotente (retorna `200`). Si es nuevo, retorna `201` y publica `UserRegistered`.

---

## 4. Stack tecnológico

| Capa | Tecnología | Versión |
|---|---|---|
| Runtime | Node.js | 20 LTS |
| Framework | NestJS + TypeScript (strict) | 11 |
| ORM | Prisma | 7 |
| Base de datos | PostgreSQL (Neon en producción) | — |
| Auth externo | Firebase Admin SDK | 13 |
| Bus de eventos | RabbitMQ (amqplib) | — |
| Validación | Zod | 4 |
| Logging | Pino (JSON estructurado) | 10 |
| Documentación | Swagger / OpenAPI | — |
| Tests | Jest + Supertest | 30 |
| Package manager | pnpm | — |

---

## 5. Estructura de carpetas

```
identity-service/
├── prisma/
│   ├── schema.prisma          # Esquema autoritativo de la DB
│   ├── seed.ts                # Roles, permisos y asignaciones iniciales
│   └── migrations/            # Historial de migraciones SQL
│
├── src/
│   ├── main.ts                # Bootstrap: NestJS + Swagger + CORS
│   ├── app.module.ts          # Módulo raíz
│   │
│   ├── auth/                  # Validación de token para el API Gateway
│   │   ├── auth.controller.ts # GET /auth/validate
│   │   ├── auth.service.ts
│   │   └── auth.module.ts
│   │
│   ├── users/                 # Gestión de perfiles de usuario
│   │   ├── users.controller.ts  # POST /auth/sync-profile, GET/PUT /users/me, PATCH /users/:id/status
│   │   ├── users.service.ts
│   │   ├── users.module.ts
│   │   ├── users.service.spec.ts
│   │   └── dto/
│   │       ├── sync-profile.dto.ts
│   │       ├── update-profile.dto.ts
│   │       └── update-status.dto.ts
│   │
│   ├── roles/                 # RBAC — roles y permisos
│   │   ├── roles.controller.ts  # CRUD roles, asignar/revocar, permisos
│   │   ├── roles.service.ts
│   │   ├── roles.module.ts
│   │   ├── roles.service.spec.ts
│   │   └── dto/
│   │       └── assign-role.dto.ts
│   │
│   ├── stores/                # Puntos de venta, horarios y cierres
│   │   ├── stores.controller.ts  # CRUD stores, schedules, closures, staff
│   │   ├── stores.service.ts
│   │   ├── stores.module.ts
│   │   ├── stores.service.spec.ts
│   │   ├── closure-scheduler.service.ts   # Job: activa/expira cierres temporales
│   │   ├── closure-scheduler.service.spec.ts
│   │   └── dto/
│   │       ├── create-store.dto.ts
│   │       ├── update-store.dto.ts
│   │       ├── update-store-status.dto.ts
│   │       ├── create-schedule.dto.ts
│   │       ├── update-schedule.dto.ts
│   │       ├── create-closure.dto.ts
│   │       └── assign-staff.dto.ts
│   │
│   ├── internal/              # Endpoints para otros microservicios
│   │   ├── internal.controller.ts  # GET /internal/users/:id/validate
│   │   │                           # GET /internal/stores/:id/availability
│   │   ├── internal.service.ts
│   │   └── internal.module.ts
│   │
│   ├── audit/                 # Log de auditoría append-only
│   │   ├── audit.controller.ts  # GET /audit-logs
│   │   ├── audit.service.ts
│   │   └── audit.module.ts
│   │
│   ├── outbox/                # Transactional Outbox → RabbitMQ
│   │   ├── outbox.service.ts     # Escribe eventos en la misma tx
│   │   ├── outbox.worker.ts      # Poll cada 5s, publica a RabbitMQ
│   │   ├── rabbitmq.service.ts   # Conexión y publicación amqplib
│   │   ├── outbox.worker.spec.ts
│   │   └── outbox.module.ts
│   │
│   ├── prisma/
│   │   ├── prisma.service.ts  # Singleton del cliente Prisma
│   │   └── prisma.module.ts
│   │
│   ├── config/
│   │   └── firebase.config.ts  # Inicialización Firebase Admin SDK
│   │
│   └── common/
│       ├── common.module.ts
│       ├── decorators/
│       │   ├── current-user.decorator.ts    # @CurrentUser()
│       │   ├── public.decorator.ts          # @Public() — salta el guard
│       │   └── require-permission.decorator.ts  # @RequirePermission('store:write')
│       ├── guards/
│       │   ├── firebase-auth.guard.ts       # Valida token + carga perfil local
│       │   └── permissions.guard.ts         # Verifica permisos requeridos
│       ├── interceptors/
│       │   └── correlation-id.interceptor.ts  # Propaga X-Correlation-Id
│       ├── filters/
│       │   └── http-exception.filter.ts
│       ├── pipes/
│       │   └── zod-validation.pipe.ts
│       └── services/
│           └── permissions-cache.service.ts  # Caché in-memory de permisos por usuario
│
├── test/
│   └── app.e2e-spec.ts
│
├── .env.example
├── Dockerfile
├── nest-cli.json
├── tsconfig.json
└── package.json
```

---

## 6. Modelo de datos

### Diagrama de relaciones

```
DOMINIO IDENTITY
─────────────────────────────────────────────────────────────────

users                          roles
├── id (PK, UUID)              ├── id (PK, UUID)
├── firebaseUid (UNIQUE)       ├── name (UNIQUE)
├── email (UNIQUE)             ├── systemRole (enum nullable)
├── fullName                   ├── isSystem (bool) ← protegidos
├── phone (nullable)           ├── description
├── avatarUrl (nullable)       ├── createdAt
├── status (UserStatus)        └── updatedAt
├── emailVerified (bool)
├── lastLoginAt (nullable)     permissions
├── createdAt                  ├── id (PK, UUID)
└── updatedAt                  ├── resource   e.g. "store"
                               ├── action     e.g. "write"
user_roles (join)              ├── description
├── id (PK, UUID)              └── createdAt
├── userId (FK → users)        [UNIQUE: resource + action]
├── roleId (FK → roles)
├── assignedAt                 role_permissions (join)
├── assignedBy (userId)        ├── id (PK, UUID)
└── expiresAt (nullable)       ├── roleId (FK → roles)
                               ├── permissionId (FK → permissions)
                               └── grantedAt
                               [UNIQUE: roleId + permissionId]

DOMINIO ADMINISTRACIÓN
─────────────────────────────────────────────────────────────────

stores
├── id (PK, UUID)
├── ownerId (FK → users)
├── name (UNIQUE)
├── type (StoreType)
├── description (nullable)
├── location
├── imageUrl (nullable)
├── status (StoreStatus)
├── isActive (bool)
├── createdAt
└── updatedAt

store_staff (join)             store_schedules
├── id (PK, UUID)              ├── id (PK, UUID)
├── storeId (FK → stores)      ├── storeId (FK → stores)
├── userId (FK → users)        ├── dayOfWeek (0=Dom..6=Sáb)
├── assignedBy (userId)        ├── openTime  "HH:MM"
├── assignedAt                 ├── closeTime "HH:MM"
├── isActive (bool)            ├── isActive
├── removedBy (userId)         ├── createdAt
└── removedAt (nullable)       └── updatedAt
[UNIQUE: storeId + userId]     [UNIQUE: storeId + dayOfWeek]

store_closures
├── id (PK, UUID)
├── storeId (FK → stores)
├── startDate
├── endDate
├── reason (nullable, max 200)
├── status (ClosureStatus)
├── createdBy (userId)
├── cancelledBy (userId nullable)
├── cancelledAt (nullable)
├── processedAt (nullable)
├── createdAt
└── updatedAt

TRANSVERSAL
─────────────────────────────────────────────────────────────────

outbox_events                  audit_logs
├── id (PK, UUID)              ├── id (PK, UUID)
├── aggregateId                ├── actorId (FK → users, nullable)
├── aggregateType              ├── targetId
├── eventType                  ├── targetType
├── eventVersion (default 1)   ├── action (AuditAction enum)
├── payload (JSON)             ├── oldValue (JSON nullable)
├── status (OutboxStatus)      ├── newValue (JSON nullable)
├── retryCount                 ├── ipAddress (nullable)
├── lastError (nullable)       ├── userAgent (nullable)
├── idempotencyKey (UNIQUE)    └── createdAt
├── nextRetryAt (nullable)
├── createdAt
└── publishedAt (nullable)
```

### Enums

```typescript
enum SystemRole    { BUYER, VENDOR, ADMIN, ANALYST }
enum UserStatus    { ACTIVE, INACTIVE, SUSPENDED }
enum StoreType     { CAFETERIA, PAPELERIA, RESTAURANTE }
enum StoreStatus   { OPEN, CLOSED, TEMPORARILY_CLOSED }
enum ClosureStatus { SCHEDULED, ACTIVE, EXPIRED, CANCELLED }
enum OutboxStatus  { PENDING, PUBLISHED, FAILED }
enum AuditAction   {
  USER_CREATED, USER_UPDATED, USER_DEACTIVATED,
  ROLE_ASSIGNED, ROLE_REVOKED,
  STORE_CREATED, STORE_UPDATED,
  STORE_CLOSURE_CREATED, STORE_CLOSURE_CANCELLED,
  STORE_STAFF_ASSIGNED, STORE_STAFF_REMOVED,
  PERMISSION_GRANTED, PERMISSION_REVOKED
}
```

---

## 7. Roles y permisos

### Jerarquía de roles

```
ADMIN > VENDOR > BUYER
```

Cuando un usuario tiene varios roles, su `effectiveRole` es el de mayor jerarquía.

### Permisos por rol (configurados en el seed)

| Permiso | ADMIN | VENDOR | ANALYST | BUYER |
|---|:---:|:---:|:---:|:---:|
| `user:read` | ✅ | — | ✅ | — |
| `user:write` | ✅ | — | — | — |
| `role:read` | ✅ | — | — | — |
| `role:write` | ✅ | — | — | — |
| `role:assign` | ✅ | — | — | — |
| `role:revoke` | ✅ | — | — | — |
| `store:read` | ✅ | ✅ | ✅ | — |
| `store:write` | ✅ | ✅ | — | — |
| `store:close` | ✅ | — | — | — |
| `store:staff` | ✅ | — | — | — |
| `audit:read` | ✅ | — | ✅ | — |

> **Nota para el API Gateway:** el endpoint `GET /auth/validate` retorna el array completo de permisos del usuario. El gateway puede usarlos para construir el contexto de seguridad sin hacer consultas adicionales a la DB.

### Cómo el guard resuelve la autorización

1. `FirebaseAuthGuard` verifica el token con Firebase Admin SDK.
2. Busca el usuario local en PostgreSQL por `firebaseUid`.
3. Carga sus roles y permisos (con caché in-memory).
4. Inyecta `request.user = { userId, firebaseUid, email, roles, permissions, correlationId }`.
5. `PermissionsGuard` compara `@RequirePermission('...')` contra `request.user.permissions`.

---

## 8. API Endpoints

Todos los endpoints protegidos requieren:
```
Authorization: Bearer <Firebase ID Token>
```

### Auth

| Método | Ruta | Auth | Descripción |
|---|---|---|---|
| `GET` | `/auth/validate` | Firebase Token | Valida token y retorna contexto de seguridad. Usado por el API Gateway. |

### Usuarios

| Método | Ruta | Auth / Permiso | Descripción |
|---|---|---|---|
| `POST` | `/auth/sync-profile` | Firebase Token | Crea o sincroniza perfil local en primer login. Body: `{ fullName, phone? }`. Publica `UserRegistered`. |
| `GET` | `/users/me` | Firebase Token | Perfil del usuario autenticado con roles. |
| `PUT` | `/users/me` | Firebase Token | Actualiza `fullName`, `phone`, `avatarUrl`. Publica `UserProfileUpdated`. |
| `GET` | `/users` | `user:read` | Lista paginada de usuarios. Query: `page`, `limit`, `search`, `status`, `role`. |
| `GET` | `/users/:id` | `user:read` | Perfil completo de cualquier usuario. |
| `PATCH` | `/users/:id/status` | `user:deactivate` | Cambia estado a `ACTIVE`, `INACTIVE` o `SUSPENDED`. Publica `UserDeactivated` si aplica. |

### Roles y permisos

| Método | Ruta | Auth / Permiso | Descripción |
|---|---|---|---|
| `GET` | `/roles` | `role:read` | Lista todos los roles del sistema. |
| `POST` | `/roles` | `role:write` | Crea rol personalizado (no de sistema). |
| `GET` | `/permissions` | `role:read` | Lista permisos. Query: `resource`. |
| `GET` | `/roles/:roleId/permissions` | `role:read` | Permisos actuales de un rol. |
| `PUT` | `/roles/:roleId/permissions` | `role:write` | Reemplaza permisos de un rol. Body: `{ permissionIds[] }`. Es idempotente. |
| `POST` | `/users/:id/roles` | `role:assign` | Asigna rol a usuario. Body: `{ roleId }`. |
| `DELETE` | `/users/:id/roles/:roleId` | `role:revoke` | Revoca rol de usuario. |

### Stores (puntos de venta)

| Método | Ruta | Auth / Permiso | Descripción |
|---|---|---|---|
| `GET` | `/stores` | Público | Lista todas las tiendas activas. |
| `GET` | `/stores/available` | Público | Lista tiendas activas. Query: `type` (`CAFETERIA` \| `PAPELERIA` \| `RESTAURANTE`). |
| `GET` | `/stores/my` | Firebase Token | Tiendas donde el usuario es dueño o staff activo. |
| `GET` | `/stores/:id` | Público | Detalle de tienda con horarios. |
| `GET` | `/stores/:id/public` | Público | Detalle público de tienda activa con horarios. |
| `POST` | `/stores` | `store:write` | Crea tienda. Body: `{ name, type, location, description?, imageUrl? }`. Publica `StoreCreated`. |
| `PUT` | `/stores/:id` | `store:write` | Actualiza datos de tienda (solo dueño o ADMIN). |
| `PATCH` | `/stores/:id/status` | `store:write` | Cambia estado (`OPEN` \| `CLOSED`). Publica `StoreStatusChanged`. |

### Horarios

| Método | Ruta | Auth / Permiso | Descripción |
|---|---|---|---|
| `GET` | `/stores/:id/schedules` | Público | Horarios por día de la semana. |
| `POST` | `/stores/:id/schedules` | `store:write` | Upsert de horario para un día. Body: `{ dayOfWeek, openTime, closeTime, isActive }`. |
| `PATCH` | `/stores/:id/schedules/:scheduleId` | `store:write` | Actualiza horario existente. |
| `DELETE` | `/stores/:id/schedules/:scheduleId` | `store:write` | Elimina horario. |

### Cierres temporales

| Método | Ruta | Auth / Permiso | Descripción |
|---|---|---|---|
| `POST` | `/stores/:id/closures` | `store:close` | Programa cierre temporal. Body: `{ startDate, endDate, reason? }`. Publica `StoreTemporarilyClosed`. |
| `GET` | `/stores/:id/closures` | `store:read` | Lista cierres futuros (endDate > now). |
| `DELETE` | `/stores/:id/closures/:closureId` | `store:close` | Cancela cierre. Publica `StoreClosureCancelled`. |

### Staff (vendedores asignados)

| Método | Ruta | Auth / Permiso | Descripción |
|---|---|---|---|
| `POST` | `/stores/:id/staff` | `store:staff` | Asigna vendedor. Body: `{ userId }`. El usuario debe tener rol `VENDOR` o `ADMIN`. |
| `DELETE` | `/stores/:id/staff/:userId` | `store:staff` | Remueve vendedor. |

### Auditoría

| Método | Ruta | Auth / Permiso | Descripción |
|---|---|---|---|
| `GET` | `/audit-logs` | `audit:read` | Log paginado. Query: `actorId`, `targetType`, `targetId`, `action`, `from`, `to`, `page`, `limit`. |

---

## 9. Eventos publicados a RabbitMQ

Este servicio **nunca publica directamente a RabbitMQ**. Siempre escribe en `outbox_events` dentro de la misma transacción Prisma, y un worker hace polling cada 5 segundos para publicar al exchange `eciexpress_events` con el routing key derivado automáticamente.

### Formato del envelope (todos los eventos)

Los campos de negocio van al mismo nivel que los metadatos — no hay campo `payload` anidado.

```json
{
  "eventType": "UserRegistered",
  "eventVersion": 1,
  "source": "identity-admin-service",
  "correlationId": "<uuid-v4>",
  "occurredAt": "<ISO8601>",
  "idempotencyKey": "<uuid-v4>",
  "userId": "...",
  "email": "..."
}
```

### Tabla de eventos

| Evento | Routing key | Disparado por | Campos de negocio |
|---|---|---|---|
| `UserRegistered` | `identity.user.registered` | `POST /auth/sync-profile` (primer login) | `userId`, `firebaseUid`, `email`, `fullName`, `systemRole` |
| `UserProfileUpdated` | `identity.user.profile_updated` | `PUT /users/me` | `userId`, `changedFields[]`, `newValues` |
| `UserDeactivated` | `identity.user.deactivated` | `PATCH /users/:id/status` → INACTIVE/SUSPENDED | `userId`, `reason` |
| `UserRoleChanged` | `identity.user.role_changed` | `POST/DELETE /users/:id/roles` | `userId`, `roleId`, `roleName`, `action` (`assigned`\|`revoked`), `performedBy` |
| `RoleUpdated` | `identity.role.updated` | `PUT /roles/:id/permissions` | `roleId`, `permissionIds[]`, `performedBy` |
| `StoreCreated` | `identity.store.created` | `POST /stores` | `storeId`, `ownerId`, `name`, `type`, `location`, `isActive` |
| `StoreUpdated` | `identity.store.updated` | `PUT /stores/:id` | `storeId`, `changedFields[]`, `performedBy` |
| `StoreStatusChanged` | `identity.store.status_changed` | `PATCH /stores/:id/status` o job automático | `storeId`, `previousStatus`, `newStatus`, `reason`, `performedBy?` |
| `StoreScheduleChanged` | `identity.store.schedule_changed` | `POST/PATCH/DELETE /stores/:id/schedules` | `storeId`, `scheduleId`, `action` (`upserted`\|`updated`\|`deleted`), `dayOfWeek`, `performedBy` |
| `StoreTemporarilyClosed` | `identity.store.temporarily_closed` | `POST /stores/:id/closures` | `storeId`, `closureId`, `startDate`, `endDate`, `reason`, `performedBy` |
| `StoreClosureCancelled` | `identity.store.closure_cancelled` | `DELETE /stores/:id/closures/:id` | `storeId`, `closureId`, `performedBy` |
| `StoreClosureExpired` | `identity.store.closure_expired` | Job automático al vencer cierre | `storeId`, `closureId` |
| `StoreStaffChanged` | `identity.store.staff_changed` | `POST/DELETE /stores/:id/staff` | `storeId`, `userId`, `action` (`assigned`\|`removed`), `performedBy` |

### ¿Quién consume cada evento?

| Routing key | Consumidores | Para qué |
|---|---|---|
| `identity.user.registered` | **Notification** | Email de bienvenida |
| `identity.user.registered` | **Reporting** | Analytics de registros |
| `identity.user.deactivated` | **Order** | Invalidar sesiones activas |
| `identity.user.deactivated` | **Reporting** | Analytics |
| `identity.store.created` | **Product Management** | Crear espacio de catálogo |
| `identity.store.status_changed` | **Order** | Bloquear nuevos pedidos si cierra |
| `identity.store.status_changed` | **Notification** | Alertar vendedor de cambio de estado |
| `identity.store.*` | **Reporting** | Analytics operativos |

### Convención para derivar el routing key

```
identity.<aggregateType_lower>.<event_suffix_snake_case>

Ejemplos:
  ("User", "UserRegistered")      → identity.user.registered
  ("User", "UserProfileUpdated")  → identity.user.profile_updated
  ("Store", "StoreStatusChanged") → identity.store.status_changed
```

El worker lo deriva automáticamente de `aggregateType` y `eventType` en `outbox_events`. No se configura manualmente.

### Comportamiento del worker ante fallos de RabbitMQ

- Si RabbitMQ está caído, el evento queda en `PENDING` — **no se pierde**.
- Reintentos con backoff exponencial: `2^retryCount` segundos entre intentos.
- Después de 5 reintentos fallidos, el evento pasa a `FAILED` para revisión manual.
- El worker es idempotente: si un evento ya fue publicado y el worker lo vuelve a leer, no se duplica (el `idempotencyKey` único en DB lo previene).

---

## 10. Eventos consumidos

**Este servicio no consume eventos de RabbitMQ** en el MVP actual.

Recibe toda su información por llamadas REST directas desde el API Gateway y desde los clientes. Si en el futuro se necesita sincronizar estado de pedidos activos para bloquear cierres de tiendas, se podría consumir:

| Evento | Origen | Uso potencial |
|---|---|---|
| `OrderCreated` | Order & Communication | Saber si un store tiene pedidos activos |
| `OrderCompleted` | Order & Communication | Liberar conteo de pedidos activos |
| `OrderCancelled` | Order & Communication | Liberar conteo de pedidos activos |

---

## 11. Endpoints internos (para otros microservicios)

Estos endpoints están pensados para consumo **servicio a servicio**. No requieren Firebase Token (usan `@Public()`), pero en producción deben protegerse a nivel de red o con un header de servicio interno.

### Validar usuario

```
GET /internal/users/:userId/validate
```

Respuesta:
```json
{
  "exists": true,
  "isActive": true,
  "roles": ["VENDOR"],
  "effectiveRole": "VENDOR",
  "userId": "uuid",
  "email": "vendedor@eci.edu.co"
}
```

Casos:
- Usuario no existe → `{ "exists": false, "isActive": false, "roles": [], "effectiveRole": null }`
- Usuario suspendido → `{ "exists": true, "isActive": false, ... }`

### Validar disponibilidad de tienda

```
GET /internal/stores/:storeId/availability?pickupAt=2026-06-17T10:00:00Z
```

`pickupAt` es opcional. Si se omite, valida disponibilidad para el momento actual.

Respuesta cuando está disponible:
```json
{
  "available": true,
  "reason": null,
  "endsAt": null,
  "closureReason": null
}
```

Respuesta cuando no está disponible:
```json
{
  "available": false,
  "reason": "TEMPORARILY_CLOSED",
  "endsAt": "2026-06-17T18:00:00.000Z",
  "closureReason": "Mantenimiento de equipos"
}
```

Valores posibles de `reason`:
- `INACTIVE` — la tienda está desactivada.
- `TEMPORARILY_CLOSED` — cierre temporal vigente para el `pickupAt` dado.
- `OUT_OF_SCHEDULE` — el `pickupAt` no cae dentro de ningún horario configurado.

Respuesta cuando la tienda no existe: `HTTP 404`.

---

## 12. Patrones de diseño implementados

### Transactional Outbox

Nunca se publica directamente a RabbitMQ desde la lógica de negocio. El evento y el cambio de estado siempre van en la misma transacción Prisma:

```typescript
await prisma.$transaction(async (tx) => {
  const user = await tx.user.create({ data: { ... } });
  await tx.outboxEvent.create({
    data: {
      aggregateId:    user.id,
      aggregateType:  'User',
      eventType:      'UserRegistered',
      payload:        { correlationId, userId: user.id, ... },
      idempotencyKey: crypto.randomUUID(),
    }
  });
});
// El worker publicará a RabbitMQ de forma asíncrona
```

### Correlation ID

Cada request tiene un `correlationId` (UUID v4) que se propaga por:
- Header de respuesta: `X-Correlation-Id`
- Todos los logs de Pino: `{ correlationId, ... }`
- Todos los eventos del Outbox: campo `correlationId` en el payload

Si el cliente no envía `X-Correlation-Id`, el guard lo genera automáticamente.

### Caché de permisos

Los permisos por usuario se almacenan en un caché in-memory (`PermissionsCacheService`). El caché se invalida cuando se asigna o revoca un rol al usuario, garantizando que el siguiente request use los permisos actualizados.

### Zod para validación de DTOs

Todos los cuerpos de request se validan con Zod antes de llegar a los servicios. Errores de validación retornan `HTTP 400` con detalle de los campos fallidos.

### Pino para logging estructurado

```typescript
// Correcto
logger.info({ correlationId, userId, action: 'user.create' }, 'User created');
logger.error({ correlationId, error: err.message, stack: err.stack }, 'Failed to publish');

// Incorrecto — nunca usar
console.log('User created');
```

---

## 13. Cómo ejecutar el proyecto

### Prerrequisitos

- Node.js 20+
- pnpm (`npm install -g pnpm`)
- PostgreSQL corriendo (o cadena de conexión a Neon)
- RabbitMQ corriendo en `localhost:5672` (para eventos; el servicio arranca aunque RabbitMQ no esté)

### Instalación

```bash
pnpm install
```

### Generar cliente Prisma

```bash
npx prisma generate
```

### Desarrollo con hot-reload

```bash
pnpm run start:dev
```

Al arrancar en desarrollo con un navegador abierto, se abre automáticamente el Swagger UI en `http://localhost:3001/api`.

### Producción

```bash
pnpm run build
pnpm run start:prod
```

### Obtener un Firebase ID Token para pruebas

Abrir el archivo `get-token.html` en el navegador. Permite autenticarse con Google o email/password y copiar el token para usarlo en Swagger o Postman.

---

## 14. Base de datos — migraciones y seed

### Aplicar migraciones (entorno con TTY — local)

```bash
npx prisma migrate dev
```

### Aplicar migraciones (entorno sin TTY — CI, Neon, scripts)

```bash
# Ejecutar el SQL directamente
npx prisma db execute --file ./prisma/migrations/<nombre>/migration.sql --schema ./prisma/schema.prisma

# Marcar como aplicada sin re-ejecutar
npx prisma migrate resolve --applied <nombre_migracion>
```

### Seed inicial (roles, permisos y asignaciones)

```bash
pnpm run db:seed
```

El seed es **idempotente** — puede ejecutarse múltiples veces sin duplicar datos. Crea:

| Roles | Permisos |
|---|---|
| `BUYER` | `user:read`, `user:write` |
| `VENDOR` | `role:read`, `role:write`, `role:assign`, `role:revoke` |
| `ADMIN` | `store:read`, `store:write`, `store:close`, `store:staff` |
| `ANALYST` | `audit:read` |

### Explorar la DB con Prisma Studio

```bash
npx prisma studio
```

---

## 15. Tests

### Unitarios

```bash
pnpm run test
```

### Con cobertura

```bash
pnpm run test:cov
```

### E2E

```bash
pnpm run test:e2e
```

### Archivos de test

| Archivo | Qué prueba |
|---|---|
| `src/users/users.service.spec.ts` | `syncProfile`, `updateProfile`, `updateStatus`, `listUsers` |
| `src/roles/roles.service.spec.ts` | `assignRole`, `revokeRole`, `setRolePermissions` |
| `src/stores/stores.service.spec.ts` | CRUD de stores, schedules, closures, staff |
| `src/stores/closure-scheduler.service.spec.ts` | Job automático de activación/expiración de cierres |
| `src/outbox/outbox.worker.spec.ts` | Lógica de publicación y reintentos del worker |
| `src/common/guards/firebase-auth.guard.spec.ts` | Validación del token Firebase |
| `src/common/guards/permissions.guard.spec.ts` | Evaluación de permisos |

---

## 16. Reglas de negocio clave

| # | Regla |
|---|---|
| RN-01 | Todo usuario nuevo queda con rol `BUYER`. Los roles `VENDOR` o `ADMIN` se asignan después por un admin. |
| RN-02 | El servicio no almacena contraseñas. Firebase Auth es la fuente de verdad de credenciales. |
| RN-03 | No se exige cuenta institucional para registrarse (MVP). |
| RN-04 | Solo `ADMIN` puede gestionar usuarios, roles, permisos, tiendas, horarios, cierres y staff. |
| RN-05 | Los roles de sistema `BUYER`, `VENDOR`, `ADMIN` y `ANALYST` tienen `isSystem: true` y no pueden eliminarse. |
| RN-06 | Un admin no puede desactivarse a sí mismo ni quitarse su propio rol `ADMIN`. |
| RN-07 | Un usuario no puede quedar sin roles; si se revoca el último rol se reasigna `BUYER`. |
| RN-08 | El `effectiveRole` se calcula por jerarquía: `ADMIN > VENDOR > BUYER`. |
| RN-09 | Para asignar staff a una tienda, el usuario debe tener rol `VENDOR` o `ADMIN`. |
| RN-10 | Los horarios deben tener al menos 1 hora continua (`openTime` < `closeTime`). |
| RN-11 | No pueden existir horarios solapados para el mismo store y día. |
| RN-12 | Los horarios institucionales deben estar en el rango `07:00–16:00`. |
| RN-13 | Los cierres temporales no pueden superponerse para el mismo store. |
| RN-14 | Un store con cierre temporal vigente no puede marcarse como disponible manualmente. |
| RN-15 | Los audit logs son append-only y se conservan mínimo 12 meses. |
| RN-16 | Ningún microservicio externo accede directamente a la DB de este servicio. |
| RN-17 | Todo evento publicado pasa por el Transactional Outbox. |

---

## 17. Headers obligatorios

### En requests hacia este servicio

| Header | Obligatorio | Descripción |
|---|---|---|
| `Authorization` | Sí (rutas protegidas) | `Bearer <Firebase ID Token>` |
| `Idempotency-Key` | Recomendado en mutaciones | UUID v4 para prevenir duplicados |
| `X-Correlation-Id` | Opcional | UUID v4 para trazabilidad. Se genera automáticamente si no viene. |

### En respuestas de este servicio

| Header | Descripción |
|---|---|
| `X-Correlation-Id` | ID de correlación propagado o generado para el request |

---

## Notas para integradores

**Si eres el equipo de Order & Communication:**
- Antes de crear un pedido, valida la disponibilidad de la tienda en `GET /internal/stores/:storeId/availability?pickupAt=<fecha>`.
- Suscríbete a `identity.store.status_changed` para bloquear nuevos pedidos cuando una tienda cierra.
- Suscríbete a `identity.user.deactivated` para invalidar sesiones activas.

**Si eres el equipo de Product Management:**
- Suscríbete a `identity.store.created` para crear el espacio de catálogo cuando se registra un nuevo store.
- Para validar si un vendedor existe y está activo, usa `GET /internal/users/:userId/validate`.

**Si eres el equipo de Notification:**
- Suscríbete a `identity.user.registered` para enviar el email de bienvenida.
- El campo `email` y `fullName` vienen directamente en el evento — no necesitas hacer una llamada adicional.

**Si eres el equipo de Reporting & Analytics:**
- Suscríbete a todos los routing keys `identity.*` para capturar eventos operativos.
- Los campos `correlationId` y `occurredAt` permiten correlacionar eventos entre microservicios.

**Si eres el equipo del API Gateway:**
- Llama a `GET /auth/validate` con el token Firebase del cliente para obtener el contexto de seguridad completo.
- La respuesta incluye `userId`, `roles`, `permissions` y `effectiveRole` — suficiente para autorizar requests sin consultas adicionales.
- Propaga el header `X-Correlation-Id` de la respuesta hacia los microservicios destino.
