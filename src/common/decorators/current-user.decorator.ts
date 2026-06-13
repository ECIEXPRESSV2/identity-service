import { createParamDecorator, ExecutionContext } from '@nestjs/common';
import type { RequestWithUser } from '../guards/firebase-auth.guard';

/** Extracts the authenticated user from the request context. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext) => {
    const request = ctx.switchToHttp().getRequest<RequestWithUser>();
    return request.user;
  },
);
