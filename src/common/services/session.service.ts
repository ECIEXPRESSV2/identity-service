import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../../prisma/prisma.service';

const SESSION_TTL_MS = 8 * 60 * 60 * 1000; // 8 hours

@Injectable()
export class SessionService {
  constructor(private readonly prisma: PrismaService) {}

  async createSession(userId: string): Promise<string> {
    const sessionId = randomUUID();
    await this.prisma.userSession.create({
      data: {
        id: randomUUID(),
        userId,
        sessionId,
        isActive: true,
        expiresAt: new Date(Date.now() + SESSION_TTL_MS),
      },
    });
    return sessionId;
  }

  async validateSession(userId: string, sessionId: string): Promise<boolean> {
    const session = await this.prisma.userSession.findFirst({
      where: {
        userId,
        sessionId,
        isActive: true,
        expiresAt: { gt: new Date() },
      },
    });
    return session !== null;
  }
}
