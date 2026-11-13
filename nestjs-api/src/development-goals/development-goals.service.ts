// prettier-ignore
import {
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';

import { ApiException } from '../common/api.exception';
import {
  type DevelopmentGoalCompletionOutcome,
  type DevelopmentGoalCompletionRecord,
  type DevelopmentGoalCompletionRejection,
  DevelopmentGoalsRepository,
} from './development-goals.repository';

// 동시 변경으로 transaction 재시도를 소진했을 때의 Firestore 오류 code
const transactionContentionCodes: unknown[] = [10, 409];

/** 개발 목표 완료 조건 판정과 결과 응답 변환 */
@Injectable()
export class DevelopmentGoalsService {
  /** 개발 목표 완료 실패 원인을 기록하는 로그 기능 */
  private readonly logger = new Logger(DevelopmentGoalsService.name);

  /** 개발 목표 저장 동작을 제공하는 의존성 주입 */
  constructor(private readonly repository: DevelopmentGoalsRepository) {}

  /** 완료 조건을 충족한 진행 중 개발 목표의 완료 전환 */
  // prettier-ignore
  async complete(
    uid: string,
    goalId: string,
  ): Promise<void> {
    let outcome: DevelopmentGoalCompletionOutcome;
    try {
      outcome = await this.repository.completeGoal(
        uid,
        goalId,
        completionRejection,
      );
    } catch (error) {
      if (isTransactionContention(error)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'aborted',
          '동시 변경으로 개발 목표를 완료하지 못했습니다.',
        );
      }

      this.logger.error({
        message: '개발 목표 완료 실패',
        errorMessage: error instanceof Error ? error.message : '알 수 없는 오류',
        errorStack: error instanceof Error ? error.stack : undefined,
        uid,
        goalId,
      });
      throw new ApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'internal',
        '개발 목표 완료에 실패했습니다.',
      );
    }

    switch (outcome) {
      case 'completed':
      case 'already-completed':
        return;
      case 'missing':
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          'not-found',
          '개발 목표를 찾을 수 없습니다.',
        );
      case 'archived':
        throw new ApiException(
          HttpStatus.CONFLICT,
          'development-goal-not-in-progress',
          '진행 중인 개발 목표만 완료할 수 있습니다.',
        );
      case 'requires-record':
        throw new ApiException(
          HttpStatus.CONFLICT,
          'development-goal-completion-requires-record',
          '개발 기록이 없는 개발 목표는 완료할 수 없습니다.',
        );
      case 'needs-version':
        throw new ApiException(
          HttpStatus.CONFLICT,
          'development-goal-completion-needs-version',
          '마지막 개발 기록에 확정 버전이 필요합니다.',
        );
      case 'has-draft':
        throw new ApiException(
          HttpStatus.CONFLICT,
          'development-goal-completion-has-draft',
          '확정되지 않은 초안이 있는 개발 목표는 완료할 수 없습니다.',
        );
    }
  }
}

/** 개발 기록 상태로 판정한 완료 거부 사유 */
function completionRejection(
  records: DevelopmentGoalCompletionRecord[],
): DevelopmentGoalCompletionRejection | undefined {
  if (records.length === 0) {
    return 'requires-record';
  }

  const lastRecord = records.reduce((last, record) =>
    isCreatedBefore(last, record) ? record : last,
  );
  if (!lastRecord.hasCurrentVersion) {
    return 'needs-version';
  }
  if (records.some((record) => record.hasDraft)) {
    return 'has-draft';
  }

  return undefined;
}

/** 생성 시각과 문서 ID 순서상 앞선 개발 기록 여부 */
function isCreatedBefore(
  lhs: DevelopmentGoalCompletionRecord,
  rhs: DevelopmentGoalCompletionRecord,
): boolean {
  if (lhs.createdAt.seconds !== rhs.createdAt.seconds) {
    return lhs.createdAt.seconds < rhs.createdAt.seconds;
  }
  if (lhs.createdAt.nanoseconds !== rhs.createdAt.nanoseconds) {
    return lhs.createdAt.nanoseconds < rhs.createdAt.nanoseconds;
  }

  return lhs.id < rhs.id;
}

/** 동시 변경으로 transaction 재시도를 소진한 오류 여부 */
function isTransactionContention(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    transactionContentionCodes.includes(error.code)
  );
}
