import { Module } from '@nestjs/common';
import { DatabaseModule } from '../database/database.module';
import { VectorQueueModule } from '../ai/vector-queue.module';
import { SchoolSettingsController } from './school-settings.controller';
import { SchoolSettingsService } from './school-settings.service';

@Module({
  imports: [DatabaseModule, VectorQueueModule],
  controllers: [SchoolSettingsController],
  providers: [SchoolSettingsService],
  exports: [SchoolSettingsService],
})
export class SchoolSettingsModule {}
