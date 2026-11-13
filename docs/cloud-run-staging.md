# `api-v2` 스테이징 수동 배포

## 범위

- 프로젝트: `devlog-staging`
- 서비스: `api-v2`
- region: `asia-northeast3`
- 런타임 service account: `http-api-runtime`
- 자원: request-based billing, 1 vCPU, 512 MiB, min instances 0, max instances 3, concurrency 80, timeout 60초, port 8080
- 제외: Production, Firebase Hosting, 실제 배포 자동화
- Apple 인증 경로: `/api/auth/apple/**`
- GitHub 인증 경로: `/api/auth/github/**`

## 권한과 인증

- 런타임 service account에는 project 단위 `roles/datastore.user`, `roles/firebaseauth.admin`을 부여합니다.
- Firebase Admin SDK가 ADC로 custom token을 서명할 수 있도록 런타임 service account 자신에 대해 `roles/iam.serviceAccountTokenCreator`를 부여합니다.
- `GOOGLE_OAUTH_CONFIG` Secret에 대해 런타임 service account에 `roles/secretmanager.secretAccessor`를 부여합니다.
- `APPLE_AUTH_CONFIG` Secret에 대해 런타임 service account에 `roles/secretmanager.secretAccessor`를 부여합니다.
- `GITHUB_OAUTH_CONFIG` Secret에 대해 런타임 service account에 `roles/secretmanager.secretAccessor`를 부여합니다.
- 배포 실행자에는 `roles/run.sourceDeveloper`, `roles/serviceusage.serviceUsageConsumer`, 런타임 및 build service account 각각에 대한 `roles/iam.serviceAccountUser`가 필요합니다.
- build service account에는 `roles/run.builder`가 필요합니다.
- 최초 공개 설정에는 `run.services.create`, `run.services.update`, `run.services.setIamPolicy` 권한이 필요하며 `roles/run.admin`에 포함됩니다.
- Cloud Run에서는 ADC를 사용합니다. service account key와 `GOOGLE_APPLICATION_CREDENTIALS`는 사용하지 않습니다.
- Cloud Run 주소는 공개하되 모든 업무 요청은 `FirebaseAuthGuard`가 Firebase ID Token으로 인증합니다.

## 배포 전 점검

배포 환경과 runtime 및 build service account를 확인합니다. account 주소와 명령 출력은 저장소에 기록하지 않습니다.

```bash
gcloud --version
gcloud auth list --filter=status:ACTIVE --format='value(account)'
gcloud billing projects describe devlog-staging --format='value(billingEnabled)'
gcloud services list \
	--enabled \
	--project devlog-staging \
	--format='value(config.name)' \
| grep -E '^(run|cloudbuild|artifactregistry|secretmanager|identitytoolkit|iamcredentials)\.googleapis\.com$'

read -r -p "Runtime service account email: " RUNTIME_SERVICE_ACCOUNT
gcloud iam service-accounts describe "$RUNTIME_SERVICE_ACCOUNT" \
	--project devlog-staging \
	--format='value(disabled)'

read -r -p "Build service account email: " BUILD_SERVICE_ACCOUNT
gcloud iam service-accounts describe "$BUILD_SERVICE_ACCOUNT" \
	--project devlog-staging \
	--format='value(disabled)'

gcloud projects get-iam-policy devlog-staging \
	--flatten='bindings[].members' \
	--filter="bindings.members:serviceAccount:${RUNTIME_SERVICE_ACCOUNT} AND (bindings.role:roles/datastore.user OR bindings.role:roles/firebaseauth.admin)" \
	--format='value(bindings.role)'

gcloud iam service-accounts get-iam-policy "$RUNTIME_SERVICE_ACCOUNT" \
	--project devlog-staging \
	--flatten='bindings[].members' \
	--filter="bindings.members:serviceAccount:${RUNTIME_SERVICE_ACCOUNT} AND bindings.role:roles/iam.serviceAccountTokenCreator" \
	--format='value(bindings.role)'

gcloud secrets get-iam-policy GOOGLE_OAUTH_CONFIG \
	--project devlog-staging \
	--flatten='bindings[].members' \
	--filter="bindings.members:serviceAccount:${RUNTIME_SERVICE_ACCOUNT} AND bindings.role:roles/secretmanager.secretAccessor" \
	--format='value(bindings.role)'

gcloud secrets get-iam-policy APPLE_AUTH_CONFIG \
	--project devlog-staging \
	--flatten='bindings[].members' \
	--filter="bindings.members:serviceAccount:${RUNTIME_SERVICE_ACCOUNT} AND bindings.role:roles/secretmanager.secretAccessor" \
	--format='value(bindings.role)'

gcloud secrets get-iam-policy GITHUB_OAUTH_CONFIG \
	--project devlog-staging \
	--flatten='bindings[].members' \
	--filter="bindings.members:serviceAccount:${RUNTIME_SERVICE_ACCOUNT} AND bindings.role:roles/secretmanager.secretAccessor" \
	--format='value(bindings.role)'

gcloud secrets versions list GOOGLE_OAUTH_CONFIG \
	--project devlog-staging \
	--filter='state=ENABLED' \
	--format='value(name)'

gcloud secrets versions list APPLE_AUTH_CONFIG \
	--project devlog-staging \
	--filter='state=ENABLED' \
	--format='value(name)'

gcloud secrets versions list GITHUB_OAUTH_CONFIG \
	--project devlog-staging \
	--filter='state=ENABLED' \
	--format='value(name)'
```

