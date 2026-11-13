import { HttpStatus, Logger } from '@nestjs/common';
import { Timestamp } from 'firebase-admin/firestore';

import {
  type DevelopmentGoalCompletionOutcome,
  type DevelopmentGoalCompletionRecord,
  type DevelopmentGoalCompletionRejection,
  DevelopmentGoalsRepository,
} from './development-goals.repository';
import { DevelopmentGoalsService } from './development-goals.service';

type RejectionFrom = (
  records: DevelopmentGoalCompletionRecord[],
) => DevelopmentGoalCompletionRejection | undefined;

describe(DevelopmentGoalsService.name, () => {
  const uid = 'user-1';
  const goalId = 'goal-1';

  afterEach(() => {
    jest.restoreAllMocks();
  });

  // 전달된 개발 기록으로 판정 함수를 실행하는 Repository
  function judgingRepository(records: DevelopmentGoalCompletionRecord[]): {
    repository: DevelopmentGoalsRepository;
    completeGoal: jest.Mock;
  } {
    const completeGoal = jest
      .fn()
      .mockImplementation(
        (_uid: string, _goalId: string, rejectionFrom: RejectionFrom) =>
          Promise.resolve<DevelopmentGoalCompletionOutcome>(
            rejectionFrom(records) ?? 'completed',
          ),
      );

    return {
      repository: { completeGoal } as unknown as DevelopmentGoalsRepository,
      completeGoal,
    };
  }

  // 완료 판정 입력으로 쓰는 개발 기록
  function record(
    id: string,
    seconds: number,
    state: Partial<
      Pick<DevelopmentGoalCompletionRecord, 'hasCurrentVersion' | 'hasDraft'>
    > = {},
  ): DevelopmentGoalCompletionRecord {
    return {
      id,
      createdAt: new Timestamp(seconds, 0),
      hasCurrentVersion: state.hasCurrentVersion ?? true,
      hasDraft: state.hasDraft ?? false,
    };
  }

  it('검증된 UID와 목표 ID로 완료 조건을 충족한 목표를 완료한다', async () => {
    const { repository, completeGoal } = judgingRepository([
      record('record-1', 1),
      record('record-2', 2),
    ]);
    const service = new DevelopmentGoalsService(repository);

    await expect(service.complete(uid, goalId)).resolves.toBeUndefined();

    expect(completeGoal).toHaveBeenCalledWith(
      uid,
      goalId,
      expect.any(Function),
    );
  });

  it('이미 완료된 목표의 재요청을 성공으로 처리한다', async () => {
    const completeGoal = jest.fn().mockResolvedValue('already-completed');
    const service = new DevelopmentGoalsService({
      completeGoal,
    } as unknown as DevelopmentGoalsRepository);

    await expect(service.complete(uid, goalId)).resolves.toBeUndefined();
  });

  it('개발 기록이 없으면 완료를 거부한다', async () => {
    const { repository } = judgingRepository([]);
    const service = new DevelopmentGoalsService(repository);

    await expect(service.complete(uid, goalId)).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        code: 'development-goal-completion-requires-record',
        message: '개발 기록이 없는 개발 목표는 완료할 수 없습니다.',
      },
    });
  });

  it('생성 시각 기준 마지막 개발 기록에 확정 버전이 없으면 완료를 거부한다', async () => {
    const { repository } = judgingRepository([
      record('record-2', 2, { hasCurrentVersion: false, hasDraft: true }),
      record('record-1', 1),
    ]);
    const service = new DevelopmentGoalsService(repository);

    await expect(service.complete(uid, goalId)).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        code: 'development-goal-completion-needs-version',
        message: '마지막 개발 기록에 확정 버전이 필요합니다.',
      },
    });
  });

  it('생성 시각이 같으면 문서 ID 순서로 마지막 개발 기록을 정한다', async () => {
    const { repository } = judgingRepository([
      record('record-b', 1, { hasCurrentVersion: false, hasDraft: true }),
      record('record-a', 1),
    ]);
    const service = new DevelopmentGoalsService(repository);

    await expect(service.complete(uid, goalId)).rejects.toMatchObject({
      response: { code: 'development-goal-completion-needs-version' },
    });
  });

  it('나노초 단위로 늦은 개발 기록을 마지막 개발 기록으로 정한다', async () => {
    const { repository } = judgingRepository([
      {
        ...record('record-a', 1, { hasCurrentVersion: false, hasDraft: true }),
        createdAt: new Timestamp(1, 2),
      },
      { ...record('record-b', 1), createdAt: new Timestamp(1, 1) },
    ]);
    const service = new DevelopmentGoalsService(repository);

    await expect(service.complete(uid, goalId)).rejects.toMatchObject({
      response: { code: 'development-goal-completion-needs-version' },
    });
  });

  it('초안이 남은 개발 기록이 있으면 완료를 거부한다', async () => {
    const { repository } = judgingRepository([
      record('record-1', 1, { hasDraft: true }),
      record('record-2', 2),
    ]);
    const service = new DevelopmentGoalsService(repository);

    await expect(service.complete(uid, goalId)).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        code: 'development-goal-completion-has-draft',
        message: '확정되지 않은 초안이 있는 개발 목표는 완료할 수 없습니다.',
      },
    });
  });

  it('개발 목표가 없으면 not-found로 거부한다', async () => {
    const completeGoal = jest.fn().mockResolvedValue('missing');
    const service = new DevelopmentGoalsService({
      completeGoal,
    } as unknown as DevelopmentGoalsRepository);

    await expect(service.complete(uid, goalId)).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      response: {
        code: 'not-found',
        message: '개발 목표를 찾을 수 없습니다.',
      },
    });
  });

  it('보관된 개발 목표의 완료를 거부한다', async () => {
    const completeGoal = jest.fn().mockResolvedValue('archived');
    const service = new DevelopmentGoalsService({
      completeGoal,
    } as unknown as DevelopmentGoalsRepository);

    await expect(service.complete(uid, goalId)).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: {
        code: 'development-goal-not-in-progress',
        message: '진행 중인 개발 목표만 완료할 수 있습니다.',
      },
    });
  });

  it.each([10, 409])(
    '동시 변경으로 transaction 재시도를 소진한 오류 code %s를 aborted로 반환한다',
    async (code) => {
      const completeGoal = jest
        .fn()
        .mockRejectedValue(Object.assign(new Error('aborted'), { code }));
      const loggerError = jest
        .spyOn(Logger.prototype, 'error')
        .mockImplementation();
      const service = new DevelopmentGoalsService({
        completeGoal,
      } as unknown as DevelopmentGoalsRepository);

      await expect(service.complete(uid, goalId)).rejects.toMatchObject({
        status: HttpStatus.CONFLICT,
        response: {
          code: 'aborted',
          message: '동시 변경으로 개발 목표를 완료하지 못했습니다.',
        },
      });
      expect(loggerError).not.toHaveBeenCalled();
    },
  );

  it('그 밖의 Firestore 오류를 기록하고 internal로 반환한다', async () => {
    const error = new Error('Firestore 오류');
    const completeGoal = jest.fn().mockRejectedValue(error);
    const loggerError = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation();
    const service = new DevelopmentGoalsService({
      completeGoal,
    } as unknown as DevelopmentGoalsRepository);

    await expect(service.complete(uid, goalId)).rejects.toMatchObject({
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      response: {
        code: 'internal',
        message: '개발 목표 완료에 실패했습니다.',
      },
    });
    expect(loggerError).toHaveBeenCalledWith({
      message: '개발 목표 완료 실패',
      errorMessage: 'Firestore 오류',
      errorStack: error.stack,
      uid,
      goalId,
    });
  });
});
