import { HttpStatus, type INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type Server } from 'node:http';
import request from 'supertest';

import { configureApplication } from '../src/app.config';
import { AppModule } from '../src/app.module';
import { ApiException } from '../src/common/api.exception';
import { DevelopmentGoalsService } from '../src/development-goals/development-goals.service';
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

describe('개발 목표 완료 API', () => {
  const uid = 'user-1';
  const token = 'Firebase-ID-Token';
  const verifyIdToken = jest.fn();
  const complete = jest.fn();
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
      .overrideProvider(DevelopmentGoalsService)
      .useValue({ complete })
      .compile();

    app = module.createNestApplication();
    configureApplication(app);
    await app.init();
  });

  beforeEach(() => {
    verifyIdToken.mockReset().mockResolvedValue({ uid });
    complete.mockReset().mockResolvedValue(undefined);
  });

  afterAll(async () => {
    await app.close();
  });

  it('검증된 UID와 공백을 제거한 목표 ID로 목표를 완료한다', async () => {
    const server = app.getHttpServer() as Server;

    await request(server)
      .post('/api/goals/%20goal-1%20/complete')
      .set('Authorization', `Bearer ${token}`)
      .expect(HttpStatus.OK)
      .expect({ goalId: 'goal-1', status: 'completed' });

    expect(verifyIdToken).toHaveBeenCalledWith(token);
    expect(complete).toHaveBeenCalledWith(uid, 'goal-1');
  });

  it('공백인 목표 ID를 invalid-argument로 거부한다', async () => {
    const server = app.getHttpServer() as Server;

    await request(server)
      .post('/api/goals/%20/complete')
      .set('Authorization', `Bearer ${token}`)
      .expect(HttpStatus.BAD_REQUEST)
      .expect({ code: 'invalid-argument', message: 'goalId가 필요합니다.' });

    expect(complete).not.toHaveBeenCalled();
  });

  it('경로 구분자를 포함한 목표 ID를 invalid-argument로 거부한다', async () => {
    const server = app.getHttpServer() as Server;

    await request(server)
      .post('/api/goals/goal-1%2Frecords%2Frecord-1/complete')
      .set('Authorization', `Bearer ${token}`)
      .expect(HttpStatus.BAD_REQUEST)
      .expect({
        code: 'invalid-argument',
        message: 'goalId에 경로 구분자를 포함할 수 없습니다.',
      });

    expect(complete).not.toHaveBeenCalled();
  });

  it('인증 token이 없으면 unauthenticated로 거부한다', async () => {
    const server = app.getHttpServer() as Server;

    await request(server)
      .post('/api/goals/goal-1/complete')
      .expect(HttpStatus.UNAUTHORIZED)
      .expect({
        code: 'unauthenticated',
        message: '인증 토큰이 필요합니다.',
      });

    expect(complete).not.toHaveBeenCalled();
  });

  it('Firebase Auth 오류를 401 응답으로 보존한다', async () => {
    const server = app.getHttpServer() as Server;
    verifyIdToken.mockRejectedValue({
      code: 'auth/id-token-expired',
      message: 'Firebase ID token has expired.',
    });

    await request(server)
      .post('/api/goals/goal-1/complete')
      .set('Authorization', `Bearer ${token}`)
      .expect(HttpStatus.UNAUTHORIZED)
      .expect({
        code: 'auth/id-token-expired',
        message: 'Firebase ID token has expired.',
      });

    expect(complete).not.toHaveBeenCalled();
  });

  it.each([
    {
      status: HttpStatus.NOT_FOUND,
      code: 'not-found',
      message: '개발 목표를 찾을 수 없습니다.',
    },
    {
      status: HttpStatus.CONFLICT,
      code: 'development-goal-completion-has-draft',
      message: '확정되지 않은 초안이 있는 개발 목표는 완료할 수 없습니다.',
    },
    {
      status: HttpStatus.CONFLICT,
      code: 'aborted',
      message: '동시 변경으로 개발 목표를 완료하지 못했습니다.',
    },
    {
      status: HttpStatus.INTERNAL_SERVER_ERROR,
      code: 'internal',
      message: '개발 목표 완료에 실패했습니다.',
    },
  ])('Service의 $code 오류를 반환한다', async ({ status, code, message }) => {
    const server = app.getHttpServer() as Server;
    complete.mockRejectedValue(new ApiException(status, code, message));

    await request(server)
      .post('/api/goals/goal-1/complete')
      .set('Authorization', `Bearer ${token}`)
      .expect(status)
      .expect({ code, message });
  });
});
