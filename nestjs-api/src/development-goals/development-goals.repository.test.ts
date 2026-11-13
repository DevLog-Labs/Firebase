import {
  FieldValue,
  type Firestore,
  Timestamp,
} from 'firebase-admin/firestore';

import { DevelopmentGoalsRepository } from './development-goals.repository';

describe(DevelopmentGoalsRepository.name, () => {
  const uid = 'user-1';
  const goalId = 'goal-1';
  const recordsReference = {
    path: 'users/user-1/developmentGoals/goal-1/records',
  };
  const goalReference = {
    path: 'users/user-1/developmentGoals/goal-1',
    collection: jest.fn(),
  };
  const transactionGet = jest.fn();
  const update = jest.fn();
  const doc = jest.fn();
  const runTransaction = jest.fn();
  const repository = new DevelopmentGoalsRepository({
    doc,
    runTransaction,
  } as unknown as Firestore);

  beforeEach(() => {
    jest.resetAllMocks();
    doc.mockReturnValue(goalReference);
    goalReference.collection.mockReturnValue(recordsReference);
    runTransaction.mockImplementation(
      (
        callback: (transaction: {
          get: typeof transactionGet;
          update: typeof update;
        }) => Promise<unknown>,
      ) => callback({ get: transactionGet, update }),
    );
  });

  // status 값을 가진 개발 목표 snapshot
  function goalSnapshot(status: unknown): {
    exists: true;
    get: (field: string) => unknown;
  } {
    return {
      exists: true,
      get: (field: string) => (field === 'status' ? status : undefined),
    };
  }

  // 필드 값을 가진 개발 기록 snapshot
  function recordSnapshot(
    id: string,
    data: Record<string, unknown>,
  ): {
    id: string;
    ref: { path: string };
    get: (field: string) => unknown;
  } {
    return {
      id,
      ref: { path: `${recordsReference.path}/${id}` },
      get: (field: string) => data[field],
    };
  }

  it('목표가 없으면 개발 기록을 읽지 않고 missing을 반환한다', async () => {
    transactionGet.mockResolvedValueOnce({ exists: false });
    const rejectionFrom = jest.fn();

    await expect(
      repository.completeGoal(uid, goalId, rejectionFrom),
    ).resolves.toBe('missing');

    expect(doc).toHaveBeenCalledWith('users/user-1/developmentGoals/goal-1');
    expect(transactionGet).toHaveBeenCalledTimes(1);
    expect(rejectionFrom).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it.each([
    { status: 'completed', expected: 'already-completed' },
    { status: 'archived', expected: 'archived' },
  ])(
    '$status 목표는 개발 기록을 읽지 않고 $expected를 반환한다',
    async ({ status, expected }) => {
      transactionGet.mockResolvedValueOnce(goalSnapshot(status));
      const rejectionFrom = jest.fn();

      await expect(
        repository.completeGoal(uid, goalId, rejectionFrom),
      ).resolves.toBe(expected);

      expect(transactionGet).toHaveBeenCalledTimes(1);
      expect(rejectionFrom).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
    },
  );

  it.each([undefined, 'unknown'])(
    '알 수 없는 목표 status %s를 오류로 처리한다',
    async (status) => {
      transactionGet.mockResolvedValueOnce(goalSnapshot(status));

      await expect(
        repository.completeGoal(uid, goalId, jest.fn()),
      ).rejects.toThrow(`개발 목표 status 값 오류: ${String(status)}`);
      expect(update).not.toHaveBeenCalled();
    },
  );

  it('같은 transaction에서 읽은 개발 기록 상태로 판정한다', async () => {
    const createdAt = new Timestamp(1, 0);
    transactionGet
      .mockResolvedValueOnce(goalSnapshot('inProgress'))
      .mockResolvedValueOnce({
        docs: [
          recordSnapshot('record-1', {
            createdAt,
            currentVersionId: 'version-1',
            currentVersionNumber: 1,
          }),
          recordSnapshot('record-2', {
            createdAt,
            draft: { title: 'draft' },
          }),
        ],
      });
    const rejectionFrom = jest.fn().mockReturnValue('has-draft');

    await expect(
      repository.completeGoal(uid, goalId, rejectionFrom),
    ).resolves.toBe('has-draft');

    expect(transactionGet).toHaveBeenNthCalledWith(1, goalReference);
    expect(goalReference.collection).toHaveBeenCalledWith('records');
    expect(transactionGet).toHaveBeenNthCalledWith(2, recordsReference);
    expect(rejectionFrom).toHaveBeenCalledWith([
      {
        id: 'record-1',
        createdAt,
        hasCurrentVersion: true,
        hasDraft: false,
      },
      {
        id: 'record-2',
        createdAt,
        hasCurrentVersion: false,
        hasDraft: true,
      },
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it('완료 조건을 충족하면 목표 상태와 완료 시각을 기록한다', async () => {
    transactionGet
      .mockResolvedValueOnce(goalSnapshot('inProgress'))
      .mockResolvedValueOnce({
        docs: [
          recordSnapshot('record-1', {
            createdAt: new Timestamp(1, 0),
            currentVersionId: 'version-1',
            currentVersionNumber: 1,
            draft: null,
          }),
        ],
      });

    await expect(
      repository.completeGoal(uid, goalId, () => undefined),
    ).resolves.toBe('completed');

    expect(update).toHaveBeenCalledWith(goalReference, {
      status: 'completed',
      completedAt: FieldValue.serverTimestamp(),
      updatedAt: FieldValue.serverTimestamp(),
    });
  });

  it.each([
    {
      field: 'createdAt 누락',
      data: { currentVersionId: 'version-1', currentVersionNumber: 1 },
    },
    {
      field: 'currentVersionNumber 누락',
      data: { createdAt: new Timestamp(1, 0), currentVersionId: 'version-1' },
    },
    {
      field: 'currentVersionId 누락',
      data: { createdAt: new Timestamp(1, 0), currentVersionNumber: 1 },
    },
  ])('$field 개발 기록을 오류로 처리한다', async ({ data }) => {
    transactionGet
      .mockResolvedValueOnce(goalSnapshot('inProgress'))
      .mockResolvedValueOnce({ docs: [recordSnapshot('record-1', data)] });
    const rejectionFrom = jest.fn();

    await expect(
      repository.completeGoal(uid, goalId, rejectionFrom),
    ).rejects.toThrow(
      '개발 기록 문서 값 오류: users/user-1/developmentGoals/goal-1/records/record-1',
    );
    expect(rejectionFrom).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });
});
