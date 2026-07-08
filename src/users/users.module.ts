import { Module } from '@nestjs/common';
import { UsersController } from './users.controller';
import { UsersService } from './users.service';
import { ProfileAssetsService } from './profile-assets.service';

@Module({
  controllers: [UsersController],
  providers: [UsersService, ProfileAssetsService],
  exports: [UsersService],
})
export class UsersModule {}
