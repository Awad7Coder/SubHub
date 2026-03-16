import {
  Controller,
  Get,
  Post,
  Patch,
  Delete,
  Param,
  Body,
  Query,
  HttpCode,
  HttpStatus,
  ParseUUIDPipe,
} from '@nestjs/common';
import { CustomersService } from './customers.service';
import { CreateCustomerDto, UpdateCustomerDto } from './dto/customer.dto';
import { ApiTags } from '@nestjs/swagger';

/**
 * WHY no IdempotencyInterceptor on CustomersController?
 *
 * Creating a customer is idempotent by nature — the unique email
 * constraint means a duplicate POST with the same email returns 409,
 * not a double-created customer. The gateway/client handles retries.
 *
 * Customer creation doesn't move money, so the idempotency
 * infrastructure is overkill here. Save it for payment endpoints.
 */
@ApiTags('customers')
@Controller('customers')
export class CustomersController {
  constructor(private readonly customersService: CustomersService) { }

  // ── POST /api/customers ───────────────────────────────────────────────────

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async create(@Body() dto: CreateCustomerDto) {
    return this.customersService.create(dto);
  }

  // ── GET /api/customers ────────────────────────────────────────────────────

  @Get()
  async findAll(
    @Query('activeOnly') activeOnly?: string,
    @Query('page') page?: number,
    @Query('limit') limit?: number,
  ) {
    return this.customersService.findAll({
      activeOnly: activeOnly === 'true',
      page,
      limit,
    });
  }

  // ── GET /api/customers/:id ────────────────────────────────────────────────

  @Get(':id')
  async findById(@Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.findById(id);
  }

  // ── PATCH /api/customers/:id ──────────────────────────────────────────────

  /**
   * WHY PATCH and not PUT?
   * PUT replaces the entire resource — client must send all fields.
   * PATCH updates only the provided fields — partial update.
   * Customer updates are always partial (update name, not email).
   * PATCH is the correct semantic here.
   */
  @Patch(':id')
  async update(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: UpdateCustomerDto,
  ) {
    return this.customersService.update(id, dto);
  }

  // ── DELETE /api/customers/:id ─────────────────────────────────────────────
  // Soft deactivation — preserves financial history

  @Delete(':id')
  @HttpCode(HttpStatus.OK)
  async deactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.deactivate(id);
  }

  // ── POST /api/customers/:id/reactivate ────────────────────────────────────

  @Post(':id/reactivate')
  @HttpCode(HttpStatus.OK)
  async reactivate(@Param('id', ParseUUIDPipe) id: string) {
    return this.customersService.reactivate(id);
  }
}