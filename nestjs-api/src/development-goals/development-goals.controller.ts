import {
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';

import { type FirebaseAuthenticatedRequest } from '../auth/firebase-authenticated-request';
import { ApiException } from '../common/api.exception';
import { DevelopmentGoalsService } from './development-goals.service';

/** 개발 목표 완료 요청의 성공 응답 */
export interface DevelopmentGoalCompletionResponse {
  /** 완료한 개발 목표 ID */
  goalId: string;
  /** 완료 후 개발 목표 상태 */
  status: 'completed';
}

/** 개발 목표 완료 요청의 HTTP 경계 */
@Controller('goals')
export class DevelopmentGoalsController {
  /** 개발 목표 완료 업무 규칙을 제공하는 의존성 주입 */
  constructor(private readonly service: DevelopmentGoalsService) {}

  /** 인증된 사용자의 개발 목표 완료 요청 처리 */
  @Post(':goalId/complete')
  @HttpCode(HttpStatus.OK)
  async complete(
    @Req() request: FirebaseAuthenticatedRequest,
    @Param('goalId') goalId: string,
  ): Promise<DevelopmentGoalCompletionResponse> {
    const validGoalId = requiredGoalId(goalId);
    await this.service.complete(requiredUid(request), validGoalId);

    return { goalId: validGoalId, status: 'completed' };
  }
}

/** 인증 Guard가 확인한 사용자 식별자 */
function requiredUid(request: FirebaseAuthenticatedRequest): string {
  if (!request.uid) {
    throw new ApiException(
      HttpStatus.UNAUTHORIZED,
      'unauthenticated',
      '인증된 사용자가 아닙니다.',
    );
  }

  return request.uid;
}

/** 앞뒤 공백을 제거하고 경로 구분자를 거부한 개발 목표 식별자 */
function requiredGoalId(goalId: string): string {
  const trimmedGoalId = goalId.trim();
  if (!trimmedGoalId) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'invalid-argument',
      'goalId가 필요합니다.',
    );
  }
  if (trimmedGoalId.includes('/')) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'invalid-argument',
      'goalId에 경로 구분자를 포함할 수 없습니다.',
    );
  }

  return trimmedGoalId;
}
