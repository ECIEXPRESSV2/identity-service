import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  UnauthorizedException,
} from '@nestjs/common';
import { admin } from '../config/firebase.config';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';
import type { ChangePasswordDto } from './dto/change-password.dto';

interface FirebasePasswordSignInError {
  error?: {
    message?: string;
  };
}

@Injectable()
export class AuthService {
  buildValidationResponse(user: AuthenticatedUser) {
    return {
      userId: user.userId,
      firebaseUid: user.firebaseUid,
      email: user.email,
      roles: user.roles,
      permissions: user.permissions,
    };
  }

  async changePassword(user: AuthenticatedUser, dto: ChangePasswordDto) {
    if (!user.email) {
      throw new BadRequestException('La cuenta no tiene correo asociado');
    }
    if (dto.currentPassword === dto.newPassword) {
      throw new BadRequestException('La nueva contraseña debe ser diferente a la actual');
    }

    await this.verifyCurrentPassword(user.email, dto.currentPassword);

    try {
      await admin.auth().updateUser(user.firebaseUid, { password: dto.newPassword });
      return { changed: true };
    } catch (err) {
      const code = (err as { code?: string }).code;
      if (code === 'auth/weak-password') {
        throw new BadRequestException('La nueva contraseña es demasiado débil');
      }
      throw new InternalServerErrorException('No se pudo actualizar la contraseña');
    }
  }

  private async verifyCurrentPassword(email: string, password: string): Promise<void> {
    const apiKey = process.env['FIREBASE_WEB_API_KEY'] ?? process.env['FIREBASE_API_KEY'];
    if (!apiKey) {
      throw new InternalServerErrorException(
        'Falta configurar FIREBASE_WEB_API_KEY en identity-service',
      );
    }

    const response = await fetch(
      `https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=${apiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ email, password, returnSecureToken: true }),
      },
    );

    if (response.ok) return;

    const payload = (await response.json().catch(() => ({}))) as FirebasePasswordSignInError;
    const message = payload.error?.message ?? '';

    if (
      message.includes('INVALID_PASSWORD') ||
      message.includes('INVALID_LOGIN_CREDENTIALS') ||
      message.includes('EMAIL_NOT_FOUND')
    ) {
      throw new UnauthorizedException('La contraseña actual no es válida');
    }

    if (message.includes('USER_DISABLED')) {
      throw new UnauthorizedException('La cuenta está deshabilitada en Firebase');
    }

    throw new UnauthorizedException('No fue posible validar la contraseña actual');
  }
}

