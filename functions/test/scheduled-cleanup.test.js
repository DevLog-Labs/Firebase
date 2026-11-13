const assert = require("assert");

const getFirestoreArguments = [];

const firestore = require("firebase-admin/firestore");
require.cache[require.resolve("firebase-admin/firestore")] = {
    exports: {
        ...firestore,
        getFirestore: (...args) => {
            getFirestoreArguments.push(args);
            return fakeFirestore();
        }
    }
};

require.cache[require.resolve("firebase-functions/logger")] = {
    exports: {
        error() {},
        warn() {}
    }
};

const {
    cleanupNotificationDispatches,
    cleanupSoftDeletedNotifications
} = require("../lib/notification/cleanup");
const { compactSoftDeletedTodos } = require("../lib/todo/cleanup");

(async () => {
    const schedulers = [
        cleanupSoftDeletedNotifications,
        cleanupNotificationDispatches,
        compactSoftDeletedTodos
    ];

    for (const scheduler of schedulers) {
        getFirestoreArguments.length = 0;
        await scheduler.run({});

        assert.deepStrictEqual(
            getFirestoreArguments,
            [[]],
            "각 예약 정리 작업은 인자 없는 getFirestore()를 한 번만 사용해야 합니다."
        );
    }
})().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});

// 예약 정리 작업에서 빈 조회 결과를 반환하는 기본 Firestore 대역을 구성합니다.
function fakeFirestore() {
    return {
        collectionGroup() {
            return fakeQuery();
        }
    };
}

// 정리할 문서가 없는 조회 결과를 반환하는 쿼리 대역을 구성합니다.
function fakeQuery() {
    return {
        where() {
            return this;
        },
        orderBy() {
            return this;
        },
        limit() {
            return this;
        },
        startAfter() {
            return this;
        },
        async get() {
            return {
                docs: [],
                empty: true,
                size: 0
            };
        }
    };
}
