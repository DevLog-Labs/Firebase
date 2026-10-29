const assert = require("assert");

process.env.GCLOUD_PROJECT = "devlog-test";

const { api } = require("../lib/rest/api");
const {
    cleanupExpiredOAuthSessions,
    cleanupExpiredOAuthTickets
} = require("../lib/rest/oauth/cleanup");
const {
    removeCompletedTodoNotificationRecords,
    removeTodoNotificationDocuments
} = require("../lib/notification/cleanup");
const { syncTodoNotificationCategory } = require("../lib/todo/update");
const {
    cleanupDeletedUserFirestoreData
} = require("../lib/user/delete");
const { sendDailyIncidentReport } = require("../lib/incident/daily");
const functionExports = require("../lib/index");

const apiSecretKeys = [];
const githubSecretKeys = ["GITHUB_OAUTH_CONFIG"];

assert.deepStrictEqual(secretKeys(api), apiSecretKeys);
assert.deepStrictEqual(
    secretKeys(cleanupExpiredOAuthSessions),
    githubSecretKeys
);
assert.deepStrictEqual(
    secretKeys(cleanupExpiredOAuthTickets),
    githubSecretKeys
);
assert.deepStrictEqual(
    secretKeys(cleanupDeletedUserFirestoreData),
    githubSecretKeys
);
assert.deepStrictEqual(
    secretKeys(sendDailyIncidentReport),
    ["DISCORD_WEBHOOK_URL", "GH_AUTOMATION_TOKEN", "OPENAI_API_KEY"]
);
assert.strictEqual(functionExports.sendDailyIncidentReport, sendDailyIncidentReport);
assert.deepStrictEqual(secretKeys(removeTodoNotificationDocuments), []);
assert.deepStrictEqual(secretKeys(removeCompletedTodoNotificationRecords), []);
assert.deepStrictEqual(secretKeys(syncTodoNotificationCategory), []);
assert.strictEqual(triggerDatabase(cleanupExpiredOAuthSessions), "(default)");
assert.strictEqual(triggerDatabase(cleanupExpiredOAuthTickets), "(default)");
assert.strictEqual(triggerDatabase(removeTodoNotificationDocuments), "(default)");
assert.strictEqual(triggerDatabase(removeCompletedTodoNotificationRecords), "(default)");
assert.strictEqual(triggerDatabase(syncTodoNotificationCategory), "(default)");
assert.strictEqual(functionExports.cleanupExpiredOAuthSessions, cleanupExpiredOAuthSessions);
assert.strictEqual(functionExports.cleanupExpiredOAuthTickets, cleanupExpiredOAuthTickets);
assert.strictEqual(functionExports.removeTodoNotificationDocuments, removeTodoNotificationDocuments);
assert.strictEqual(
    functionExports.removeCompletedTodoNotificationRecords,
    removeCompletedTodoNotificationRecords
);
assert.strictEqual(functionExports.syncTodoNotificationCategory, syncTodoNotificationCategory);
assert.strictEqual(functionExports.staging, undefined);
assert.strictEqual(functionExports.prod, undefined);

// 배포 함수에 연결된 Secret 이름을 정렬해 반환합니다.
function secretKeys(cloudFunction) {
    return (cloudFunction.__endpoint.secretEnvironmentVariables ?? [])
        .map(({ key }) => key)
        .sort();
}

// Firestore trigger가 감시하는 database 식별자를 반환합니다.
function triggerDatabase(cloudFunction) {
    return cloudFunction.__endpoint.eventTrigger.eventFilters.database;
}
