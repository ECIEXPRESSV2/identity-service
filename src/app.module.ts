import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD, APP_INTERCEPTOR } from '@nestjs/core';
import { PrismaModule } from './prisma/prisma.module';
import { CommonModule } from './common/common.module';
import { AuthModule } from './auth/auth.module';
import { UsersModule } from './users/users.module';
import { RolesModule } from './roles/roles.module';
import { StoresModule } from './stores/stores.module';
import { OutboxModule } from './outbox/outbox.module';
import { AuditModule } from './audit/audit.module';
import { InternalModule } from './internal/internal.module';
import { FirebaseAuthGuard } from './common/guards/firebase-auth.guard';
import { PermissionsGuard } from './common/guards/permissions.guard';
import { CorrelationIdInterceptor } from './common/interceptors/correlation-id.interceptor';
import { GlobalExceptionFilter } from './common/filters/http-exception.filter';

@Module({
  imports: [
    PrismaModule,
    CommonModule,
    AuthModule,
    UsersModule,
    RolesModule,
    StoresModule,
    OutboxModule,
    AuditModule,
    InternalModule,
  ],
  providers: [
    { provide: APP_FILTER, useClass: GlobalExceptionFilter },
    { provide: APP_INTERCEPTOR, useClass: CorrelationIdInterceptor },
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_GUARD, useClass: PermissionsGuard },
  ],
})
export class AppModule {}
