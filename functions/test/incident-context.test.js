const assert = require("assert");

const queries = [];
let queryRows = [];
class FakeBigQuery {
    async query(options) {
        queries.push(options);
        return [queryRows.shift() ?? []];
    }
}
require.cache[require.resolve("@google-cloud/bigquery")] = {
    exports: { BigQuery: FakeBigQuery }
};

const logEntryRequests = [];
let logEntries = [];
let logFailure;
class FakeLogging {
    async getEntries(options) {
        logEntryRequests.push(options);
        if (logFailure) { throw logFailure; }
        return [logEntries];
    }
}
require.cache[require.resolve("@google-cloud/logging")] = {
    exports: { Logging: FakeLogging }
};

const warnings = [];
require.cache[require.resolve("firebase-functions/logger")] = {
    exports: { warn: (...values) => warnings.push(values), error() {}, info() {} }
};

const {
    buildAnalysisContext,
    groupTitle,
    issueUrl,
    selectErrorGroups,
    toImpactMetrics,
    yesterdayInSeoul
} = require("../lib/incident/context");

const group = {
    issueId: "issue-1",
    restStatusCode: "503",
    issueSubtitle: "DevLogInfra.TodoServiceImpl.fetchTodos (1)",
    isFatal: false,
    affectedUsers: 4,
    isNew: true,
    isRegression: false,
    isSurge: false
};

function frames(...items) {
    return JSON.stringify(items);
}

function sample(overrides = {}) {
    return {
        eventId: "e1",
        eventTimestamp: { value: "2026-10-28T03:10:00.000000Z" },
        appVersion: "1.6",
        appBuild: "1",
        osVersion: "26.7.1",
        deviceModel: "iPhone17,1",
        customKeys: JSON.stringify([
            { key: "restStatusCode", value: "503" },
            { key: "restErrorMessage", value: "Service temporarily unavailable" }
        ]),
        breadcrumbs: JSON.stringify([
            { name: "_vs", params: null },
            { name: "screen_view", params: [{ key: "screen", value: "Home" }, { key: "from", value: "tab" }] }
        ]),
        errorFrames: frames(
            { file: null, line: null, symbol: null, library: "ThirdParty" },
            { file: "FirebaseCrashlyticsHelper.swift", line: 32, symbol: "record(_:)", library: "Infra" },
            { file: "TodoCommandServiceImpl.swift", line: 62, symbol: "requestTodoDeletion", library: "Infra" }
        ),
        exceptionFrames: "[]",
        crashFrames: "[]",
        ...overrides
    };
}

