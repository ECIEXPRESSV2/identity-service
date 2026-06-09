import { Body, Controller, Get, Param, Patch, Post, Put } from '@nestjs/common';
import { UsersService } from './users.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { RequirePermission } from '../common/decorators/require-permission.decorator';
import { ZodValidationPipe } from '../common/pipes/zod-validation.pipe';
import { SyncProfileSchema, type SyncProfileDto } from './dto/sync-profile.dto';
import { UpdateProfileSchema, type UpdateProfileDto } from './dto/update-profile.dto';
import { UpdateStatusSchema, type UpdateStatusDto } from './dto/update-status.dto';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';
import { UserStatus } from '@prisma/client';

@Controller()
export class UsersController {
  constructor(private readonly usersService: UsersService) {}

  @Post('auth/sync-profile')
  syncProfile(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(SyncProfileSchema)) dto: SyncProfileDto,
  ) {
    return this.usersService.syncProfile(
      user.firebaseUid,
      user.email,
      dto,
      user.correlationId,
    );
  }

  @Get('users/me')
  getMe(@CurrentUser() user: AuthenticatedUser) {
    return this.usersService.findByFirebaseUid(user.firebaseUid);
  }

  @Put('users/me')
  updateMe(
    @CurrentUser() user: AuthenticatedUser,
    @Body(new ZodValidationPipe(UpdateProfileSchema)) dto: UpdateProfileDto,
  ) {
    return this.usersService.updateProfile(user.userId, dto, user.correlationId);
  }

  @Get('users/:id')
  @RequirePermission('user:read')
  getUser(@Param('id') id: string) {
    return this.usersService.findById(id);
  }

  @Patch('users/:id/status')
  @RequirePermission('user:deactivate')
  updateStatus(
    @Param('id') id: string,
    @Body(new ZodValidationPipe(UpdateStatusSchema)) dto: UpdateStatusDto,
    @CurrentUser() actor: AuthenticatedUser,
  ) {
    return this.usersService.updateStatus(
      id,
      dto.status as UserStatus,
      actor.userId,
      actor.correlationId,
    );
  }
}
