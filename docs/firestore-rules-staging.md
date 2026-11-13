# Staging Firestore rules 배포

## 범위

- Firebase project: `devlog-staging`
- database: `(default)`
- 규칙 파일: `firestore.rules`
- 포함 규칙: 클라이언트의 개발 목표 `completed` 저장 차단, 개발 기록 확정 버전의 갱신과 삭제 차단, 개발 목표와 개발 기록의 삭제 차단
- 제외: Production project, Firestore index, Functions, Hosting, Cloud Run 배포

이 문서는 `firestore.rules`의 Staging 단독 배포와 확인 및 복구 절차를 기록합니다. 규칙 배포는 `firestore.rules` 전체를 한 번에 교체하므로 아직 Staging에 배포하지 않은 이전 규칙 변경도 함께 반영됩니다.

## 선행 조건

개발 목표 완료는 이 규칙 배포 뒤 서버 API로만 가능합니다. 다음 항목이 모두 확인된 뒤에 배포합니다.

1. [Cloud Run Staging 수동 배포 절차](./cloud-run-staging.md)의 직접 호출 검증에서 개발 목표 완료 `POST`가 `401`과 `404`로 응답
2. [Staging Firebase Hosting API 라우팅](./firebase-hosting-staging.md)의 배포 후 요청 검증에서 `/api/goals/**`가 Cloud Run `api-v2`로 전달
3. Staging 앱 빌드가 개발 목표 완료를 서버 API로 요청하고 `completed`를 Firestore에 직접 저장하지 않음

하나라도 확인되지 않으면 규칙을 배포하지 않습니다.

## 설정 확인

규칙 구조 시험과 Firestore emulator 허용·거부 시험을 실행합니다.

```bash
cd functions
npm run build
npm run test:run
npm run test:rules
cd ..
```

`firebase.json`의 `firestore` 설정이 `(default)` database와 `firestore.rules`를 가리키는지 확인합니다.

```bash
git diff -- firestore.rules firebase.json
```

배포 전에 Firebase Console의 Staging Firestore 규칙 화면에서 현재 게시된 규칙 버전과 게시 시각을 기록합니다. 복구할 때 이 버전을 다시 게시합니다.

## Staging 규칙 배포

현재 로그인 상태와 대상 project를 확인합니다. 명령 출력에 계정 정보가 포함될 수 있으므로 저장소에 기록하지 않습니다.

```bash
firebase login:list
firebase projects:list
```

`devlog-staging`의 Firestore rules만 배포합니다.

```bash
firebase deploy \
	--project devlog-staging \
	--only firestore:rules \
	--non-interactive
```

Firestore index, Functions, Hosting, Cloud Run은 이 명령의 배포 대상이 아닙니다.

## 배포 후 확인

Staging 앱에서 다음 흐름을 확인합니다.

1. 개발 목표 생성과 `보관`, `진행 중` 전환 성공
2. 개발 기록 생성, 초안 저장, 확정 버전 생성 성공
3. 완료 조건을 충족한 개발 목표의 완료가 서버 API로 성공하고 완료 시각이 표시됨
4. 완료한 개발 목표의 `진행 중` 복귀 성공
5. Todo, 알림, 설정 등 기존 사용자 데이터의 읽기와 쓰기 정상

클라이언트의 `completed` 직접 저장과 확정 버전 변경 거부는 `npm run test:rules`의 emulator 시험으로 확인합니다.

## 복구

배포 후 확인이 실패하면 Firebase Console의 Staging Firestore 규칙 기록에서 배포 전에 기록한 버전을 다시 게시합니다. 복구 뒤 Staging 앱에서 기존 기능이 정상인지 다시 확인합니다.

복구 과정에서는 Firestore 데이터, index, Functions, Hosting, Cloud Run과 Production 자원을 변경하지 않습니다. 원인을 수정한 뒤에는 이 문서의 절차를 처음부터 수행합니다.
