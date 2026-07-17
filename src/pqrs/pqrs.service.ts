import { BadRequestException, ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { PqrsSenderRole, PqrsStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import type { CreatePqrsDto } from './dto/create-pqrs.dto';
import type { AddPqrsMessageDto } from './dto/add-pqrs-message.dto';

const TICKET_LIST_SELECT = {
  id: true,
  subject: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  closedAt: true,
  user: { select: { id: true, fullName: true, email: true } },
  messages: {
    orderBy: { createdAt: 'desc' as const },
    take: 1,
    select: { body: true, senderRole: true, createdAt: true },
  },
};

@Injectable()
export class PqrsService {
  constructor(private readonly prisma: PrismaService) {}

  async create(userId: string, dto: CreatePqrsDto) {
    const ticket = await this.prisma.pqrs.create({
      data: {
        userId,
        subject: dto.subject,
        messages: {
          create: { senderId: userId, senderRole: PqrsSenderRole.USER, body: dto.body },
        },
      },
      include: { messages: true },
    });
    return ticket;
  }

  async listMine(userId: string) {
    return this.prisma.pqrs.findMany({
      where: { userId },
      orderBy: { updatedAt: 'desc' },
      select: TICKET_LIST_SELECT,
    });
  }

  async listAll(status?: PqrsStatus) {
    return this.prisma.pqrs.findMany({
      where: status ? { status } : undefined,
      orderBy: { updatedAt: 'desc' },
      select: TICKET_LIST_SELECT,
    });
  }

  async getThread(id: string, requesterId: string, isAdmin: boolean) {
    const ticket = await this.prisma.pqrs.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) throw new NotFoundException('PQRS no encontrada');
    if (!isAdmin && ticket.userId !== requesterId) {
      throw new ForbiddenException('No tienes acceso a esta PQRS');
    }
    return ticket;
  }

  async addMessage(id: string, requesterId: string, isAdmin: boolean, dto: AddPqrsMessageDto) {
    const ticket = await this.prisma.pqrs.findUnique({ where: { id } });
    if (!ticket) throw new NotFoundException('PQRS no encontrada');
    if (!isAdmin && ticket.userId !== requesterId) {
      throw new ForbiddenException('No tienes acceso a esta PQRS');
    }
    if (ticket.status === PqrsStatus.CLOSED) {
      throw new BadRequestException('La PQRS ya está cerrada');
    }

    const [, updated] = await this.prisma.$transaction([
      this.prisma.pqrsMessage.create({
        data: {
          pqrsId: id,
          senderId: requesterId,
          senderRole: isAdmin ? PqrsSenderRole.ADMIN : PqrsSenderRole.USER,
          body: dto.body,
        },
      }),
      this.prisma.pqrs.update({ where: { id }, data: {}, include: { messages: { orderBy: { createdAt: 'asc' } } } }),
    ]);
    return updated;
  }

  async close(id: string, closedBy: string) {
    const ticket = await this.prisma.pqrs.findUnique({
      where: { id },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!ticket) throw new NotFoundException('PQRS no encontrada');
    if (ticket.status === PqrsStatus.CLOSED) return ticket;
    return this.prisma.pqrs.update({
      where: { id },
      data: { status: PqrsStatus.CLOSED, closedAt: new Date(), closedBy },
      include: {
        user: { select: { id: true, fullName: true, email: true } },
        messages: { orderBy: { createdAt: 'asc' } },
      },
    });
  }
}
