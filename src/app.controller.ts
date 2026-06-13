import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { AppService } from './app.service';
import { Public } from './common/decorators/public.decorator';

@ApiTags('App')
@Controller()
export class AppController {
  constructor(private readonly appService: AppService) {}

  @Get()
  @Public()
  @ApiOperation({ summary: 'Root endpoint', security: [] })
  @ApiOkResponse({ description: 'Servicio en línea', schema: { type: 'string', example: 'Hello World!' } })
  getHello(): string {
    return this.appService.getHello();
  }

  @Get('health')
  @Public()
  @ApiOperation({ summary: 'Health check', security: [] })
  @ApiOkResponse({
    description: 'Estado del servicio',
    schema: {
      type: 'object',
      properties: {
        status:    { type: 'string', example: 'ok' },
        service:   { type: 'string', example: 'identity-service' },
        timestamp: { type: 'string', format: 'date-time', example: '2026-06-13T00:00:00.000Z' },
      },
    },
  })
  getHealth(): { status: string; service: string; timestamp: string } {
    return {
      status: 'ok',
      service: 'identity-service',
      timestamp: new Date().toISOString(),
    };
  }
}
