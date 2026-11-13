import { randomUUID } from 'node:crypto';

import { Inject, Injectable } from '@nestjs/common';
import {
  type DocumentReference,
  type DocumentSnapshot,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';

import { FIREBASE_FIRESTORE_TOKEN } from '../firebase/firebase.tokens';

/** 개발 기록 rollback 요청의 식별자 */
export interface DevelopmentRecordRollbackRequest {
  /** 개발 목표 문서 ID */
  goalId: string;
  /** 개발 기록 문서 ID */
  recordId: string;
  /** 되돌릴 원본 version ID */
  sourceVersionId: string;
  /** 요청 시점에 클라이언트가 본 현재 version ID */
  expectedCurrentVersionId: string;
}

/** 개발 기록의 확정 version */
export interface DevelopmentRecordVersion {
  /** version 문서 ID */
  id: string;
  /** 개발 기록 안의 version 번호 */
  number: number;
  /** version 제목 */
  title: string;
  /** version 본문 */
  markdownContent: string;
  /** version 확정 종류 */
  kind: string;
  /** rollback version이 복사한 원본 version ID */
  sourceVersionId: string | undefined;
  /** version 확정 시각 */
  confirmedAt: Timestamp;
}

/** rollback 판정에 사용하는 transaction 안의 개발 기록 상태 */
export interface DevelopmentRecordRollbackState {
  /** 개발 기록 문서 존재 여부 */
  hasRecord: boolean;
  /** 확정되지 않은 초안 존재 여부 */
  hasDraft: boolean;
  /** 개발 기록이 가리키는 실제 현재 version */
  currentVersion: DevelopmentRecordVersion | undefined;
  /** 요청 기준 현재 version 문서 존재 여부 */
  hasExpectedVersion: boolean;
  /** 요청 원본 version */
  sourceVersion: DevelopmentRecordVersion | undefined;
}

/** rollback 조건을 충족하지 못한 사유 */
export type DevelopmentRecordRollbackRejection =
  | 'missing-record'
  | 'missing-source'
  | 'needs-version'
  | 'version-conflict'
  | 'has-draft'
  | 'source-not-earlier';

/** 개발 기록 상태로 정한 rollback 처리 방식 */
export type DevelopmentRecordRollbackDecision =
  'create' | 'existing' | DevelopmentRecordRollbackRejection;

/** 개발 기록 rollback transaction의 결과 */
export type DevelopmentRecordRollbackOutcome =
  | {
      /** 새 rollback version 생성 또는 기존 rollback version 반환 */
      result: 'created' | 'existing';
      /** 응답에 사용할 rollback version */
      version: DevelopmentRecordVersion;
    }
  | {
      /** rollback 거부 사유 */
      result: DevelopmentRecordRollbackRejection;
    };

/** 개발 기록과 확정 version의 Firestore rollback 처리 */
@Injectable()
export class DevelopmentRecordsRepository {
  /** Firestore 저장소 의존성 주입 */
  constructor(
    @Inject(FIREBASE_FIRESTORE_TOKEN) private readonly firestore: Firestore,
  ) {}

  /** 기록과 version을 같은 transaction에서 읽고 판정 결과에 따라 rollback version 기록 */
  // prettier-ignore
  async rollbackRecord(
    uid: string,
    request: DevelopmentRecordRollbackRequest,
    decisionFrom: (
      state: DevelopmentRecordRollbackState,
    ) => DevelopmentRecordRollbackDecision,
  ): Promise<DevelopmentRecordRollbackOutcome> {
    const record = this.recordDocument(uid, request);
    const versions = record.collection('versions');
    const expectedReference = versions.doc(request.expectedCurrentVersionId);
    const sourceReference = versions.doc(request.sourceVersionId);
    // transaction 재시도에서도 같은 값을 쓰도록 한 번만 생성한 version ID와 확정 시각
    const versionId = randomUUID().toUpperCase();
    const confirmedAt = Timestamp.now();

    return this.firestore.runTransaction(async (transaction) => {
      const isSameVersion =
        request.sourceVersionId === request.expectedCurrentVersionId;
      const snapshots = await transaction.getAll(
        record,
        expectedReference,
        ...(isSameVersion ? [] : [sourceReference]),
      );
      const recordSnapshot = snapshots[0];
      const expectedSnapshot = snapshots[1];
      const sourceSnapshot = isSameVersion ? expectedSnapshot : snapshots[2];

      const pointer = currentVersionPointer(recordSnapshot);
      let currentVersion: DevelopmentRecordVersion | undefined;
      if (pointer) {
        const currentSnapshot =
          pointer.id === request.expectedCurrentVersionId
            ? expectedSnapshot
            : await transaction.get(versions.doc(pointer.id));
        currentVersion = existingVersion(currentSnapshot);
        if (currentVersion.number !== pointer.number) {
          throw new Error(`개발 기록 문서 값 오류: ${recordSnapshot.ref.path}`);
        }
      }

      const draft: unknown = recordSnapshot.get('draft');
      const source = sourceSnapshot.exists
        ? existingVersion(sourceSnapshot)
        : undefined;
      const decision = decisionFrom({
        hasRecord: recordSnapshot.exists,
        hasDraft: typeof draft === 'object' && draft !== null,
        currentVersion,
        hasExpectedVersion: expectedSnapshot.exists,
        sourceVersion: source,
      });

      if (decision !== 'create' && decision !== 'existing') {
        return { result: decision };
      }
      if (!currentVersion || !source) {
        throw new Error(`개발 기록 rollback 판정 오류: ${record.path}`);
      }
      if (decision === 'existing') {
        return { result: 'existing', version: currentVersion };
      }

      const version: DevelopmentRecordVersion = {
        id: versionId,
        number: currentVersion.number + 1,
        title: source.title,
        markdownContent: source.markdownContent,
        kind: 'rollback',
        sourceVersionId: source.id,
        confirmedAt,
      };
      transaction.create(versions.doc(versionId), {
        versionNumber: version.number,
        title: version.title,
        markdownContent: version.markdownContent,
        changeKind: version.kind,
        sourceVersionId: version.sourceVersionId,
        confirmedAt: version.confirmedAt,
      });
      transaction.update(record, {
        currentVersionId: version.id,
        currentVersionNumber: version.number,
      });
      return { result: 'created', version };
    });
  }

  /** 검증된 사용자 UID 범위의 개발 기록 문서 참조 */
  // prettier-ignore
  private recordDocument(
    uid: string,
    request: DevelopmentRecordRollbackRequest,
  ): DocumentReference {
    return this.firestore.doc(
      `users/${uid}/developmentGoals/${request.goalId}/records/${request.recordId}`,
    );
  }
}

/** 개발 기록 문서가 가리키는 현재 version ID와 번호 */
function currentVersionPointer(
  snapshot: DocumentSnapshot,
): { id: string; number: number } | undefined {
  if (!snapshot.exists) {
    return undefined;
  }

  const id: unknown = snapshot.get('currentVersionId');
  const number: unknown = snapshot.get('currentVersionNumber');
  if (id === undefined && number === undefined) {
    return undefined;
  }
  if (typeof id !== 'string' || typeof number !== 'number') {
    throw new Error(`개발 기록 문서 값 오류: ${snapshot.ref.path}`);
  }

  return { id, number };
}

/** 존재해야 하는 version 문서를 확정 version으로 변환 */
function existingVersion(snapshot: DocumentSnapshot): DevelopmentRecordVersion {
  if (!snapshot.exists) {
    throw new Error(`개발 기록 version 없음: ${snapshot.ref.path}`);
  }

  const number: unknown = snapshot.get('versionNumber');
  const title: unknown = snapshot.get('title');
  const markdownContent: unknown = snapshot.get('markdownContent');
  const kind: unknown = snapshot.get('changeKind');
  const sourceVersionId: unknown = snapshot.get('sourceVersionId');
  const confirmedAt: unknown = snapshot.get('confirmedAt');
  if (
    typeof number !== 'number' ||
    typeof title !== 'string' ||
    typeof markdownContent !== 'string' ||
    typeof kind !== 'string' ||
    !(sourceVersionId === undefined || typeof sourceVersionId === 'string') ||
    !(confirmedAt instanceof Timestamp)
  ) {
    throw new Error(`개발 기록 version 값 오류: ${snapshot.ref.path}`);
  }

  return {
    id: snapshot.id,
    number,
    title,
    markdownContent,
    kind,
    sourceVersionId,
    confirmedAt,
  };
}
