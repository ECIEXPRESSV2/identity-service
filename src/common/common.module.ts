import { Global, Module } from '@nestjs/common';
import { PermissionsCacheService } from './services/permissions-cache.service';

@Global()
@Module({
  providers: [PermissionsCacheService],
  exports: [PermissionsCacheService],
})
export class CommonModule {}
