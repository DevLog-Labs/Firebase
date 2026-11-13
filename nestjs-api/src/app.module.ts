import { Module } from '@nestjs/common';
import { APP_FILTER, APP_GUARD } from '@nestjs/core';

import { AppleAuthenticationModule } from './apple/apple-authentication.module';
import { FirebaseAuthGuard } from './auth/firebase-auth.guard';
import { ApiExceptionFilter } from './common/api-exception.filter';
import { FirebaseModule } from './firebase/firebase.module';
import { GitHubAuthenticationModule } from './github/github-authentication.module';
import { GoogleAuthenticationModule } from './google/google-authentication.module';
import { PushNotificationsModule } from './push-notifications/push-notifications.module';
import { TodosModule } from './todos/todos.module';

/** 애플리케이션의 최상위 의존성 경계를 구성하는 모듈입니다. */
@Module({
  imports: [
    AppleAuthenticationModule,
    FirebaseModule,
    GitHubAuthenticationModule,
    GoogleAuthenticationModule,
    PushNotificationsModule,
    TodosModule,
  ],
  providers: [
    { provide: APP_GUARD, useClass: FirebaseAuthGuard },
    { provide: APP_FILTER, useClass: ApiExceptionFilter },
  ],
})
export class AppModule {}