결제는 `True`, 두 service account의 비활성 상태는 각각 `False`, 필수 API 여섯 개, 앞 절에서 확인한 권한과 `GOOGLE_OAUTH_CONFIG`, `APPLE_AUTH_CONFIG`, `GITHUB_OAUTH_CONFIG`의 활성 version 조회가 모두 출력되어야 합니다. 실행자와 build service account에는 앞 절의 권한이 있어야 합니다.

작업 트리가 비어 있는지 확인하고 배포할 commit을 기록합니다.

```bash
git status --short
git rev-parse HEAD
```

`nestjs-api` 검증을 마칩니다.

```bash
cd nestjs-api
npm ci
npm run lint
npm run build
npm test -- --runInBand
npm run test:e2e -- --runInBand
cd ..
```

`api-v2`가 이미 존재하면 배포 전에 트래픽 100%를 받는 revision을 기록합니다. 첫 배포라면 이전 revision이 없음을 확인합니다.

```bash
gcloud run services list \
	--project devlog-staging \
	--region asia-northeast3 \
	--filter='metadata.name=api-v2' \
	--format='table(metadata.name,status.latestReadyRevisionName,status.traffic[].revisionName,status.traffic[].percent)'
```

## 배포

앞에서 입력한 전체 runtime 및 build service account email을 사용합니다.

```bash
gcloud run deploy api-v2 \
	--source nestjs-api \
	--build-service-account "projects/devlog-staging/serviceAccounts/${BUILD_SERVICE_ACCOUNT}" \
	--project devlog-staging \
	--region asia-northeast3 \
	--service-account "$RUNTIME_SERVICE_ACCOUNT" \
	--cpu 1 \
	--memory 512Mi \
	--cpu-throttling \
	--cpu-boost \
	--min 0 \
	--max 3 \
	--concurrency 80 \
	--timeout 60s \
	--port 8080 \
	--ingress all \
	--no-invoker-iam-check \
	--set-secrets=GOOGLE_OAUTH_CONFIG=GOOGLE_OAUTH_CONFIG:latest,APPLE_AUTH_CONFIG=APPLE_AUTH_CONFIG:latest,GITHUB_OAUTH_CONFIG=GITHUB_OAUTH_CONFIG:latest

unset RUNTIME_SERVICE_ACCOUNT BUILD_SERVICE_ACCOUNT
```

배포 후 주소와 최신 revision을 확인합니다.

```bash
gcloud run services describe api-v2 \
	--project devlog-staging \
	--region asia-northeast3 \
	--format='table(status.url,status.latestReadyRevisionName,status.traffic)'
```

region, runtime 및 build service account, Secret 연결 이름과 version 참조, CPU, 메모리, min/max instance, concurrency, timeout, port, ingress와 Invoker IAM 설정이 앞의 배포 명령과 같아야 합니다. Secret payload는 조회하지 않습니다. 하나라도 다르면 Firebase Hosting 라우팅을 진행하지 않고 `api-v2` 설정을 먼저 수정합니다.

## 직접 호출 검증

검증 뒤 폐기할 수 있는 Staging Todo와 PushNotification ID를 준비합니다. 각 문서는 삭제 요청 전 활성 상태여야 합니다. Firebase ID Token은 화면, shell history, 명령 인자에 남기지 않습니다.

