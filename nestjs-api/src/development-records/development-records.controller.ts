import {
  Body,
  Controller,
  HttpCode,
  HttpStatus,
  Param,
  Post,
  Req,
} from '@nestjs/common';

import { type FirebaseAuthenticatedRequest } from '../auth/firebase-authenticated-request';
import { ApiException } from '../common/api.exception';
import {
  type DevelopmentRecordVersionResponse,
  DevelopmentRecordsService,
} from './development-records.service';

/** 개발 기록 rollback 요청의 HTTP 경계 */
@Controller('goals/:goalId/records')
export class DevelopmentRecordsController {
  /** 개발 기록 rollback 업무 규칙을 제공하는 의존성 주입 */
  constructor(private readonly service: DevelopmentRecordsService) {}

  /** 인증된 사용자의 개발 기록 rollback 요청 처리 */
  @Post(':recordId/rollback')
  @HttpCode(HttpStatus.OK)
  async rollback(
    @Req() request: FirebaseAuthenticatedRequest,
    @Param('goalId') goalId: string,
    @Param('recordId') recordId: string,
    @Body() body: unknown,
  ): Promise<DevelopmentRecordVersionResponse> {
    const uid = requiredUid(request);
    const value = bodyRecord(body);

    return this.service.rollback(uid, {
      goalId: requiredIdentifier('goalId', goalId),
      recordId: requiredIdentifier('recordId', recordId),
      sourceVersionId: requiredIdentifier(
        'sourceVersionId',
        value.sourceVersionId,
      ),
      expectedCurrentVersionId: requiredIdentifier(
        'expectedCurrentVersionId',
        value.expectedCurrentVersionId,
      ),
    });
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

/** 객체가 아닌 요청 본문을 빈 객체로 바꾼 요청 본문 */
function bodyRecord(body: unknown): Record<string, unknown> {
  if (body && typeof body === 'object' && !Array.isArray(body)) {
    return body as Record<string, unknown>;
  }

  return {};
}

/** 앞뒤 공백을 제거하고 경로 구분자를 거부한 문서 식별자 */
// prettier-ignore
function requiredIdentifier(
  name: string,
  value: unknown,
): string {
  const trimmedValue = typeof value === 'string' ? value.trim() : '';
  if (!trimmedValue) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'invalid-argument',
      `${name}가 필요합니다.`,
    );
  }
  if (trimmedValue.includes('/')) {
    throw new ApiException(
      HttpStatus.BAD_REQUEST,
      'invalid-argument',
      `${name}에 경로 구분자를 포함할 수 없습니다.`,
    );
  }

  return trimmedValue;
}
