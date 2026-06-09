import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';


@Injectable()
export class RolesService {
  constructor(private readonly prisma: PrismaService) {}

  async listRoles() {
    return this.prisma.role.findMany();
  }

  async assignRole(_userId: string, _roleId: string, _actorId: string) {
    throw new Error('Not implemented — see TASK-05');
  }

  async revokeRole(_userId: string, _roleId: string, _actorId: string) {
    throw new Error('Not implemented — see TASK-05');
  }
}
