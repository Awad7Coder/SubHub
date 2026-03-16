import {
  Controller, Get, Post, Patch, Delete,
  Param, Body, Query, HttpCode, HttpStatus, ParseUUIDPipe,
} from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiParam, ApiQuery, ApiBody } from '@nestjs/swagger';
import { CreatePlanDto, UpdatePlanDto } from './dto/plan.dto';
import { PlansService } from './plan.service';

@ApiTags('plans')
@Controller('plans')
export class PlansController {
  constructor(private readonly plansService: PlansService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({ summary: 'Create a plan' })
  @ApiBody({ type: CreatePlanDto })
  @ApiResponse({ status: 201, description: 'Plan created' })
  @ApiResponse({ status: 400, description: 'Validation failed' })
  async create(@Body() dto: CreatePlanDto) {
    return this.plansService.create(dto);
  }

  @Get()
  @ApiOperation({ summary: 'List plans', description: 'Returns all plans sorted by price. Filter to active only.' })
  @ApiQuery({ name: 'activeOnly', required: false, type: Boolean, example: true })
  @ApiResponse({ status: 200, description: 'Plan list' })
  async findAll(@Query('activeOnly') activeOnly?: string) {
    return this.plansService.findAll({ activeOnly: activeOnly === 'true' });
  }

  @Get(':id')
  @ApiOperation({ summary: 'Get plan by ID' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Plan found' })
  @ApiResponse({ status: 404, description: 'Plan not found' })
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.plansService.findById(id);
  }

  @Patch(':id')
  @ApiOperation({
    summary: 'Update plan',
    description: 'Price changes apply to ALL future renewals. Existing subscribers see new price at next billing cycle.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiBody({ type: UpdatePlanDto })
  @ApiResponse({ status: 200, description: 'Plan updated' })
  async update(@Param('id', ParseUUIDPipe) id: string, @Body() dto: UpdatePlanDto) {
    return this.plansService.update(id, dto);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Deactivate plan',
    description: 'Prevents new subscriptions. All existing subscribers continue unaffected.',
  })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Plan deactivated' })
  @ApiResponse({ status: 400, description: 'Already inactive' })
  async deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.plansService.deactivate(id);
  }

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Reactivate plan' })
  @ApiParam({ name: 'id', type: String, format: 'uuid' })
  @ApiResponse({ status: 200, description: 'Plan reactivated' })
  async reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.plansService.reactivate(id);
  }
}