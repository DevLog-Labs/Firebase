import { HttpStatus } from '@nestjs/common';
import { type App, deleteApp, initializeApp } from 'firebase-admin/app';
import {
  type DocumentReference,
  type Firestore,
  getFirestore,
  Timestamp,
} from 'firebase-admin/firestore';

import { DevelopmentGoalsRepository } from '../src/development-goals/development-goals.repository';
import { DevelopmentGoalsService } from '../src/development-goals/development-goals.service';

describe('개발 목표 완료 Firestore transaction', () => {
  const uid = 'owner';
  let app: App;
  let firestore: Firestore;
  let service: DevelopmentGoalsService;

  beforeAll(() => {
    if (!process.env.FIRESTORE_EMULATOR_HOST) {
      throw new Error('FIRESTORE_EMULATOR_HOST가 필요합니다.');
    }

    app = initializeApp({ projectId: 'demo-devlog' }, 'development-goals');
    firestore = getFirestore(app);
    service = new DevelopmentGoalsService(
      new DevelopmentGoalsRepository(firestore),
    );
  });

  afterAll(async () => {
    await deleteApp(app);
  });

  // 진행 중 개발 목표와 개발 기록 저장
  async function seedGoal(
    goalId: string,
    records: Record<string, Record<string, unknown>>,
  ): Promise<DocumentReference> {
    const goal = firestore.doc(`users/${uid}/developmentGoals/${goalId}`);
    await goal.set({
      title: 'goal',
      markdownDescription: '',
      status: 'inProgress',
      createdAt: Timestamp.fromMillis(0),
      updatedAt: Timestamp.fromMillis(0),
    });
    for (const [recordId, data] of Object.entries(records)) {
      await goal.collection('records').doc(recordId).set(data);
    }

    return goal;
  }

  // 확정 버전만 가진 개발 기록 데이터
  function confirmedRecord(millis: number): Record<string, unknown> {
    return {
      createdAt: Timestamp.fromMillis(millis),
      currentVersionId: 'version-1',
      currentVersionNumber: 1,
    };
  }

  // 개발 기록에 저장하는 초안 데이터
  function draftData(): Record<string, unknown> {
    return {
      title: 'draft',
      markdownContent: 'content',
      updatedAt: Timestamp.now(),
    };
  }

  it('완료 조건을 충족한 목표의 상태와 완료 시각을 기록한다', async () => {
    const goal = await seedGoal('goal-completed', {
      'record-1': confirmedRecord(1),
      'record-2': confirmedRecord(2),
    });

    await expect(
      service.complete(uid, 'goal-completed'),
    ).resolves.toBeUndefined();

    const snapshot = await goal.get();
    expect(snapshot.get('status')).toBe('completed');
    expect(snapshot.get('completedAt')).toBeInstanceOf(Timestamp);
    expect(snapshot.get('updatedAt')).not.toEqual(Timestamp.fromMillis(0));
  });

  it('초안이 남은 개발 기록이 있으면 목표 문서를 바꾸지 않는다', async () => {
    const goal = await seedGoal('goal-draft', {
      'record-1': { ...confirmedRecord(1), draft: draftData() },
      'record-2': confirmedRecord(2),
    });
    const before = await goal.get();

    await expect(service.complete(uid, 'goal-draft')).rejects.toMatchObject({
      status: HttpStatus.CONFLICT,
      response: { code: 'development-goal-completion-has-draft' },
    });

    const after = await goal.get();
    expect(after.updateTime).toEqual(before.updateTime);
    expect(after.get('status')).toBe('inProgress');
  });

  it('다른 사용자의 같은 목표 ID는 찾지 않는다', async () => {
    await seedGoal('goal-owner', { 'record-1': confirmedRecord(1) });

    await expect(service.complete('other', 'goal-owner')).rejects.toMatchObject(
      {
        status: HttpStatus.NOT_FOUND,
        response: { code: 'not-found' },
      },
    );
  });

  it('같은 목표의 동시 완료 요청은 모두 성공하고 완료 시각을 한 번만 기록한다', async () => {
    const goal = await seedGoal('goal-concurrent', {
      'record-1': confirmedRecord(1),
    });

    await expect(
      Promise.all([
        service.complete(uid, 'goal-concurrent'),
        service.complete(uid, 'goal-concurrent'),
      ]),
    ).resolves.toEqual([undefined, undefined]);

    const completed = await goal.get();
    expect(completed.get('status')).toBe('completed');

    await expect(
      service.complete(uid, 'goal-concurrent'),
    ).resolves.toBeUndefined();
    const repeated = await goal.get();
    expect(repeated.updateTime).toEqual(completed.updateTime);
  });

  it('완료 요청과 초안 저장이 동시에 일어나도 판정 결과와 목표 상태가 일치한다', async () => {
    const goal = await seedGoal('goal-race', {
      'record-1': confirmedRecord(1),
    });
    const record = goal.collection('records').doc('record-1');

    const [completion, draftSave] = await Promise.allSettled([
      service.complete(uid, 'goal-race'),
      record.update({ draft: draftData() }),
    ]);

    expect(draftSave.status).toBe('fulfilled');
    const snapshot = await goal.get();
    if (completion.status === 'fulfilled') {
      expect(snapshot.get('status')).toBe('completed');
    } else {
      expect(completion.reason).toMatchObject({
        status: HttpStatus.CONFLICT,
        response: { code: 'development-goal-completion-has-draft' },
      });
      expect(snapshot.get('status')).toBe('inProgress');
    }
  });
});