```bash
read -r -p "Staging Todo ID: " TODO_ID
read -r -p "Staging PushNotification ID: " PUSH_NOTIFICATION_ID
read -r -s -p "Firebase ID Token: " FIREBASE_ID_TOKEN
printf '\n'

SERVICE_URL="$(gcloud run services describe api-v2 \
	--project devlog-staging \
	--region asia-northeast3 \
	--format='value(status.url)')"

curl -i -X POST \
	-H 'Content-Type: application/json' \
	-d '{}' \
	"${SERVICE_URL}/api/auth/google/authorization-code/custom-token"

curl -i -X POST \
	-H 'Content-Type: application/json' \
	-d '{"serverAuthCode":"invalid-server-auth-code"}' \
	"${SERVICE_URL}/api/auth/google/authorization-code/custom-token"

curl -i -X POST \
	"${SERVICE_URL}/api/auth/apple/challenges"

curl -i -X POST \
	-H 'Content-Type: application/json' \
	-d '{}' \
	"${SERVICE_URL}/api/auth/apple/custom-token"

curl -i -X PUT \
	"${SERVICE_URL}/api/auth/apple/account-link"

curl -i -X DELETE \
	"${SERVICE_URL}/api/auth/apple/account-link"

curl -i -X POST \
	"${SERVICE_URL}/api/auth/apple/access-token"

curl -i -X POST \
	"${SERVICE_URL}/api/auth/apple/refresh-token"

curl -i -X DELETE \
	"${SERVICE_URL}/api/auth/apple/access-token"

curl -i -X DELETE \
	"${SERVICE_URL}/api/auth/google/account-link"

curl -i -X DELETE \
	"${SERVICE_URL}/api/auth/google/access-token"

curl -i -X POST \
	-H 'Content-Type: application/json' \
	-d '{}' \
	"${SERVICE_URL}/api/auth/github/sign-in-sessions"

curl -i \
	"${SERVICE_URL}/api/auth/github/callback"

curl -i -X POST \
	-H 'Content-Type: application/json' \
	-d '{}' \
	"${SERVICE_URL}/api/auth/github/custom-token"

curl -i -X POST \
	-H 'Content-Type: application/json' \
	-d '{"appChallenge":"route-check"}' \
	"${SERVICE_URL}/api/auth/github/account-link-sessions"

curl -i -X PUT \
	"${SERVICE_URL}/api/auth/github/account-link"

curl -i -X DELETE \
	"${SERVICE_URL}/api/auth/github/account-link"

curl -i -X DELETE \
	"${SERVICE_URL}/api/auth/github/access-token"

curl -i -X POST \
	"${SERVICE_URL}/api/todos/${TODO_ID}/deletion-request"

curl -i -X POST \
	-H @- \
	"${SERVICE_URL}/api/todos/${TODO_ID}/deletion-request" \
	<<<"Authorization: Bearer ${FIREBASE_ID_TOKEN}"

curl -i -X DELETE \
	-H @- \
	"${SERVICE_URL}/api/todos/${TODO_ID}/deletion-request" \
	<<<"Authorization: Bearer ${FIREBASE_ID_TOKEN}"

curl -i -X POST \
	-H @- \
	"${SERVICE_URL}/api/push-notifications/${PUSH_NOTIFICATION_ID}/deletion-request" \
	<<<"Authorization: Bearer ${FIREBASE_ID_TOKEN}"

curl -i -X DELETE \
	-H @- \
	"${SERVICE_URL}/api/push-notifications/${PUSH_NOTIFICATION_ID}/deletion-request" \
	<<<"Authorization: Bearer ${FIREBASE_ID_TOKEN}"

unset FIREBASE_ID_TOKEN TODO_ID PUSH_NOTIFICATION_ID SERVICE_URL
```

응답을 다음 순서로 확인합니다.

1. body가 빈 Google custom token `POST`: `400`, `invalid-argument`
2. 잘못된 `serverAuthCode`를 전달한 Google custom token `POST`: `401`, `invalid-google-proof`
3. Apple challenge `POST`: `200`, `challengeId`, `hashedNonce`, `expiresAt` 필드가 존재
4. Apple custom token `POST`에서 `challengeId`/`idToken` 식별 값이 비어 있을 경우: `400`, `invalid-argument`
5. Token이 없는 Apple account-link `PUT`/`DELETE`, access-token `POST`/`DELETE`, refresh-token `POST`: 각각 `401`
6. Token이 없는 Google account-link와 access-token `DELETE`: 각각 `401`
7. body가 빈 GitHub 로그인 session `POST`: `400`, `invalid-argument`
8. query가 빈 GitHub callback `GET`: `302`, `devlog://oauth-callback?error=oauth-failed`
9. body가 빈 GitHub custom token `POST`: `400`, `invalid-argument`
10. Token이 없는 GitHub 계정 연결 session `POST`: `401`, `unauthenticated`
11. Token이 없는 GitHub account-link `PUT`: `401`, `unauthenticated`
12. Token이 없는 GitHub account-link `DELETE`: `401`, `unauthenticated`
13. Token이 없는 GitHub access-token `DELETE`: `401`, `unauthenticated`
14. Token이 없는 Todo `POST`: `401`
15. Token이 있는 Todo `POST`와 `DELETE`: 각각 `200`, `{"success":true}`
16. Token이 있는 PushNotification `POST`와 `DELETE`: 각각 `200`, `{"success":true}`
17. 각 `DELETE` 뒤 Todo와 연결 알림 및 PushNotification의 삭제 상태 복구

