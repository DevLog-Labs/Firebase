import { Inject, Injectable } from '@nestjs/common';
import {
  type DocumentReference,
  FieldValue,
  type Firestore,
  type QueryDocumentSnapshot,
  Timestamp,
} from 'firebase-admin/firestore';

import { FIREBASE_FIRESTORE_TOKEN } from '../firebase/firebase.tokens';

/** 완료 판정에 사용하는 개발 기록 상태 */
export interface DevelopmentGoalCompletionRecord {
  /** 개발 기록 문서 ID */
  id: string;
  /** 개발 기록 생성 시각 */
  createdAt: Timestamp;
  /** 현재 확정 버전 존재 여부 */
  hasCurrentVersion: boolean;
  /** 확정되지 않은 초안 존재 여부 */
  hasDraft: boolean;
}

/** 완료 조건을 충족하지 못한 사유 */
export type DevelopmentGoalCompletionRejection =
  'requires-record' | 'needs-version' | 'has-draft';

/** 개발 목표 완료 transaction의 결과 */
export type DevelopmentGoalCompletionOutcome =
  | 'missing'
  | 'completed'
  | 'already-completed'
  | 'archived'
  | DevelopmentGoalCompletionRejection;

/** 개발 목표와 개발 기록의 Firestore 완료 처리 */
@Injectable()
export class DevelopmentGoalsRepository {
  /** Firestore 저장소 의존성 주입 */
  constructor(
    @Inject(FIREBASE_FIRESTORE_TOKEN) private readonly firestore: Firestore,
  ) {}

  /** 목표와 하위 개발 기록을 같은 transaction에서 읽고 판정 결과에 따라 완료 상태 기록 */
  // prettier-ignore
  async completeGoal(
    uid: string,
    goalId: string,
    rejectionFrom: (
      records: DevelopmentGoalCompletionRecord[],
    ) => DevelopmentGoalCompletionRejection | undefined,
  ): Promise<DevelopmentGoalCompletionOutcome> {
    const goal = this.goalDocument(uid, goalId);

    return this.firestore.runTransaction(async (transaction) => {
      const goalSnapshot = await transaction.get(goal);
      if (!goalSnapshot.exists) {
        return 'missing';
      }

      const status: unknown = goalSnapshot.get('status');
      if (status === 'completed') {
        return 'already-completed';
      }
      if (status === 'archived') {
        return 'archived';
      }
      if (status !== 'inProgress') {
        throw new Error(`개발 목표 status 값 오류: ${String(status)}`);
      }

      const recordsSnapshot = await transaction.get(goal.collection('records'));
      const rejection = rejectionFrom(
        recordsSnapshot.docs.map(completionRecord),
      );
      if (rejection) {
        return rejection;
      }

      transaction.update(goal, {
        status: 'completed',
        completedAt: FieldValue.serverTimestamp(),
        updatedAt: FieldValue.serverTimestamp(),
      });
      return 'completed';
    });
  }

  /** 검증된 사용자 UID 범위의 개발 목표 문서 참조 */
  // prettier-ignore
  private goalDocument(
    uid: string,
    goalId: string,
  ): DocumentReference {
    return this.firestore.doc(`users/${uid}/developmentGoals/${goalId}`);
  }
}

/** 개발 기록 문서를 완료 판정 입력으로 변환 */
function completionRecord(
  document: QueryDocumentSnapshot,
): DevelopmentGoalCompletionRecord {
  const createdAt: unknown = document.get('createdAt');
  const currentVersionId: unknown = document.get('currentVersionId');
  const currentVersionNumber: unknown = document.get('currentVersionNumber');
  const draft: unknown = document.get('draft');
  const hasCurrentVersionId = typeof currentVersionId === 'string';
  const hasCurrentVersionNumber = typeof currentVersionNumber === 'number';

  if (
    !(createdAt instanceof Timestamp) ||
    hasCurrentVersionId !== hasCurrentVersionNumber
  ) {
    throw new Error(`개발 기록 문서 값 오류: ${document.ref.path}`);
  }

  return {
    id: document.id,
    createdAt,
    hasCurrentVersion: hasCurrentVersionId,
    hasDraft: typeof draft === 'object' && draft !== null,
  };
}
