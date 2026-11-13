import { HttpStatus } from '@nestjs/common';
import { type App, deleteApp, initializeApp } from 'firebase-admin/app';
import {
  type DocumentReference,
  type Firestore,
  getFirestore,
  Timestamp,
} from 'firebase-admin/firestore';

import { DevelopmentRecordsRepository } from '../src/development-records/development-records.repository';
import { DevelopmentRecordsService } from '../src/development-records/development-records.service';

describe('개발 기록 rollback Firestore transaction', () => {
  const uid = 'owner';
  const goalId = 'goal-1';
  let app: App;
  let firestore: Firestore;
  let service: DevelopmentRecordsService;

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('FIRESTORE_EMULATOR_HOST가 필요합니다.');
    }

    app = initializeApp({ projectId: 'demo-devlog' }, 'development-records');
    firestore = getFirestore(app);
    service = new DevelopmentRecordsService(
      new DevelopmentRecordsRepository(firestore),
    );
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  // 확정 version 두 개를 가진 개발 기록 저장
  async function seedRecord(
    recordId: string,
    fields: Record<string, unknown> = {},
  ): Promise<DocumentReference> {
    const record = firestore.doc(
      `users/${uid}/developmentGoals/${goalId}/records/${recordId}`,
    );
    await record.set({
      createdAt: Timestamp.fromMillis(0),
      currentVersionId: 'version-2',
      currentVersionNumber: 2,
      ...fields,
    });
    await record
      .collection('versions')
      .doc('version-1')
      .set({
        versionNumber: 1,
        title: 'first',
        markdownContent: 'first content',
        changeKind: 'initial',
        confirmedAt: Timestamp.fromMillis(1),
      });
    await record
      .collection('versions')
      .doc('version-2')
      .set({
        versionNumber: 2,
        title: 'second',
        markdownContent: 'second content',
        changeKind: 'correction',
        confirmedAt: Timestamp.fromMillis(2),
      });

    return record;
  }

  // version-2를 기준으로 version-1을 되돌리는 요청
  function rollbackRequest(recordId: string): {
    goalId: string;
    recordId: string;
    sourceVersionId: string;
    expectedCurrentVersionId: string;
  } {
    return {
      goalId,
      recordId,
      sourceVersionId: 'version-1',
      expectedCurrentVersionId: 'version-2',
    };
  }

  it('rollback version 생성과 기록의 현재 version 갱신을 함께 저장한다', async () => {
    const record = await seedRecord('record-created');

    const response = await service.rollback(
      uid,
      rollbackRequest('record-created'),
    );

    expect(response).toMatchObject({
      recordId: 'record-created',
      number: 3,
      title: 'first',
      markdownContent: 'first content',
      kind: 'rollback',
      sourceVersionId: 'version-1',
    });
    const recordSnapshot = await record.get();
    expect(recordSnapshot.get('currentVersionId')).toBe(response.id);
    expect(recordSnapshot.get('currentVersionNumber')).toBe(3);
    const versionSnapshot = await record
      .collection('versions')
      .doc(response.id)
      .get();
    expect(versionSnapshot.data()).toEqual({
      versionNumber: 3,
      title: 'first',
      markdownContent: 'first content',
      changeKind: 'rollback',
      sourceVersionId: 'version-1',
      confirmedAt: expect.any(Timestamp) as unknown,
    });
    expect(
      (versionSnapshot.get('confirmedAt') as Timestamp).toDate().toISOString(),
    ).toBe(response.confirmedAt);
  });

  it('같은 rollback 재시도는 새 version 없이 기존 version을 반환한다', async () => {
    const record = await seedRecord('record-retry');
    const created = await service.rollback(
      uid,
      rollbackRequest('record-retry'),
    );
    const committed = await record.get();

    await expect(
      service.rollback(uid, rollbackRequest('record-retry')),
    ).resolves.toEqual(created);

    const versions = await record.collection('versions').get();
    expect(versions.size).toBe(3);
    const repeated = await record.get();
    expect(repeated.updateTime).toEqual(committed.updateTime);
  });

  it('같은 rollback 동시 요청은 같은 version을 반환하고 version을 하나만 만든다', async () => {
    const record = await seedRecord('record-concurrent');

    const [first, second] = await Promise.all([
      service.rollback(uid, rollbackRequest('record-concurrent')),
      service.rollback(uid, rollbackRequest('record-concurrent')),
    ]);

    expect(second).toEqual(first);
    const versions = await record.collection('versions').get();
    expect(versions.size).toBe(3);
  });

  it('현재 version이 바뀐 뒤의 이전 요청은 version-conflict로 거부하고 저장하지 않는다', async () => {
    const record = await seedRecord('record-conflict', {
      currentVersionId: 'version-3',
      currentVersionNumber: 3,
    });
    await record
      .collection('versions')
      .doc('version-3')
      .set({
        versionNumber: 3,
        title: 'third',
        markdownContent: 'third content',
        changeKind: 'correction',
        confirmedAt: Timestamp.fromMillis(3),
      });
    const before = await record.get();

    await expect(
      service.rollback(uid, rollbackRequest('record-conflict')),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: { code: 'development-record-rollback-version-conflict' },
    });

    const after = await record.get();
    expect(after.updateTime).toEqual(before.updateTime);
    const versions = await record.collection('versions').get();
    expect(versions.size).toBe(3);
  });

  it('초안이 있으면 has-draft로 거부하고 저장하지 않는다', async () => {
    const record = await seedRecord('record-draft', {
      draft: {
        title: 'draft',
        markdownContent: 'content',
        updatedAt: Timestamp.now(),
      },
    });
    const before = await record.get();

    await expect(
      service.rollback(uid, rollbackRequest('record-draft')),
    ).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: { code: 'development-record-rollback-has-draft' },
    });

    const after = await record.get();
    expect(after.updateTime).toEqual(before.updateTime);
  });

  it('다른 사용자의 같은 기록 경로는 찾지 않는다', async () => {
    await seedRecord('record-owner');

    await expect(
      service.rollback('other', rollbackRequest('record-owner')),
    ).rejects.toMatchObject({
      status: HttpStatus.NOT_FOUND,
      response: { code: 'not-found' },
    });
  });

  it('rollback 생성은 기존 확정 version 문서를 바꾸지 않는다', async () => {
    const record = await seedRecord('record-immutable');
    const versions = record.collection('versions');
    const [firstBefore, secondBefore] = await Promise.all([
      versions.doc('version-1').get(),
      versions.doc('version-2').get(),
    ]);

    await service.rollback(uid, rollbackRequest('record-immutable'));

    const [firstAfter, secondAfter] = await Promise.all([
      versions.doc('version-1').get(),
      versions.doc('version-2').get(),
    ]);
    expect(firstAfter.updateTime).toEqual(firstBefore.updateTime);
    expect(secondAfter.updateTime).toEqual(secondBefore.updateTime);
  });
});
