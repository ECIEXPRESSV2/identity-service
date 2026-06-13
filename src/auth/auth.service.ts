import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../common/guards/firebase-auth.guard';

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
}
