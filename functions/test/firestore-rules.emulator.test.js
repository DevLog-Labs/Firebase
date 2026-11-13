const fs = require("fs");
const path = require("path");
const {
    assertFails,
    assertSucceeds,
    initializeTestEnvironment
} = require("@firebase/rules-unit-testing");
const {
    collection,
    deleteDoc,
    deleteField,
    doc,
    getDoc,
    getDocs,
    runTransaction,
    setDoc,
    updateDoc
} = require("firebase/firestore");

const projectId = "demo-devlog";
const ownerId = "owner";
const otherId = "other";
const goalPath = `users/${ownerId}/developmentGoals/goal-1`;
const recordPath = `${goalPath}/records/record-1`;
const versionPath = `${recordPath}/versions/version-1`;

let testEnvironment;

(async () => {
    testEnvironment = await initializeTestEnvironment({
        projectId,
        firestore: {
            rules: fs.readFileSync(path.resolve(__dirname, "../../firestore.rules"), "utf8")
        }
    });

    try {
        await assertOwnerCreatesAndTransitionsGoal();
        await assertOwnerCreatesRecordAndSavesDraft();
        await assertOwnerConfirmsDraftWithNewVersion();
        await assertOwnerReadsVersions();
        await assertConfirmedVersionCannotBeOverwritten();
        await assertConfirmedVersionCannotBeDeleted();
        await assertGoalAndRecordCannotBeDeleted();
        await assertUndefinedGoalSubcollectionIsDenied();
        await assertOtherUserCannotAccessDevelopmentData();
        await assertUnauthenticatedUserCannotAccessDevelopmentData();
        await assertDeletingUserCannotWriteDevelopmentData();
        await assertProviderCredentialDoesNotBlockWrites();
        await assertExistingUserDataPermissionsRemain();
        await assertDeletingUserCannotWriteExistingUserData();
    } finally {
        await testEnvironment.cleanup();
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// 소유자의 목표 생성과 상태 전환 허용 검증
async function assertOwnerCreatesAndTransitionsGoal() {
    await testEnvironment.clearFirestore();
    const db = ownerFirestore();

    await assertSucceeds(setDoc(doc(db, goalPath), goalData()));
    await assertSucceeds(updateDoc(doc(db, goalPath), { status: "archived" }));
    await assertSucceeds(updateDoc(doc(db, goalPath), { status: "inProgress" }));
    await assertSucceeds(getDoc(doc(db, goalPath)));
}

// 소유자의 기록 생성과 초안 저장 허용 검증
async function assertOwnerCreatesRecordAndSavesDraft() {
    await testEnvironment.clearFirestore();
    await seed({ [goalPath]: goalData() });
    const db = ownerFirestore();

    await assertSucceeds(runTransaction(db, async (transaction) => {
        const record = await transaction.get(doc(db, recordPath));
        if (record.exists()) {
            throw new Error("record already exists");
        }
        transaction.set(doc(db, recordPath), { createdAt: new Date() });
    }));
    await assertSucceeds(runTransaction(db, async (transaction) => {
        await transaction.get(doc(db, recordPath));
        transaction.update(doc(db, recordPath), { draft: draftData() });
    }));
}

// 한 transaction 안의 새 버전 생성과 currentVersionId 갱신, 초안 제거 허용 검증
async function assertOwnerConfirmsDraftWithNewVersion() {
    await testEnvironment.clearFirestore();
    await seed({
        [goalPath]: goalData(),
        [recordPath]: { createdAt: new Date(), draft: draftData() }
    });
    const db = ownerFirestore();

    await assertSucceeds(runTransaction(db, async (transaction) => {
        await transaction.get(doc(db, recordPath));
        await transaction.get(doc(db, versionPath));
        transaction.set(doc(db, versionPath), versionData(1));
        transaction.update(doc(db, recordPath), {
            currentVersionId: "version-1",
            currentVersionNumber: 1,
            draft: deleteField()
        });
    }));

    const nextVersionPath = `${recordPath}/versions/version-2`;
    await assertSucceeds(runTransaction(db, async (transaction) => {
        await transaction.get(doc(db, recordPath));
        await transaction.get(doc(db, versionPath));
        transaction.set(doc(db, nextVersionPath), {
            ...versionData(2),
            changeKind: "restore",
            sourceVersionId: "version-1"
        });
        transaction.update(doc(db, recordPath), {
            currentVersionId: "version-2",
            currentVersionNumber: 2
        });
    }));
}

// 소유자의 버전 단건·목록 조회와 없는 버전 조회 허용 검증
async function assertOwnerReadsVersions() {
    await testEnvironment.clearFirestore();
    await seed({ [versionPath]: versionData(1) });
    const db = ownerFirestore();

    await assertSucceeds(getDoc(doc(db, versionPath)));
    await assertSucceeds(getDocs(collection(db, `${recordPath}/versions`)));
    await assertSucceeds(getDoc(doc(db, `${recordPath}/versions/missing`)));
}

// 확정 버전의 갱신과 같은 ID 덮어쓰기 거부 검증
async function assertConfirmedVersionCannotBeOverwritten() {
    await testEnvironment.clearFirestore();
    await seed({ [versionPath]: versionData(1) });
    const db = ownerFirestore();

    await assertFails(updateDoc(doc(db, versionPath), { title: "changed" }));
    await assertFails(setDoc(doc(db, versionPath), versionData(1)));
    await assertFails(setDoc(doc(db, versionPath), { title: "merged" }, { merge: true }));
    await assertFails(runTransaction(db, async (transaction) => {
        await transaction.get(doc(db, versionPath));
        transaction.set(doc(db, versionPath), versionData(2));
    }));
}

// 확정 버전의 삭제 거부 검증
async function assertConfirmedVersionCannotBeDeleted() {
    await testEnvironment.clearFirestore();
    await seed({ [versionPath]: versionData(1) });

    await assertFails(deleteDoc(doc(ownerFirestore(), versionPath)));
}

// 하위 버전이 고아로 남지 않도록 목표와 기록의 삭제 거부 검증
async function assertGoalAndRecordCannotBeDeleted() {
    await testEnvironment.clearFirestore();
    await seed({
        [goalPath]: goalData(),
        [recordPath]: { createdAt: new Date() }
    });
    const db = ownerFirestore();

    await assertFails(deleteDoc(doc(db, recordPath)));
    await assertFails(deleteDoc(doc(db, goalPath)));
}

// developmentGoals 하위의 정의되지 않은 경로 거부 검증
async function assertUndefinedGoalSubcollectionIsDenied() {
    await testEnvironment.clearFirestore();
    const db = ownerFirestore();
    const undefinedPaths = [
        `${goalPath}/notes/note-1`,
        `${recordPath}/comments/comment-1`,
        `${versionPath}/attachments/attachment-1`
    ];

    for (const undefinedPath of undefinedPaths) {
        await assertFails(setDoc(doc(db, undefinedPath), { value: 1 }));
        await assertFails(getDoc(doc(db, undefinedPath)));
    }
}

// 다른 사용자의 목표·기록·버전 읽기와 쓰기 거부 검증
async function assertOtherUserCannotAccessDevelopmentData() {
    await testEnvironment.clearFirestore();
    await seed({
        [goalPath]: goalData(),
        [recordPath]: { createdAt: new Date() },
        [versionPath]: versionData(1)
    });
    const db = testEnvironment.authenticatedContext(otherId).firestore();

    await assertDeniedReadAndWrite(db);
}

// 비인증 요청의 목표·기록·버전 읽기와 쓰기 거부 검증
async function assertUnauthenticatedUserCannotAccessDevelopmentData() {
    await testEnvironment.clearFirestore();
    await seed({
        [goalPath]: goalData(),
        [recordPath]: { createdAt: new Date() },
        [versionPath]: versionData(1)
    });

    await assertDeniedReadAndWrite(testEnvironment.unauthenticatedContext().firestore());
}

// 삭제 진행 중인 사용자의 목표·기록·버전 쓰기 거부와 읽기 유지 검증
async function assertDeletingUserCannotWriteDevelopmentData() {
    await testEnvironment.clearFirestore();
    await seed({
        [`authCredentials/${ownerId}`]: { deletionStartedAt: new Date() },
        [goalPath]: goalData(),
        [recordPath]: { createdAt: new Date() }
    });
    const db = ownerFirestore();

    await assertFails(setDoc(doc(db, `users/${ownerId}/developmentGoals/goal-2`), goalData()));
    await assertFails(updateDoc(doc(db, goalPath), { status: "archived" }));
    await assertFails(setDoc(doc(db, `${goalPath}/records/record-2`), { createdAt: new Date() }));
    await assertFails(updateDoc(doc(db, recordPath), { draft: draftData() }));
    await assertFails(setDoc(doc(db, versionPath), versionData(1)));
    await assertSucceeds(getDoc(doc(db, goalPath)));
    await assertSucceeds(getDoc(doc(db, recordPath)));
}

// 루트 삭제 표식 없이 provider 자격 증명만 있는 사용자의 쓰기 허용 검증
async function assertProviderCredentialDoesNotBlockWrites() {
    await testEnvironment.clearFirestore();
    await seed({ [`authCredentials/${ownerId}/providers/github`]: { accessToken: "token" } });
    const db = ownerFirestore();

    await assertSucceeds(setDoc(doc(db, goalPath), goalData()));
    await assertSucceeds(setDoc(doc(db, recordPath), { createdAt: new Date() }));
    await assertSucceeds(setDoc(doc(db, versionPath), versionData(1)));
    await assertSucceeds(setDoc(doc(db, `users/${ownerId}/todoLists/todo-1`), { title: "todo" }));
}

// 기존 사용자 하위 데이터의 소유자 읽기·쓰기·삭제 유지 검증
async function assertExistingUserDataPermissionsRemain() {
    await testEnvironment.clearFirestore();
    const db = ownerFirestore();
    const existingPaths = [
        `users/${ownerId}/todoLists/todo-1`,
        `users/${ownerId}/userData/settings`,
        `users/${ownerId}/counters/todo`,
        `users/${ownerId}/notifications/notification-1`,
        `users/${ownerId}/webPages/page-1`,
        `users/${ownerId}/todoLists/todo-1/items/item-1`
    ];

    await assertSucceeds(setDoc(doc(db, `users/${ownerId}`), { name: "owner" }));
    for (const existingPath of existingPaths) {
        await assertSucceeds(setDoc(doc(db, existingPath), { value: 1 }));
        await assertSucceeds(updateDoc(doc(db, existingPath), { value: 2 }));
        await assertSucceeds(getDoc(doc(db, existingPath)));
        await assertSucceeds(deleteDoc(doc(db, existingPath)));
    }

    const otherDb = testEnvironment.authenticatedContext(otherId).firestore();
    await assertFails(getDoc(doc(otherDb, `users/${ownerId}/todoLists/todo-1`)));
    await assertFails(setDoc(doc(otherDb, `users/${ownerId}/todoLists/todo-1`), { value: 1 }));
}

// 삭제 진행 중인 사용자의 기존 하위 데이터 쓰기 거부 검증
async function assertDeletingUserCannotWriteExistingUserData() {
    await testEnvironment.clearFirestore();
    await seed({
        [`authCredentials/${ownerId}`]: { deletionStartedAt: new Date() },
        [`users/${ownerId}/todoLists/todo-1`]: { value: 1 }
    });
    const db = ownerFirestore();

    await assertFails(setDoc(doc(db, `users/${ownerId}/todoLists/todo-2`), { value: 1 }));
    await assertFails(updateDoc(doc(db, `users/${ownerId}/todoLists/todo-1`), { value: 2 }));
    await assertFails(deleteDoc(doc(db, `users/${ownerId}/todoLists/todo-1`)));
    await assertSucceeds(getDoc(doc(db, `users/${ownerId}/todoLists/todo-1`)));
}

// 목표·기록·버전 경로 전체의 읽기와 쓰기 거부 확인
async function assertDeniedReadAndWrite(db) {
    for (const documentPath of [goalPath, recordPath, versionPath]) {
        await assertFails(getDoc(doc(db, documentPath)));
        await assertFails(setDoc(doc(db, documentPath), { value: 1 }));
        await assertFails(deleteDoc(doc(db, documentPath)));
    }
    await assertFails(getDocs(collection(db, `${recordPath}/versions`)));
    await assertFails(setDoc(doc(db, `${recordPath}/versions/version-2`), versionData(2)));
}

// 소유자 인증 컨텍스트의 Firestore 인스턴스
function ownerFirestore() {
    return testEnvironment.authenticatedContext(ownerId).firestore();
}

// 규칙을 우회한 초기 문서 기록
async function seed(documents) {
    await testEnvironment.withSecurityRulesDisabled(async (context) => {
        const db = context.firestore();
        for (const [documentPath, data] of Object.entries(documents)) {
            await setDoc(doc(db, documentPath), data);
        }
    });
}

// 진행 중 상태의 목표 문서 데이터
function goalData() {
    return {
        title: "goal",
        markdownDescription: "",
        status: "inProgress",
        createdAt: new Date(),
        updatedAt: new Date()
    };
}

// 기록 문서에 저장하는 초안 데이터
function draftData() {
    return {
        title: "draft",
        markdownContent: "content",
        updatedAt: new Date()
    };
}

// 지정한 번호의 확정 버전 문서 데이터
function versionData(versionNumber) {
    return {
        versionNumber,
        title: "record",
        markdownContent: "content",
        changeKind: "initial",
        confirmedAt: new Date()
    };
}
