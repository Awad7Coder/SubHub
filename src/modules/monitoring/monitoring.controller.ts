import { Controller, Get, Res } from '@nestjs/common';
import type{ Response } from 'express';
import { PrometheusController } from '@willsoto/nestjs-prometheus';

@Controller('monitoring')
export class MonitoringController extends PrometheusController {
  @Get('metrics')
  async index(@Res() res: Response) {
    return super.index(res);
  }
}