(async () => {
    // 한국 시간 기준 어제 날짜 계산 (자정 직후, 월말, 연말 경계 포함)
    assert.strictEqual(yesterdayInSeoul(new Date("2026-10-28T15:30:00Z")), "2026-10-28");
    assert.strictEqual(yesterdayInSeoul(new Date("2026-10-28T14:30:00Z")), "2026-10-27");
    assert.strictEqual(yesterdayInSeoul(new Date("2026-03-01T01:00:00Z")), "2026-02-28");
    assert.strictEqual(yesterdayInSeoul(new Date("2026-12-31T15:10:00Z")), "2026-12-31");
    assert.strictEqual(yesterdayInSeoul(new Date("2026-01-01T00:10:00Z")), "2025-12-31");

    // 이슈 그룹 조회: 한국 시간 하루 구간과 선별 기준을 쿼리 파라미터로 전달하고 결과를 매핑
    {
        queryRows = [[{
            issueId: "issue-1",
            restStatusCode: "503",
            issueSubtitle: "DevLogInfra.TodoServiceImpl.fetchTodos (1)",
            isFatal: false,
            affectedUsers: "4",
            isNew: true,
            isRegression: false,
            isSurge: true,
            extra: "무시되는 필드"
        }]];

        const groups = await selectErrorGroups("2026-10-28");
        const { params, query } = queries[0];

        assert.deepStrictEqual(groups, [{ ...group, isSurge: true }]);
        assert.strictEqual(params.dayStart.toISOString(), "2026-10-27T15:00:00.000Z");
        assert.strictEqual(params.dayEnd.toISOString(), "2026-10-28T15:00:00.000Z");
        assert.strictEqual(params.lookbackDays, 30);
        assert.ok(query.includes("firebase_crashlytics.opfic_DevLog_IOS_REALTIME"));
        assert.ok(query.includes("restStatusCode"));
    }

    // 날짜 형식이 올바르지 않으면 쿼리 없이 실패
    {
        queries.length = 0;
        await assert.rejects(selectErrorGroups("2026/10/28"), /날짜 형식/);
        assert.strictEqual(queries.length, 0);
    }

    // 영향도 입력, 제목, 콘솔 링크 생성
    assert.deepStrictEqual(toImpactMetrics({ ...group, isRegression: true }), {
        affectedUsers: 4,
        isRegression: true
    });
    assert.strictEqual(groupTitle(group), "DevLogInfra.TodoServiceImpl.fetchTodos (1) · 503");
    assert.strictEqual(
        groupTitle({ ...group, restStatusCode: "" }),
        "DevLogInfra.TodoServiceImpl.fetchTodos (1)"
    );
    assert.strictEqual(
        issueUrl("devlog-staging", "issue-1"),
        "https://console.firebase.google.com/project/devlog-staging/crashlytics/app/ios:opfic.DevLog/issues/issue-1"
    );

    // 분석 입력: 심볼 없는 SDK 프레임은 제외하고 프레임마다 원문 한 건, 이벤트는 환경과 custom key와 breadcrumb 포함
    {
        queries.length = 0;
        queryRows = [[sample()]];
        logEntries = [];
        logEntryRequests.length = 0;

        const context = await buildAnalysisContext(group, "2026-10-28");

        assert.strictEqual(context.issueId, "issue-1");
        assert.strictEqual(context.title, "DevLogInfra.TodoServiceImpl.fetchTodos (1) · 503");
        assert.strictEqual(context.isFatal, false);
        assert.deepStrictEqual(context.sources.stack, [
            { ref: "frame-0", text: "record(_:) (FirebaseCrashlyticsHelper.swift:32) [Infra]" },
            { ref: "frame-1", text: "requestTodoDeletion (TodoCommandServiceImpl.swift:62) [Infra]" }
        ]);
        assert.deepStrictEqual(context.sources.code, []);
        assert.strictEqual(context.sources.event.length, 1);
        assert.strictEqual(context.sources.event[0].ref, "event-e1");
        assert.ok(context.sources.event[0].text.includes("time=2026-10-28T03:10:00.000Z app=1.6(1) os=26.7.1 model=iPhone17,1"));
        assert.ok(context.sources.event[0].text.includes("restStatusCode=503"));
        assert.ok(context.sources.event[0].text.includes("restErrorMessage=Service temporarily unavailable"));
        assert.ok(context.sources.event[0].text.includes("breadcrumbs=_vs, screen_view(screen=Home from=tab)"));
        assert.deepStrictEqual(
            { issueId: queries[0].params.issueId, status: queries[0].params.status },
            { issueId: "issue-1", status: "503" }
        );
    }

    // 서버 로그: REST 오류면 대표 이벤트 시각 전후 2분과 상태 코드로 조회하고 메서드, 경로, 상태, 처리 시간만 남김
    {
        queryRows = [[sample()]];
        logEntries = [
            {
                metadata: {
                    insertId: "abc",
                    httpRequest: {
                        requestMethod: "DELETE",
                        requestUrl: "https://devlog-staging.web.app/api/todos/t1/deletion-request?token=secret",
                        status: 503,
                        latency: "0.2s"
                    }
                }
            },
            {
                metadata: { insertId: "err1", severity: "ERROR" },
                data: { message: "TypeError: cannot read\n    at TodoService.remove" }
            },
            {
                metadata: { insertId: "err2", severity: "CRITICAL" },
                data: "x".repeat(900)
            }
        ];
        logEntryRequests.length = 0;

        const context = await buildAnalysisContext(group, "2026-10-28");
        const [request] = logEntryRequests;

        assert.ok(request.filter.includes('resource.labels.service_name="api-v2"'));
        assert.ok(request.filter.includes("(httpRequest.status=503 OR severity>=ERROR)"));
        assert.ok(request.filter.includes('timestamp>="2026-10-28T03:08:00.000Z"'));
        assert.ok(request.filter.includes('timestamp<="2026-10-28T03:12:00.000Z"'));
        assert.deepStrictEqual(context.sources.serverLog.slice(0, 2), [
            { ref: "log-abc", text: "DELETE /api/todos/t1/deletion-request status=503 latency=0.2s" },
            { ref: "log-err1", text: "ERROR TypeError: cannot read at TodoService.remove" }
        ]);
        assert.strictEqual(context.sources.serverLog[2].ref, "log-err2");
        assert.ok(context.sources.serverLog[2].text.startsWith("CRITICAL xxx"));
        assert.ok(context.sources.serverLog[2].text.length <= "CRITICAL ".length + 500);
    }

    // 앱 버전과 OS 버전별 발생 분포를 이벤트 원문 한 건으로 추가하고 분포가 없으면 추가하지 않음
    {
        queries.length = 0;
        queryRows = [
            [sample()],
            [
                { appVersion: "1.6", osVersion: "26.7.1", events: "3", installs: "1" },
                { appVersion: "1.5", osVersion: "18.6", events: "1", installs: "1" }
            ]
        ];
        logEntries = [];

        const context = await buildAnalysisContext(group, "2026-10-28");

        assert.deepStrictEqual(context.sources.event[1], {
            ref: "distribution",
            text: "발생 분포\napp=1.6 os=26.7.1 events=3 installs=1\napp=1.5 os=18.6 events=1 installs=1"
        });
        assert.strictEqual(context.sources.event.length, 2);
        assert.deepStrictEqual(
            { issueId: queries[1].params.issueId, status: queries[1].params.status, rowLimit: queries[1].params.rowLimit },
            { issueId: "issue-1", status: "503", rowLimit: 5 }
        );

        queryRows = [[sample()], []];
        const withoutDistribution = await buildAnalysisContext(group, "2026-10-28");
        assert.strictEqual(withoutDistribution.sources.event.length, 1);
    }

    // REST 오류가 아니면 서버 로그를 조회하지 않음
    {
        queryRows = [[sample({ customKeys: "[]" })]];
        logEntryRequests.length = 0;

        const context = await buildAnalysisContext({ ...group, restStatusCode: "" }, "2026-10-28");

        assert.deepStrictEqual(context.sources.serverLog, []);
        assert.strictEqual(logEntryRequests.length, 0);
    }

    // 서버 로그 조회가 실패해도 경고만 남기고 서버 로그 없이 진행
    {
        queryRows = [[sample()]];
        logFailure = new Error("PERMISSION_DENIED");
        warnings.length = 0;

        const context = await buildAnalysisContext(group, "2026-10-28");

        assert.deepStrictEqual(context.sources.serverLog, []);
        assert.strictEqual(warnings.length, 1);
        logFailure = undefined;
    }

    // 비치명 오류 스택이 없으면 예외 스택, 그것도 없으면 크래시 스레드 스택을 사용
    {
        const exceptionFrame = { file: "A.swift", line: 1, symbol: "a", library: "App" };
        const crashFrame = { file: "B.swift", line: 2, symbol: "b", library: "App" };

        queryRows = [[sample({ errorFrames: "[]", exceptionFrames: frames(exceptionFrame) })]];
        const byException = await buildAnalysisContext({ ...group, restStatusCode: "" }, "2026-10-28");
        assert.strictEqual(byException.sources.stack[0].text, "a (A.swift:1) [App]");

        queryRows = [[sample({ errorFrames: "[]", crashFrames: frames(crashFrame) })]];
        const byCrash = await buildAnalysisContext({ ...group, restStatusCode: "" }, "2026-10-28");
        assert.strictEqual(byCrash.sources.stack[0].text, "b (B.swift:2) [App]");
    }

    // 대표 이벤트가 없으면 스택, 이벤트, 서버 로그가 모두 비어 있음
    {
        queryRows = [[]];
        logEntryRequests.length = 0;

        const context = await buildAnalysisContext(group, "2026-10-28");

        assert.deepStrictEqual(context.sources, { stack: [], serverLog: [], code: [], event: [] });
        assert.strictEqual(logEntryRequests.length, 0);
    }

    console.log("incident-context.test.js passed");
})();
