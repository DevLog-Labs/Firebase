import { type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';

import { FirebaseModule } from '../firebase/firebase.module';
import { DevelopmentGoalsController } from './development-goals.controller';
import { DevelopmentGoalsModule } from './development-goals.module';
import { DevelopmentGoalsRepository } from './development-goals.repository';
import { DevelopmentGoalsService } from './development-goals.service';

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

describe(DevelopmentGoalsModule.name, () => {
  it('FirebaseModule과 개발 목표 controller, provider를 구성한다', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      DevelopmentGoalsModule,
    ) as unknown[];
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      DevelopmentGoalsModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      DevelopmentGoalsModule,
    ) as Provider[];

    expect(imports).toContain(FirebaseModule);
    expect(controllers).toContain(DevelopmentGoalsController);
    expect(providers).toEqual(
      expect.arrayContaining([
        DevelopmentGoalsRepository,
        DevelopmentGoalsService,
      ]),
    );
  });
});
