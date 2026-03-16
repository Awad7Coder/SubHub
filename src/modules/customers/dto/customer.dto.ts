import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsString, IsOptional, IsObject, MaxLength, IsIn } from 'class-validator';

export class CreateCustomerDto {
  @ApiProperty({ example: 'john@acme.com', description: 'Unique customer email' })
  @IsEmail()
  email: string;

  @ApiProperty({ example: 'John Smith', description: 'Full name for invoices' })
  @IsString()
  @MaxLength(255)
  full_name: string;

  @ApiPropertyOptional({ example: 'stripe', enum: ['stripe', 'paypal'], default: 'stripe' })
  @IsOptional()
  @IsString()
  @IsIn(['stripe', 'paypal'])
  payment_provider?: string;

  @ApiPropertyOptional({ example: { company: 'Acme Corp' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class UpdateCustomerDto {
  @ApiPropertyOptional({ example: 'John A. Smith' })
  @IsOptional()
  @IsString()
  @MaxLength(255)
  full_name?: string;

  @ApiPropertyOptional({ example: { company: 'New Corp' } })
  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}