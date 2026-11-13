// prettier-ignore
import {
  HttpStatus,
  Injectable,
  Logger,
} from '@nestjs/common';

import { ApiException } from '../common/api.exception';
import {
  type DevelopmentRecordRollbackDecision,
  type DevelopmentRecordRollbackOutcome,
  type DevelopmentRecordRollbackRequest,
  type DevelopmentRecordRollbackState,
  DevelopmentRecordsRepository,
} from './development-records.repository';

// 동시 변경으로 transaction 재시도를 소진했을 때의 Firestore 오류 code
const transactionContentionCodes: unknown[] = [10, 409];

/** 개발 기록 rollback 요청의 성공 응답 */
export interface DevelopmentRecordVersionResponse {
  /** rollback version ID */
  id: string;
  /** rollback version이 속한 개발 기록 ID */
  recordId: string;
  /** 개발 기록 안의 version 번호 */
  number: number;
  /** 원본 version에서 복사한 제목 */
  title: string;
  /** 원본 version에서 복사한 본문 */
  markdownContent: string;
  /** version 확정 종류 */
  kind: string;
  /** 되돌린 원본 version ID */
  sourceVersionId: string | undefined;
  /** ISO 8601 형식의 version 확정 시각 */
  confirmedAt: string;
}

/** 개발 기록 rollback 조건 판정과 결과 응답 변환 */
@Injectable()
export class DevelopmentRecordsService {
  /** 개발 기록 rollback 실패 원인을 기록하는 로그 기능 */
  private readonly logger = new Logger(DevelopmentRecordsService.name);

  /** 개발 기록 저장 동작을 제공하는 의존성 주입 */
  constructor(private readonly repository: DevelopmentRecordsRepository) {}

  /** 조건을 충족한 개발 기록의 rollback version 생성 또는 같은 rollback의 기존 version 반환 */
  // prettier-ignore
  async rollback(
    uid: string,
    request: DevelopmentRecordRollbackRequest,
  ): Promise<DevelopmentRecordVersionResponse> {
    let outcome: DevelopmentRecordRollbackOutcome;
    try {
      outcome = await this.repository.rollbackRecord(
        uid,
        request,
        (state) => rollbackDecision(request, state),
      );
    } catch (error) {
      if (isTransactionContention(error)) {
        throw new ApiException(
          HttpStatus.CONFLICT,
          'aborted',
          '동시 변경으로 개발 기록을 되돌리지 못했습니다.',
        );
      }

      this.logger.error({
        message: '개발 기록 rollback 실패',
        errorMessage: error instanceof Error ? error.message : '알 수 없는 오류',
        errorStack: error instanceof Error ? error.stack : undefined,
        uid,
        goalId: request.goalId,
        recordId: request.recordId,
      });
      throw new ApiException(
        HttpStatus.INTERNAL_SERVER_ERROR,
        'internal',
        '개발 기록 rollback에 실패했습니다.',
      );
    }

    switch (outcome.result) {
      case 'created':
      case 'existing': {
        const version = outcome.version;
        return {
          id: version.id,
          recordId: request.recordId,
          number: version.number,
          title: version.title,
          markdownContent: version.markdownContent,
          kind: version.kind,
          sourceVersionId: version.sourceVersionId,
          confirmedAt: version.confirmedAt.toDate().toISOString(),
        };
      }
      case 'missing-record':
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          'not-found',
          '개발 기록을 찾을 수 없습니다.',
        );
      case 'missing-source':
        throw new ApiException(
          HttpStatus.NOT_FOUND,
          'not-found',
          '원본 version을 찾을 수 없습니다.',
        );
      case 'needs-version':
        throw new ApiException(
          HttpStatus.CONFLICT,
          'development-record-rollback-needs-version',
          '확정 version이 없는 개발 기록은 되돌릴 수 없습니다.',
        );
      case 'version-conflict':
        throw new ApiException(
          HttpStatus.CONFLICT,
          'development-record-rollback-version-conflict',
          '개발 기록의 현재 version이 요청 기준과 다릅니다.',
        );
      case 'has-draft':
        throw new ApiException(
          HttpStatus.CONFLICT,
          'development-record-rollback-has-draft',
          '확정되지 않은 초안이 있는 개발 기록은 되돌릴 수 없습니다.',
        );
      case 'source-not-earlier':
        throw new ApiException(
          HttpStatus.CONFLICT,
          'development-record-rollback-source-not-earlier',
          '현재 version보다 이전 version으로만 되돌릴 수 있습니다.',
        );
    }
  }
}

/** 요청과 개발 기록 상태로 정한 rollback 처리 방식 */
// prettier-ignore
function rollbackDecision(
  request: DevelopmentRecordRollbackRequest,
  state: DevelopmentRecordRollbackState,
): DevelopmentRecordRollbackDecision {
  const { currentVersion, sourceVersion } = state;
  if (!state.hasRecord) {
    return 'missing-record';
  }
  if (!sourceVersion) {
    return 'missing-source';
  }
  if (!currentVersion) {
    return 'needs-version';
  }
  if (!state.hasExpectedVersion) {
    return 'version-conflict';
  }
  if (
    currentVersion.kind === 'rollback' &&
    currentVersion.sourceVersionId === sourceVersion.id
  ) {
    return 'existing';
  }
  if (currentVersion.id !== request.expectedCurrentVersionId) {
    return 'version-conflict';
  }
  if (state.hasDraft) {
    return 'has-draft';
  }
  if (sourceVersion.number >= currentVersion.number) {
    return 'source-not-earlier';
  }

  return 'create';
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
