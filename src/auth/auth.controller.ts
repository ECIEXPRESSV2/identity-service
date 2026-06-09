import { Controller, Get } from '@nestjs/common';
import { AuthService } from './auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';

@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  /** Used by API Gateway to validate token and retrieve user context. */
  @Get('validate')
  validate(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.buildValidationResponse(user);
  }
}
