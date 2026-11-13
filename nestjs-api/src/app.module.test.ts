import { type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import {
  applicationDefault,
  type App,
  type Credential,
  getApps,
  initializeApp,
} from 'firebase-admin/app';
import { type Auth, getAuth } from 'firebase-admin/auth';
import { type Firestore, getFirestore } from 'firebase-admin/firestore';

import { APPLE_AUTHENTICATION_CONFIGURATION_TOKEN } from './apple/apple-authentication.configuration';
import { AppleAuthenticationModule } from './apple/apple-authentication.module';
import { FirebaseAuthGuard } from './auth/firebase-auth.guard';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { AppModule } from './app.module';
import { DevelopmentGoalsModule } from './development-goals/development-goals.module';
import { GOOGLE_AUTHENTICATION_CONFIGURATION_TOKEN } from './google/google-authentication.configuration';
import { GitHubAuthenticationModule } from './github/github-authentication.module';
import { GoogleAuthenticationModule } from './google/google-authentication.module';
import { PushNotificationsModule } from './push-notifications/push-notifications.module';
import { TodosModule } from './todos/todos.module';

jest.mock('firebase-admin/app', () => ({
  applicationDefault: jest.fn(),
  getApps: jest.fn(),
  initializeApp: jest.fn(),
}));
jest.mock('firebase-admin/auth', () => ({
  getAuth: jest.fn(),
}));
jest.mock('firebase-admin/firestore', () => ({
  getFirestore: jest.fn(),
}));

const mockedApplicationDefault = jest.mocked(applicationDefault);
const mockedGetApps = jest.mocked(getApps);
const mockedInitializeApp = jest.mocked(initializeApp);
const mockedGetAuth = jest.mocked(getAuth);
const mockedGetFirestore = jest.mocked(getFirestore);

describe(AppModule.name, () => {
  beforeEach(() => {
    jest.resetAllMocks();
  });

  it('FirebaseModule을 명시적으로 구성한다', async () => {
    const app = { name: '[DEFAULT]' } as App;
    const auth = {} as Auth;
    const firestore = {} as Firestore;
    mockedGetApps.mockReturnValue([app]);
    mockedGetAuth.mockReturnValue(auth);
    mockedGetFirestore.mockReturnValue(firestore);

    const module = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(APPLE_AUTHENTICATION_CONFIGURATION_TOKEN)
      .useValue({
        teamId: 'team-id',
        clientId: 'client-id',
        keyId: 'key-id',
        privateKey: 'private-key',
      })
      .overrideProvider(GOOGLE_AUTHENTICATION_CONFIGURATION_TOKEN)
      .useValue({ clientId: 'client-id', clientSecret: 'client-secret' })
      .compile();

    expect(mockedGetAuth).toHaveBeenCalledWith(app);
    expect(mockedGetFirestore).toHaveBeenCalledWith(app);

    await module.close();
  });

  it('인증 Guard와 오류 Filter를 전역 provider로 구성한다', () => {
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      AppModule,
    ) as Provider[];

    expect(providers).toEqual(
      expect.arrayContaining([
        { provide: APP_GUARD, useClass: FirebaseAuthGuard },
        { provide: APP_FILTER, useClass: ApiExceptionFilter },
      ]),
    );
  });

  it('TodosModule을 애플리케이션에 연결한다', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    ) as unknown[];

    expect(imports).toContain(TodosModule);
  });

  it('DevelopmentGoalsModule을 애플리케이션에 연결한다', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    ) as unknown[];

    expect(imports).toContain(DevelopmentGoalsModule);
  });

  it('AppleAuthenticationModule을 애플리케이션에 연결한다', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    ) as unknown[];

    expect(imports).toContain(AppleAuthenticationModule);
  });

  it('GoogleAuthenticationModule을 애플리케이션에 연결한다', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    ) as unknown[];

    expect(imports).toContain(GoogleAuthenticationModule);
  });

  it('GitHubAuthenticationModule을 애플리케이션에 연결한다', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    ) as unknown[];

    expect(imports).toContain(GitHubAuthenticationModule);
  });

  it('PushNotificationsModule을 애플리케이션에 연결한다', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      AppModule,
    ) as unknown[];

    expect(imports).toContain(PushNotificationsModule);
  });

  it('Firebase App 초기화 오류가 발생하면 구성을 중단한다', async () => {
    const credential = {} as Credential;
    const error = new Error('Firebase App 초기화 실패');
    mockedGetApps.mockReturnValue([]);
    mockedApplicationDefault.mockReturnValue(credential);
    mockedInitializeApp.mockImplementation(() => {
      throw error;
    });

    await expect(
      Test.createTestingModule({
        imports: [AppModule],
      })
        .overrideProvider(APPLE_AUTHENTICATION_CONFIGURATION_TOKEN)
        .useValue({
          teamId: 'team-id',
          clientId: 'client-id',
          keyId: 'key-id',
          privateKey: 'private-key',
        })
        .overrideProvider(GOOGLE_AUTHENTICATION_CONFIGURATION_TOKEN)
        .useValue({ clientId: 'client-id', clientSecret: 'client-secret' })
        .compile(),
    ).rejects.toBe(error);
  });
});