유효한 Firebase ID Token과 일회용 인증 값이 필요한 Google custom token, account-link, account-link 해제, access-token 폐기와 Apple challenge, custom token, account-link, account-link 해제, access-token 갱신·폐기 및 refresh-token 성공 경로, GitHub 로그인·계정 연결·연결 해제·grant 폐기 성공 경로는 Staging 앱에서 별도로 확인합니다. Token과 인증 코드는 로그와 shell history에 남기지 않습니다.

오류 로그가 한 항목의 `jsonPayload`로 수집되는지 확인합니다.

```bash
LATEST_REVISION="$(gcloud run services describe api-v2 \
	--project devlog-staging \
	--region asia-northeast3 \
	--format='value(status.latestReadyRevisionName)')"

gcloud logging read \
	"resource.type=\"cloud_run_revision\" AND resource.labels.service_name=\"api-v2\" AND resource.labels.revision_name=\"${LATEST_REVISION}\"" \
	--project devlog-staging \
	--freshness=10m \
	--limit=50 \
	--format=json

unset LATEST_REVISION
```

각 오류는 물리적인 줄바꿈과 ANSI 제어 문자 없이 하나의 로그 항목에 수집되어야 합니다. 스택에 포함된 줄바꿈은 `errorStack` 문자열 내부에 보존되어야 합니다.

하나라도 실패하면 Firebase Hosting 라우팅을 진행하지 않습니다. 첫 배포에서 Token이 없는 Todo `POST`가 `401`이 아니면 Cloud Run Invoker IAM 검사를 즉시 다시 활성화해 직접 주소의 무인증 호출을 차단합니다.

## 롤백 경계

`api-v2` 변경은 다음 순서로만 확정합니다.

1. 로컬 검증을 통과한 commit을 Cloud Run `api-v2`에 배포하고 세 Secret을 연결합니다.
2. 최신 revision이 `Ready`이고 트래픽 100%를 받는지 확인합니다.
3. Cloud Run 직접 호출에서 Google·Apple·GitHub 인증 경로 검증이 통과하는지 확인합니다.
4. `firebase-hosting-staging.md`에 따라 Staging Hosting만 배포합니다.
5. Hosting 경유 요청이 최신 revision과 Functions `api`에 의도한 경계대로 기록되는지 확인합니다.

Functions `api`와 Production은 이 순서의 배포 범위에 포함하지 않습니다. Hosting 배포 전 실패하면 Hosting을 변경하지 않고 `api-v2`를 수정하거나 해당 서비스의 이전 정상 revision으로 복구합니다. Hosting 전환 이후에도 [`revision 복구`](#revision-복구)를 따릅니다.

```bash
gcloud run services update api-v2 \
	--project devlog-staging \
	--region asia-northeast3 \
	--invoker-iam-check
```

Token이 없는 요청이 `403`이면 Cloud Run 공개 설정이 적용되지 않은 상태입니다. 원인을 수정한 뒤 배포 명령을 다시 실행해 공개 설정을 적용하고 직접 호출 검증 전체를 반복합니다. 인증된 `POST` 성공 뒤 `DELETE`가 실패한 첫 배포는 수정본을 다시 배포한 뒤 실패한 경로의 `DELETE`부터 실행합니다. 이후 배포에서는 해당 API를 지원하는 이전 revision으로 복구한 뒤 같은 `DELETE`를 실행합니다. Todo와 연결 알림 및 PushNotification의 삭제 상태가 복구됐는지 확인한 뒤 직접 호출 검증을 다시 수행합니다.

## revision 복구

첫 배포에서 Token이 없는 `POST`의 인증 검증에 실패하면 앞 절의 비공개 전환을 마친 뒤 수정본을 다시 배포합니다. 다른 첫 배포 검증에 실패하면 수정본을 다시 배포합니다. 이후 배포 검증에 실패하면 기록한 revision으로 트래픽을 되돌립니다.

```bash
read -r -p "Previous revision: " PREVIOUS_REVISION

gcloud run services update-traffic api-v2 \
	--project devlog-staging \
	--region asia-northeast3 \
	--to-revisions "${PREVIOUS_REVISION}=100"

unset PREVIOUS_REVISION
```

rollback 뒤 수정본을 배포하면 이전 트래픽 정책이 유지될 수 있습니다. 수정본 배포가 끝나면 최신 revision으로 트래픽을 명시적으로 전환하고 직접 호출 검증을 다시 수행합니다.

```bash
gcloud run services update-traffic api-v2 \
	--project devlog-staging \
	--region asia-northeast3 \
	--to-latest
```
