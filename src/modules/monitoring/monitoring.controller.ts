import { Controller, Get, Res } from '@nestjs/common';
import type{ Response } from 'express';
import { PrometheusController } from '@willsoto/nestjs-prometheus';
import { SkipThrottle } from '@nestjs/throttler';

@SkipThrottle() 
@Controller('monitoring')
export class MonitoringController extends PrometheusController {
  @Get('metrics')
  async index(@Res() res: Response) {
    return super.index(res);
  }
}