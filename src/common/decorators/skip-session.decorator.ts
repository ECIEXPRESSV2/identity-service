import { SetMetadata } from '@nestjs/common';

export const SKIP_SESSION_KEY = 'skipSessionValidation';

/** Mark a route so FirebaseAuthGuard skips X-Session-Id validation.
 *  Use ONLY on endpoints that bootstrap a session (sync-profile). */
export const SkipSessionValidation = () => SetMetadata(SKIP_SESSION_KEY, true);
