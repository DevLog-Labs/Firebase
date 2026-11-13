import { HttpStatus, Logger } from '@nestjs/common';
import { Timestamp } from 'firebase-admin/firestore';

import {
  type DevelopmentRecordRollbackDecision,
  type DevelopmentRecordRollbackRequest,
  type DevelopmentRecordRollbackState,
  type DevelopmentRecordVersion,
  DevelopmentRecordsRepository,
} from './development-records.repository';
import { DevelopmentRecordsService } from './development-records.service';

type DecisionFrom = (
  state: DevelopmentRecordRollbackState,
) => DevelopmentRecordRollbackDecision;

describe(DevelopmentRecordsService.name, () => {
  const uid = 'user-1';
  const request: DevelopmentRecordRollbackRequest = {
    goalId: 'goal-1',
    recordId: 'record-1',
    sourceVersionId: 'version-1',
    expectedCurrentVersionId: 'version-2',
  };
  const confirmedAt = Timestamp.fromMillis(Date.UTC(2026, 10, 13, 9, 0, 0, 0));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 지정한 번호의 확정 version
  function version(
    id: string,
    number: number,
    fields: Partial<DevelopmentRecordVersion> = {},
  ): DevelopmentRecordVersion {
    return {
      id,
      number,
      title: `title-${id}`,
      markdownContent: `content-${id}`,
      kind: 'correction',
      sourceVersionId: undefined,
      confirmedAt,
      ...fields,
    };
  }

  // rollback 조건을 모두 충족한 개발 기록 상태
  function rollbackableState(
    fields: Partial<DevelopmentRecordRollbackState> = {},
  ): DevelopmentRecordRollbackState {
    return {
      hasRecord: true,
      hasDraft: false,
      currentVersion: version('version-2', 2),
      hasExpectedVersion: true,
      sourceVersion: version('version-1', 1),
      ...fields,
    };
  }

  // 전달된 상태로 판정 함수를 실행하고 판정 결과를 돌려주는 Repository
  function judgingRepository(state: DevelopmentRecordRollbackState): {
    repository: DevelopmentRecordsRepository;
    rollbackRecord: jest.Mock;
  } {
    const rollbackRecord = jest
      .fn()
      .mockImplementation(
        (
          _uid: string,
          _request: DevelopmentRecordRollbackRequest,
          decisionFrom: DecisionFrom,
        ) => {
          const decision = decisionFrom(state);
          if (decision === 'create') {
            return Promise.resolve({
              result: 'created',
              version: version('version-3', 3, {
                kind: 'rollback',
                sourceVersionId: 'version-1',
              }),
            });
          }
          if (decision === 'existing') {
            return Promise.resolve({
              result: 'existing',
              version: state.currentVersion,
            });
          }
          return Promise.resolve({ result: decision });
        },
      );

    return {
      repository: { rollbackRecord } as unknown as DevelopmentRecordsRepository,
      rollbackRecord,
    };
  }

  it('조건을 충족하면 새 rollback version을 응답으로 변환한다', async () => {
    const { repository, rollbackRecord } =
      judgingRepository(rollbackableState());
    const service = new DevelopmentRecordsService(repository);

    await expect(service.rollback(uid, request)).resolves.toEqual({
      id: 'version-3',
      recordId: 'record-1',
      number: 3,
      title: 'title-version-3',
      markdownContent: 'content-version-3',
      kind: 'rollback',
      sourceVersionId: 'version-1',
      confirmedAt: '2026-11-13T09:00:00.000Z',
    });
    expect(rollbackRecord).toHaveBeenCalledWith(
      uid,
      request,
      expect.any(Function),
    );
  });

  it('현재 version이 같은 원본의 rollback이면 기존 version을 반환한다', async () => {
    const current = version('version-3', 3, {
      kind: 'rollback',
      sourceVersionId: 'version-1',
    });
    const { repository } = judgingRepository(
      rollbackableState({ currentVersion: current, hasDraft: true }),
    );
    const service = new DevelopmentRecordsService(repository);

    await expect(service.rollback(uid, request)).resolves.toMatchObject({
      id: 'version-3',
      number: 3,
      kind: 'rollback',
      sourceVersionId: 'version-1',
    });
  });

  it.each([
    {
      name: '기록이 없으면',
      state: rollbackableState({ hasRecord: false }),
      status: HttpStatus.NOT_FOUND,
      code: 'not-found',
      message: '개발 기록을 찾을 수 없습니다.',
    },
    {
      name: '원본 version이 없으면',
      state: rollbackableState({ sourceVersion: undefined }),
      status: HttpStatus.NOT_FOUND,
      code: 'not-found',
      message: '원본 version을 찾을 수 없습니다.',
    },
    {
      name: '기록에 현재 version이 없으면',
      state: rollbackableState({ currentVersion: undefined }),
      status: HttpStatus.CONFLICT,
      code: 'development-record-rollback-needs-version',
      message: '확정 version이 없는 개발 기록은 되돌릴 수 없습니다.',
    },
    {
      name: '기준 현재 version 문서가 없으면',
      state: rollbackableState({ hasExpectedVersion: false }),
      status: HttpStatus.CONFLICT,
      code: 'development-record-rollback-version-conflict',
      message: '개발 기록의 현재 version이 요청 기준과 다릅니다.',
    },
    {
      name: '현재 version이 기준과 다르고 같은 rollback도 아니면',
      state: rollbackableState({ currentVersion: version('version-3', 3) }),
      status: HttpStatus.CONFLICT,
      code: 'development-record-rollback-version-conflict',
      message: '개발 기록의 현재 version이 요청 기준과 다릅니다.',
    },
    {
      name: '초안이 있으면',
      state: rollbackableState({ hasDraft: true }),
      status: HttpStatus.CONFLICT,
      code: 'development-record-rollback-has-draft',
      message: '확정되지 않은 초안이 있는 개발 기록은 되돌릴 수 없습니다.',
    },
    {
      name: '원본 version이 현재 version과 같은 번호이면',
      state: rollbackableState({ sourceVersion: version('version-1', 2) }),
      status: HttpStatus.CONFLICT,
      code: 'development-record-rollback-source-not-earlier',
      message: '현재 version보다 이전 version으로만 되돌릴 수 있습니다.',
    },
    {
      name: '원본 version이 현재 version보다 뒤이면',
      state: rollbackableState({ sourceVersion: version('version-1', 4) }),
      status: HttpStatus.CONFLICT,
      code: 'development-record-rollback-source-not-earlier',
      message: '현재 version보다 이전 version으로만 되돌릴 수 있습니다.',
    },
  ])('$name rollback을 거부한다', async ({ state, status, code, message }) => {
    const { repository } = judgingRepository(state);
    const service = new DevelopmentRecordsService(repository);

    await expect(service.rollback(uid, request)).rejects.toMatchObject({
      status,
      response: { code, message },
    });
  });

  it.each([10, 409])(
    '동시 변경으로 transaction 재시도를 소진한 오류 code %s를 aborted로 반환한다',
    async (code) => {
      const rollbackRecord = jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('aborted'), { code }));
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      const service = new DevelopmentRecordsService({
        rollbackRecord,
      } as unknown as DevelopmentRecordsRepository);

      await expect(service.rollback(uid, request)).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: {
          code: 'aborted',
          message: '동시 변경으로 개발 기록을 되돌리지 못했습니다.',
        },
      });
      expect(loggerError).not.toHaveBeenCalled();
    },
  );

  it('그 밖의 Firestore 오류를 기록하고 internal로 반환한다', async () => {
    const error = new Error('Firestore 오류');
    const rollbackRecord = jest.fn().mockRejectedValue(error);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation();
    const service = new DevelopmentRecordsService({
      rollbackRecord,
    } as unknown as DevelopmentRecordsRepository);

    await expect(service.rollback(uid, request)).rejects.toMatchObject({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      response: {
        code: 'internal',
        message: '개발 기록 rollback에 실패했습니다.',
      },
    });
    expect(loggerError).toHaveBeenCalledWith({
      message: '개발 기록 rollback 실패',
      errorMessage: 'Firestore 오류',
      errorStack: error.stack,
      uid,
      goalId: 'goal-1',
      recordId: 'record-1',
    });
  });
});
