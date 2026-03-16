import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNumber, IsPositive, IsOptional, IsInt, IsObject, MaxLength, IsIn, Min } from 'class-validator';

export class CreatePlanDto {
  @ApiProperty({ example: 'Pro Plan', description: 'Display name for this plan' })
  @IsString()
  @MaxLength(255)
  name: string;

  @ApiProperty({ example: 99.00, description: 'Price in the specified currency' })
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  price: number;

  @ApiPropertyOptional({ example: 'usd', enum: ['usd', 'eur', 'gbp'], default: 'usd' })
  @IsOptional()
  @IsString()
  @IsIn(['usd', 'eur', 'gbp'])
  currency?: string;

  @ApiProperty({
    example: '1 month',
    enum: ['7 days', '1 month', '3 months', '6 months', '1 year'],
    description: 'Billing interval — maps directly to PostgreSQL interval',
  })
  @IsString()
  @IsIn(['7 days', '1 month', '3 months', '6 months', '1 year'])
  interval: string;

  @ApiPropertyOptional({ example: 1000, description: 'Max usage actions per period. 0 = unlimited' })
  @IsOptional()
  @IsInt()
  @Min(0)
  usage_limit?: number;

  @ApiPropertyOptional({ example: { tier: 'professional' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class UpdatePlanDto {
  @ApiPropertyOptional({ example: 'Pro Plan v2' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ example: 129.00 })
  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 2 })
  @IsPositive()
  price?: number;

  @ApiPropertyOptional({ example: 2000 })
  @IsOptional()
  @IsInt()
  @Min(0)
  usage_limit?: number;

  @ApiPropertyOptional({ example: { tier: 'professional' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}