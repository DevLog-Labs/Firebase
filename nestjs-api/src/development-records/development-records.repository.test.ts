import { type Firestore, Timestamp } from 'firebase-admin/firestore';

import {
  type DevelopmentRecordRollbackDecision,
  type DevelopmentRecordRollbackRequest,
  type DevelopmentRecordRollbackState,
  DevelopmentRecordsRepository,
} from './development-records.repository';

describe(DevelopmentRecordsRepository.name, () => {
  const uid = 'user-1';
  const recordPath = 'users/user-1/developmentGoals/goal-1/records/record-1';
  const request: DevelopmentRecordRollbackRequest = {
    goalId: 'goal-1',
    recordId: 'record-1',
    sourceVersionId: 'version-1',
    expectedCurrentVersionId: 'version-2',
  };
  const confirmedAt = new Timestamp(1, 0);
  const versionsReference = { doc: jest.fn() };
  const recordReference = {
    path: recordPath,
    collection: jest.fn(),
  };
  const getAll = jest.fn();
  const transactionGet = jest.fn();
  const create = jest.fn();
  const update = jest.fn();
  const doc = jest.fn();
  const runTransaction = jest.fn();
  const repository = new DevelopmentRecordsRepository({
    doc,
    runTransaction,
  } as unknown as Firestore);

  beforeEach(() => {
    jest.resetAllMocks();
    doc.mockReturnValue(recordReference);
    recordReference.collection.mockReturnValue(versionsReference);
    versionsReference.doc.mockImplementation((id: string) => ({
      id,
      path: `${recordPath}/versions/${id}`,
    }));
    runTransaction.mockImplementation(
      (
        callback: (transaction: {
          getAll: typeof getAll;
          get: typeof transactionGet;
          create: typeof create;
          update: typeof update;
        }) => Promise<unknown>,
      ) => callback({ getAll, get: transactionGet, create, update }),
    );
  });

  // 필드 값을 가진 문서 snapshot
  function snapshot(
    path: string,
    data: Record<string, unknown> | undefined,
  ): {
    exists: boolean;
    id: string;
    ref: { path: string };
    get: (field: string) => unknown;
  } {
    return {
      exists: data !== undefined,
      id: path.split('/').pop() ?? '',
      ref: { path },
      get: (field: string) => data?.[field],
    };
  }

  // 지정한 번호의 version 문서 snapshot
  function versionSnapshot(
    id: string,
    data: Record<string, unknown> = {},
  ): ReturnType<typeof snapshot> {
    return snapshot(`${recordPath}/versions/${id}`, {
      versionNumber: Number(id.split('-').pop()),
      title: `title-${id}`,
      markdownContent: `content-${id}`,
      changeKind: 'correction',
      confirmedAt,
      ...data,
    });
  }

  // 현재 version을 가리키는 개발 기록 snapshot
  function recordSnapshot(
    data: Record<string, unknown> = {},
  ): ReturnType<typeof snapshot> {
    return snapshot(recordPath, {
      createdAt: confirmedAt,
      currentVersionId: 'version-2',
      currentVersionNumber: 2,
      ...data,
    });
  }

  it('UID 경로의 기록과 기준·원본 version을 한 번에 읽고 판정 상태를 전달한다', async () => {
    getAll.mockResolvedValue([
      recordSnapshot({ draft: { title: 'draft' } }),
      versionSnapshot('version-2'),
      versionSnapshot('version-1'),
    ]);
    const decisionFrom = jest
      .fn<DevelopmentRecordRollbackDecision, [DevelopmentRecordRollbackState]>()
      .mockReturnValue('has-draft');

    await expect(
      repository.rollbackRecord(uid, request, decisionFrom),
    ).resolves.toEqual({ result: 'has-draft' });

    expect(doc).toHaveBeenCalledWith(recordPath);
    expect(recordReference.collection).toHaveBeenCalledWith('versions');
    expect(getAll).toHaveBeenCalledWith(
      recordReference,
      { id: 'version-2', path: `${recordPath}/versions/version-2` },
      { id: 'version-1', path: `${recordPath}/versions/version-1` },
    );
    expect(transactionGet).not.toHaveBeenCalled();
    expect(decisionFrom).toHaveBeenCalledWith({
      hasRecord: true,
      hasDraft: true,
      currentVersion: {
        id: 'version-2',
        number: 2,
        title: 'title-version-2',
        markdownContent: 'content-version-2',
        kind: 'correction',
        sourceVersionId: undefined,
        confirmedAt,
      },
      hasExpectedVersion: true,
      sourceVersion: {
        id: 'version-1',
        number: 1,
        title: 'title-version-1',
        markdownContent: 'content-version-1',
        kind: 'correction',
        sourceVersionId: undefined,
        confirmedAt,
      },
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('실제 현재 version이 기준과 다를 때만 현재 version을 추가로 읽는다', async () => {
    getAll.mockResolvedValue([
      recordSnapshot({
        currentVersionId: 'version-3',
        currentVersionNumber: 3,
      }),
      versionSnapshot('version-2'),
      versionSnapshot('version-1'),
    ]);
    transactionGet.mockResolvedValue(
      versionSnapshot('version-3', {
        changeKind: 'rollback',
        sourceVersionId: 'version-1',
      }),
    );

    await expect(
      repository.rollbackRecord(uid, request, () => 'existing'),
    ).resolves.toEqual({
      result: 'existing',
      version: {
        id: 'version-3',
        number: 3,
        title: 'title-version-3',
        markdownContent: 'content-version-3',
        kind: 'rollback',
        sourceVersionId: 'version-1',
        confirmedAt,
      },
    });

    expect(transactionGet).toHaveBeenCalledWith({
      id: 'version-3',
      path: `${recordPath}/versions/version-3`,
    });
    expect(create).not.toHaveBeenCalled();
    expect(update).not.toHaveBeenCalled();
  });

  it('원본과 기준이 같은 ID이면 같은 문서를 한 번만 읽는다', async () => {
    getAll.mockResolvedValue([recordSnapshot(), versionSnapshot('version-2')]);
    const decisionFrom = jest
      .fn<DevelopmentRecordRollbackDecision, [DevelopmentRecordRollbackState]>()
      .mockReturnValue('source-not-earlier');

    await expect(
      repository.rollbackRecord(
        uid,
        { ...request, sourceVersionId: 'version-2' },
        decisionFrom,
      ),
    ).resolves.toEqual({ result: 'source-not-earlier' });

    expect(getAll).toHaveBeenCalledWith(recordReference, {
      id: 'version-2',
      path: `${recordPath}/versions/version-2`,
    });
    expect(decisionFrom.mock.calls[0][0].sourceVersion?.id).toBe('version-2');
  });

  it('기록이 없으면 버전 상태 없이 판정한다', async () => {
    getAll.mockResolvedValue([
      snapshot(recordPath, undefined),
      snapshot(`${recordPath}/versions/version-2`, undefined),
      snapshot(`${recordPath}/versions/version-1`, undefined),
    ]);
    const decisionFrom = jest
      .fn<DevelopmentRecordRollbackDecision, [DevelopmentRecordRollbackState]>()
      .mockReturnValue('missing-record');

    await expect(
      repository.rollbackRecord(uid, request, decisionFrom),
    ).resolves.toEqual({ result: 'missing-record' });

    expect(decisionFrom).toHaveBeenCalledWith({
      hasRecord: false,
      hasDraft: false,
      currentVersion: undefined,
      hasExpectedVersion: false,
      sourceVersion: undefined,
    });
  });

  it('새 rollback version 생성과 기록의 현재 version 갱신을 같은 transaction에서 처리한다', async () => {
    getAll.mockResolvedValue([
      recordSnapshot(),
      versionSnapshot('version-2'),
      versionSnapshot('version-1'),
    ]);

    const outcome = await repository.rollbackRecord(
      uid,
      request,
      () => 'create',
    );

    expect(outcome.result).toBe('created');
    if (outcome.result !== 'created') {
      return;
    }
    const { version } = outcome;
    expect(version).toEqual({
      id: expect.stringMatching(/^[0-9A-F-]{36}$/) as unknown,
      number: 3,
      title: 'title-version-1',
      markdownContent: 'content-version-1',
      kind: 'rollback',
      sourceVersionId: 'version-1',
      confirmedAt: expect.any(Timestamp) as unknown,
    });
    expect(create).toHaveBeenCalledWith(
      { id: version.id, path: `${recordPath}/versions/${version.id}` },
      {
        versionNumber: 3,
        title: 'title-version-1',
        markdownContent: 'content-version-1',
        changeKind: 'rollback',
        sourceVersionId: 'version-1',
        confirmedAt: version.confirmedAt,
      },
    );
    expect(update).toHaveBeenCalledWith(recordReference, {
      currentVersionId: version.id,
      currentVersionNumber: 3,
    });
    expect(transactionGet).not.toHaveBeenCalled();
  });

  it('transaction 재시도에서도 같은 version ID와 확정 시각을 사용한다', async () => {
    getAll.mockResolvedValue([
      recordSnapshot(),
      versionSnapshot('version-2'),
      versionSnapshot('version-1'),
    ]);
    runTransaction.mockImplementation(
      async (
        callback: (transaction: {
          getAll: typeof getAll;
          get: typeof transactionGet;
          create: typeof create;
          update: typeof update;
        }) => Promise<unknown>,
      ) => {
        const transaction = { getAll, get: transactionGet, create, update };
        await callback(transaction);
        return callback(transaction);
      },
    );

    await repository.rollbackRecord(uid, request, () => 'create');

    expect(create).toHaveBeenCalledTimes(2);
    expect(create.mock.calls[1]).toEqual(create.mock.calls[0]);
    expect(update.mock.calls[1]).toEqual(update.mock.calls[0]);
  });

  it.each([
    {
      field: 'currentVersionNumber 누락',
      data: { currentVersionNumber: undefined },
      message: `개발 기록 문서 값 오류: ${recordPath}`,
    },
    {
      field: '현재 version 번호 불일치',
      data: { currentVersionNumber: 5 },
      message: `개발 기록 문서 값 오류: ${recordPath}`,
    },
  ])('$field 개발 기록을 오류로 처리한다', async ({ data, message }) => {
    getAll.mockResolvedValue([
      recordSnapshot(data),
      versionSnapshot('version-2'),
      versionSnapshot('version-1'),
    ]);
    const decisionFrom = jest.fn();

    await expect(
      repository.rollbackRecord(uid, request, decisionFrom),
    ).rejects.toThrow(message);
    expect(decisionFrom).not.toHaveBeenCalled();
    expect(create).not.toHaveBeenCalled();
  });

  it('기록이 가리키는 현재 version 문서가 없으면 오류로 처리한다', async () => {
    getAll.mockResolvedValue([
      recordSnapshot({
        currentVersionId: 'version-3',
        currentVersionNumber: 3,
      }),
      versionSnapshot('version-2'),
      versionSnapshot('version-1'),
    ]);
    transactionGet.mockResolvedValue(
      snapshot(`${recordPath}/versions/version-3`, undefined),
    );

    await expect(
      repository.rollbackRecord(uid, request, jest.fn()),
    ).rejects.toThrow(
      `개발 기록 version 없음: ${recordPath}/versions/version-3`,
    );
  });

  it('필드 타입이 맞지 않는 version 문서를 오류로 처리한다', async () => {
    getAll.mockResolvedValue([
      recordSnapshot(),
      versionSnapshot('version-2'),
      versionSnapshot('version-1', { confirmedAt: null }),
    ]);

    await expect(
      repository.rollbackRecord(uid, request, jest.fn()),
    ).rejects.toThrow(
      `개발 기록 version 값 오류: ${recordPath}/versions/version-1`,
    );
  });
});
