import { Global, Module } from '@nestjs/common';
import { PermissionsCacheService } from './services/permissions-cache.service';
import { SessionService } from './services/session.service';

@Global()
@Module({
  providers: [PermissionsCacheService, SessionService],
  exports: [PermissionsCacheService, SessionService],
})
export class CommonModule {}
