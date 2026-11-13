import { Module } from '@nestjs/common';

import { FirebaseModule } from '../firebase/firebase.module';
import { DevelopmentGoalsController } from './development-goals.controller';
import { DevelopmentGoalsRepository } from './development-goals.repository';
import { DevelopmentGoalsService } from './development-goals.service';

/** 개발 목표 완료 판정과 Firestore transaction의 의존성 경계 */
@Module({
  imports: [FirebaseModule],
  controllers: [DevelopmentGoalsController],
  providers: [DevelopmentGoalsRepository, DevelopmentGoalsService],
})
export class DevelopmentGoalsModule {}
