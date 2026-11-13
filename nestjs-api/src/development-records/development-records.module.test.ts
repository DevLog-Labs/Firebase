import { type Provider } from '@nestjs/common';
import { MODULE_METADATA } from '@nestjs/common/constants';

import { FirebaseModule } from '../firebase/firebase.module';
import { DevelopmentRecordsController } from './development-records.controller';
import { DevelopmentRecordsModule } from './development-records.module';
import { DevelopmentRecordsRepository } from './development-records.repository';
import { DevelopmentRecordsService } from './development-records.service';

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

describe(DevelopmentRecordsModule.name, () => {
  it('FirebaseModule과 개발 기록 controller, provider를 구성한다', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      DevelopmentRecordsModule,
    ) as unknown[];
    const controllers = Reflect.getMetadata(
      MODULE_METADATA.CONTROLLERS,
      DevelopmentRecordsModule,
    ) as unknown[];
    const providers = Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      DevelopmentRecordsModule,
    ) as Provider[];

    expect(imports).toContain(FirebaseModule);
    expect(controllers).toContain(DevelopmentRecordsController);
    expect(providers).toEqual(
      expect.arrayContaining([
        DevelopmentRecordsRepository,
        DevelopmentRecordsService,
      ]),
    );
  });
});
