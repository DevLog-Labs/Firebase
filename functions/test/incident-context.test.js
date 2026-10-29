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

    // 원인 위치: 같은 시각 서버 에러 로그가 있으면 서버, 요청 로그만 없으면 앞단 응답 가능성을 근거에 덧붙임
    {
        queryRows = [[sample()]];
        logEntries = [
            { metadata: { insertId: "r", httpRequest: { requestMethod: "GET", requestUrl: "https://x/api/a", status: 503, latency: "1s" } } },
            { metadata: { insertId: "e1", severity: "ERROR" }, data: "boom" },
            { metadata: { insertId: "e2", severity: "ERROR" }, data: "boom2" }
        ];
        const withErrors = await buildAnalysisContext(group, "2026-10-28");

        assert.deepStrictEqual(withErrors.origin, { kind: "server", reasons: ["같은 시각 서버 에러 로그 2건"] });

        queryRows = [[sample()]];
        logEntries = [];
        const withoutLogs = await buildAnalysisContext(group, "2026-10-28");

        assert.strictEqual(withoutLogs.origin.kind, "server");
        assert.ok(withoutLogs.origin.reasons.some((reason) => reason.includes("요청 로그 없음")));

        queryRows = [[sample()]];
        logFailure = new Error("PERMISSION_DENIED");
        const failedLogs = await buildAnalysisContext(group, "2026-10-28");
        logFailure = undefined;

        assert.deepStrictEqual(failedLogs.origin, { kind: "server", reasons: ["서버가 503 응답"] });
    }

    // 원인 위치: 오류 종류, REST가 아닌 오류, 크래시 스택의 앱 코드 프레임으로 분류
    {
        logEntries = [];
        const nonRestGroup = { ...group, restStatusCode: "" };

        queryRows = [[sample({
            customKeys: JSON.stringify([{ key: "NSUnderlyingError", value: "Nexa.NXError.timeout(URLError)" }])
        })]];
        assert.strictEqual((await buildAnalysisContext(nonRestGroup, "2026-10-28")).origin.kind, "ios");

        queryRows = [[sample({ customKeys: "[]" })]];
        assert.strictEqual((await buildAnalysisContext(nonRestGroup, "2026-10-28")).origin.kind, "ios");

        const fatalGroup = { ...nonRestGroup, isFatal: true };
        const crashSample = (owner) => sample({
            customKeys: "[]",
            errorFrames: "[]",
            crashFrames: frames({ file: "A.swift", line: 1, symbol: "a", library: "App", owner })
        });

        queryRows = [[crashSample("DEVELOPER")]];
        assert.strictEqual((await buildAnalysisContext(fatalGroup, "2026-10-28")).origin.kind, "ios");

        queryRows = [[crashSample("VENDOR")]];
        assert.strictEqual((await buildAnalysisContext(fatalGroup, "2026-10-28")).origin.kind, "ios");
    }

    // 코드 읽기: 앱 스택의 개발자 코드 프레임은 서버가 아닌 분류에서, 요청 경로는 iOS가 아닌 분류에서 읽음
    {
        const readerCalls = [];
        const reader = {
            readAppFrames: async (appFrames) => {
                readerCalls.push(["app", appFrames]);
                return [{ ref: "iOS:A.swift:7", text: "7| code" }];
            },
            readServerRoute: async (path) => {
                readerCalls.push(["server", path]);
                return [{ ref: "Firebase:todos.controller.ts:1-1", text: "1| route" }];
            }
        };
        const withFrames = (overrides = {}) => sample({
            errorFrames: frames(
                { file: "Helper.swift", line: 1, symbol: "h", library: "ThirdParty", owner: "OTHER" },
                { file: "A.swift", line: 7, symbol: "a", library: "Infra", owner: "DEVELOPER" },
                { file: "B.swift", line: null, symbol: "b", library: "Infra", owner: "DEVELOPER" },
                { file: null, line: 3, symbol: "c", library: "Infra", owner: "DEVELOPER" }
            ),
            ...overrides
        });
        const requestLog = (status) => ({
            metadata: {
                insertId: `r${status}`,
                httpRequest: { requestMethod: "DELETE", requestUrl: "https://x/api/todos/t1/deletion-request?token=secret", status, latency: "1s" }
            }
        });

        // 서버: 요청 경로로 서버 코드만 읽음
        readerCalls.length = 0;
        queryRows = [[withFrames()]];
        logEntries = [requestLog(503)];
        const server = await buildAnalysisContext(group, "2026-10-28", reader);

        assert.deepStrictEqual(readerCalls, [["server", "/api/todos/t1/deletion-request"]]);
        assert.deepStrictEqual(server.sources.code.map((item) => item.ref), ["Firebase:todos.controller.ts:1-1"]);

        // 공동: 앱 코드와 서버 코드를 모두 읽고 앱 프레임은 owner와 무관하게 파일과 줄이 있는 것만 전달
        readerCalls.length = 0;
        queryRows = [[withFrames()]];
        logEntries = [requestLog(404)];
        const shared = await buildAnalysisContext({ ...group, restStatusCode: "404" }, "2026-10-28", reader);

        assert.deepStrictEqual(readerCalls, [
            ["app", [{ file: "Helper.swift", line: 1 }, { file: "A.swift", line: 7 }]],
            ["server", "/api/todos/t1/deletion-request"]
        ]);
        assert.deepStrictEqual(shared.sources.code.map((item) => item.ref), ["iOS:A.swift:7", "Firebase:todos.controller.ts:1-1"]);

        // iOS: 앱 코드만 읽음
        readerCalls.length = 0;
        queryRows = [[withFrames({ customKeys: "[]" })]];
        logEntries = [];
        const ios = await buildAnalysisContext({ ...group, restStatusCode: "" }, "2026-10-28", reader);

        assert.deepStrictEqual(readerCalls.map((call) => call[0]), ["app"]);
        assert.deepStrictEqual(ios.sources.code.map((item) => item.ref), ["iOS:A.swift:7"]);

        // 공동이어도 요청 로그가 없으면 서버 코드는 읽지 않음
        readerCalls.length = 0;
        queryRows = [[withFrames()]];
        logEntries = [];
        await buildAnalysisContext({ ...group, restStatusCode: "404" }, "2026-10-28", reader);

        assert.deepStrictEqual(readerCalls.map((call) => call[0]), ["app"]);

        // 코드 읽기 객체가 없으면 코드 원문은 비어 있음
        queryRows = [[withFrames()]];
        assert.deepStrictEqual((await buildAnalysisContext(group, "2026-10-28")).sources.code, []);
    }

    console.log("incident-context.test.js passed");
})();
