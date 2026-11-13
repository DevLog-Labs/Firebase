import { Module } from '@nestjs/common';

import { FirebaseModule } from '../firebase/firebase.module';
import { DevelopmentRecordsController } from './development-records.controller';
import { DevelopmentRecordsRepository } from './development-records.repository';
import { DevelopmentRecordsService } from './development-records.service';

/** 개발 기록 rollback 판정과 Firestore transaction의 의존성 경계 */
@Module({
  imports: [FirebaseModule],
  controllers: [DevelopmentRecordsController],
  providers: [DevelopmentRecordsRepository, DevelopmentRecordsService],
})
export class DevelopmentRecordsModule {}
