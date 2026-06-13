import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { randomUUID } from 'crypto';
import type { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import type { RequestWithUser } from '../guards/firebase-auth.guard';
import type { Response } from 'express';

@Injectable()
export class CorrelationIdInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<RequestWithUser>();
    const res = context.switchToHttp().getResponse<Response>();

    const correlationId =
      (req.headers['x-correlation-id'] as string | undefined) ?? randomUUID();

    req.correlationId = correlationId;
    res.setHeader('X-Correlation-Id', correlationId);

    return next.handle().pipe(tap(() => res.setHeader('X-Correlation-Id', correlationId)));
  }
}
