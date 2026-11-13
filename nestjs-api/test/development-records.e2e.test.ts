import { HttpStatus, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type Server } from 'node:http';
import request from 'supertest';

import { configureApplication } from '../src/app.config';
import { AppModule } from '../src/app.module';
import { ApiException } from '../src/common/api.exception';
import { DevelopmentRecordsService } from '../src/development-records/development-records.service';
import {
  FIREBASE_APP_TOKEN,
  FIREBASE_AUTH_TOKEN,
  FIREBASE_FIRESTORE_TOKEN,
} from '../src/firebase/firebase.tokens';

jest.mock('firebase-admin/app', () => ({
  applicationDefault: jest.fn(),
  getApps: jest.fn(),
  initializeApp: jest.fn(),
}));
jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(),
}));
jest.mock('firebase-admin/firestore', () => ({
  FieldPath: { documentId: jest.fn() },
  FieldValue: {
    delete: jest.fn(),
    serverTimestamp: jest.fn(),
  },
  getFirestore: jest.fn(),
}));

describe('개발 기록 rollback API', () => {
  const uid = 'user-1';
  const token = 'Firebase-ID-Token';
  const path = '/api/goals/goal-1/records/record-1/rollback';
  const body = {
    sourceVersionId: 'version-1',
    expectedCurrentVersionId: 'version-2',
  };
  const response = {
    id: 'version-3',
    recordId: 'record-1',
    number: 3,
    title: 'title',
    markdownContent: 'content',
    kind: 'rollback',
    sourceVersionId: 'version-1',
    confirmedAt: '2026-11-13T09:00:00.000Z',
  };
  const verifyIdToken = jest.fn();
  const rollback = jest.fn();
  let app: INestApplication;

  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(FIREBASE_APP_TOKEN)
      .useValue({})
      .overrideProvider(FIREBASE_AUTH_TOKEN)
      .useValue({ verifyIdToken })
      .overrideProvider(FIREBASE_FIRESTORE_TOKEN)
      .useValue({})
      .overrideProvider(DevelopmentRecordsService)
      .useValue({ rollback })
      .compile();

    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => {
    verifyIdToken.mockReset().mockResolvedValue({ uid });
    rollback.mockReset().mockResolvedValue(response);
  });

  afterAll(async () => {
    await app.close();
  });

  it('검증된 UID와 공백을 제거한 식별자로 rollback version을 반환한다', async () => {
    const server = app.getHttpServer() as Server;

    await request(server)
      .post('/api/goals/%20goal-1%20/records/%20record-1%20/rollback')
      .set('Authorization', `Bearer ${token}`)
      .send({
        uid: 'other',
        sourceVersionId: ' version-1 ',
        expectedCurrentVersionId: ' version-2 ',
      })
      .expect(HttpStatus.OK)
      .expect(response);

    expect(verifyIdToken).toHaveBeenCalledWith(token);
    expect(rollback).toHaveBeenCalledWith(uid, {
      goalId: 'goal-1',
      recordId: 'record-1',
      sourceVersionId: 'version-1',
      expectedCurrentVersionId: 'version-2',
    });
  });

  it.each([
    {
      name: '공백인 목표 ID',
      path: '/api/goals/%20/records/record-1/rollback',
      body,
      message: 'goalId가 필요합니다.',
    },
    {
      name: '경로 구분자를 포함한 기록 ID',
      path: '/api/goals/goal-1/records/record-1%2Fversions/rollback',
      body,
      message: 'recordId에 경로 구분자를 포함할 수 없습니다.',
    },
    {
      name: '누락된 원본 version ID',
      path,
      body: { expectedCurrentVersionId: 'version-2' },
      message: 'sourceVersionId가 필요합니다.',
    },
    {
      name: '문자열이 아닌 원본 version ID',
      path,
      body: { ...body, sourceVersionId: 1 },
      message: 'sourceVersionId가 필요합니다.',
    },
    {
      name: '경로 구분자를 포함한 원본 version ID',
      path,
      body: { ...body, sourceVersionId: 'version-1/x' },
      message: 'sourceVersionId에 경로 구분자를 포함할 수 없습니다.',
    },
    {
      name: '공백인 기준 현재 version ID',
      path,
      body: { ...body, expectedCurrentVersionId: ' ' },
      message: 'expectedCurrentVersionId가 필요합니다.',
    },
    {
      name: '배열 요청 본문',
      path,
      body: [body],
      message: 'sourceVersionId가 필요합니다.',
    },
  ])('$name를 invalid-argument로 거부한다', async ({ path, body, message }) => {
    const server = app.getHttpServer() as Server;

    await request(server)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(HttpStatus.BAD_REQUEST)
      .expect({ code: 'invalid-argument', message });

    expect(rollback).not.toHaveBeenCalled();
  });

  it('인증 token이 없으면 unauthenticated로 거부한다', async () => {
    const server = app.getHttpServer() as Server;

    await request(server)
      .post(path)
      .send(body)
      .expect(HttpStatus.UNAUTHORIZED)
      .expect({
        code: 'unauthenticated',
        message: '인증 토큰이 필요합니다.',
      });

    expect(rollback).not.toHaveBeenCalled();
  });

  it('Firebase Auth 오류를 401 응답으로 보존한다', async () => {
    const server = app.getHttpServer() as Server;
    verifyIdToken.mockRejectedValue({
      code: 'auth/id-token-expired',
      message: 'Firebase ID token has expired.',
    });

    await request(server)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(HttpStatus.UNAUTHORIZED)
      .expect({
        code: 'auth/id-token-expired',
        message: 'Firebase ID token has expired.',
      });

    expect(rollback).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: HttpStatus.NOT_FOUND,
      code: 'not-found',
      message: '개발 기록을 찾을 수 없습니다.',
    },
    {
      status: HttpStatus.CONFLICT,
      code: 'development-record-rollback-version-conflict',
      message: '개발 기록의 현재 version이 요청 기준과 다릅니다.',
    },
    {
      status: HttpStatus.CONFLICT,
      code: 'aborted',
      message: '동시 변경으로 개발 기록을 되돌리지 못했습니다.',
    },
    {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal',
      message: '개발 기록 rollback에 실패했습니다.',
    },
  ])('Service의 $code 오류를 반환한다', async ({ status, code, message }) => {
    const server = app.getHttpServer() as Server;
    rollback.mockRejectedValue(new ApiException(status, code, message));

    await request(server)
      .post(path)
      .set('Authorization', `Bearer ${token}`)
      .send(body)
      .expect(status)
      .expect({ code, message });
  });
});
