import { Controller, Get } from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { AuthService } from './auth.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';

@ApiTags('Auth')
@ApiBearerAuth()
@Controller('auth')
export class AuthController {
  constructor(private readonly authService: AuthService) {}

  @Get('validate')
  @ApiOperation({
    summary: 'Validar token y obtener contexto de usuario',
    description:
      'Endpoint interno consumido por el API Gateway para verificar el token ' +
      'Firebase y obtener el contexto completo de roles y permisos del usuario. ' +
      'Los demás microservicios deben usar este endpoint para autorizar requests.',
  })
  @ApiResponse({
    status: 200,
    description: 'Token válido — retorna el contexto de seguridad del usuario',
    schema: {
      example: {
        userId:      'a1b2c3d4-e5f6-7890-abcd-ef1234567890',
        firebaseUid: 'firebase-uid-abc123',
        email:       'usuario@eci.edu.co',
        roles:       ['BUYER'],
        permissions: ['store:read'],
      },
    },
  })
  @ApiResponse({ status: 401, description: 'Token ausente, expirado o inválido' })
  validate(@CurrentUser() user: AuthenticatedUser) {
    return this.authService.buildValidationResponse(user);
  }
}
