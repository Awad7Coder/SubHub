import {
  IsString,
  IsOptional,
  IsObject,
  IsInt,
  IsPositive,
  MaxLength,
} from 'class-validator';


export class LogUsageDto {
  /**
   * WHY @IsString() @MaxLength(100) on actionType?
   * The usage_logs table has VARCHAR(100) for action_type.
   * Without this validation, a client sending a 10,000 char action_type
   * would hit the DB and get a cryptic PostgreSQL truncation error.
   * Validate at the boundary — fail fast with a clear 400.
   */
  @IsString()
  @MaxLength(100)
  actionType: string;

  @IsOptional()
  @IsInt()
  @IsPositive()
  amountUsed?: number;

  @IsOptional()
  @IsObject()
  metadata?: Record<string, any>;
}

export class GetUsageQueryDto {
  @IsOptional()
  @IsString()
  @MaxLength(100)
  actionType?: string;
}