import {
  IsUUID,
  IsOptional,
  IsInt,
  Min,
} from 'class-validator';


export class ManualRetryPaymentDto {
  @IsUUID()
  invoiceId: string;
}

export class GetPaymentHistoryQueryDto {
  @IsOptional()
  @IsInt()
  @Min(1)
  page?: number = 1;

  @IsOptional()
  @IsInt()
  @Min(1)
  limit?: number = 20;
}