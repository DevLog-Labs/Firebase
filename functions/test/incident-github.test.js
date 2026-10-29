const assert = require("assert");
const axios = require("axios");

const errorLogs = [];
require.cache[require.resolve("firebase-functions/logger")] = {
    exports: { error: (...values) => errorLogs.push(values), warn() {}, info() {} }
};

const { syncIncidentIssues } = require("../lib/incident/github");
const { buildIncidentIssue, issueRepository } = require("../lib/incident/report");
const { scoreRisk } = require("../lib/incident/score");

const token = "ghp_secrettoken";
const firebaseUrl = "https://api.github.com/repos/DevLog-Labs/Firebase";
const iosUrl = "https://api.github.com/repos/DevLog-Labs/iOS";
const flagNames = [
    "fatal",
    "launchCrash",
    "blocksCoreFlow",
    "dataLossPossible",
    "securityArea"
];

function draft(markerKey, repository = "Firebase", labels = ["crashlytics"]) {
    return {
        markerKey,
        repository,
        title: `제목 ${markerKey}`,
        body: `<!-- crashlytics:${markerKey} -->\n본문`,
        labels,
        updateComment: `갱신 ${markerKey}`
    };
}

const requests = [];
let openIssues = { Firebase: [], iOS: [] };
let failures = {};
axios.request = async (config) => {
    requests.push(config);
    const path = config.url.replace("https://api.github.com", "");
    const key = `${config.method} ${path.split("?")[0]}`;
    const override = failures[key];
    if (override === "network") { throw new Error(`failed ${config.headers.Authorization}`); }
    if (override) { return { status: override, data: {} }; }

    if (config.method === "get") {
        return { status: 200, data: path.includes("/DevLog-Labs/iOS/") ? openIssues.iOS : openIssues.Firebase };
    }
    if (path.endsWith("/labels") || path.endsWith("/comments")) { return { status: 201, data: {} }; }
    return { status: 201, data: { number: 100 + requests.length } };
};

function reset() {
    requests.length = 0;
    errorLogs.length = 0;
    openIssues = { Firebase: [], iOS: [] };
    failures = {};
}

function calls(method, url) {
    return requests.filter((request) => request.method === method && request.url === url);
}

(async () => {
    // 초안이 없으면 요청을 보내지 않음
    {
        reset();
        assert.deepStrictEqual(await syncIncidentIssues(token, []), []);
        assert.strictEqual(requests.length, 0);
    }

    // 두 저장소 모두에 라벨을 보장하고 두 저장소의 열린 이슈를 조회한 뒤 없으면 초안의 저장소에 이슈를 생성
    {
        reset();
        const results = await syncIncidentIssues(token, [draft("a:503", "Firebase", ["crashlytics", "auto-fix"])]);

        for (const base of [firebaseUrl, iosUrl]) {
            assert.deepStrictEqual(
                calls("post", `${base}/labels`).map((request) => request.data.name),
                ["crashlytics", "auto-fix", "area:server", "area:ios", "area:shared", "needs-triage"]
            );
            assert.ok(requests.some((request) => request.method === "get" && request.url.startsWith(`${base}/issues?labels=crashlytics&state=open`)));
        }

        const [created] = calls("post", `${firebaseUrl}/issues`);
        assert.deepStrictEqual(created.data.labels, ["crashlytics", "auto-fix"]);
        assert.strictEqual(created.data.title, "제목 a:503");
        assert.strictEqual(created.headers.Authorization, `Bearer ${token}`);
        assert.strictEqual(created.headers["User-Agent"], "DevLog-Firebase");
        assert.strictEqual(calls("post", `${iosUrl}/issues`).length, 0);
        assert.deepStrictEqual(
            [results[0].repository, results[0].action],
            ["Firebase", "created"]
        );
        assert.ok(results[0].number > 100);
    }

    // iOS 초안은 iOS 저장소에 이슈를 생성
    {
        reset();
        const results = await syncIncidentIssues(token, [draft("b:ios", "iOS", ["crashlytics", "area:ios"])]);

        assert.strictEqual(calls("post", `${iosUrl}/issues`).length, 1);
        assert.strictEqual(calls("post", `${firebaseUrl}/issues`).length, 0);
        assert.strictEqual(results[0].repository, "iOS");
    }

    // 같은 식별 표식의 열린 이슈가 있으면 있는 저장소에 댓글로 갱신. 이전된 이슈도 찾고 풀 리퀘스트는 무시
    {
        reset();
        openIssues.Firebase = [
            { number: 7, body: "<!-- crashlytics:a:503 -->\n본문" },
            { number: 8, body: "<!-- crashlytics:b:500 -->", pull_request: {} },
            { number: 9, body: "표식 없는 이슈" }
        ];
        openIssues.iOS = [{ number: 21, body: "<!-- crashlytics:c:404 -->\n이전된 이슈" }];

        const results = await syncIncidentIssues(token, [draft("a:503"), draft("b:500"), draft("c:404")]);

        assert.deepStrictEqual(
            results.map((result) => [result.repository, result.action, result.number]),
            [
                ["Firebase", "commented", 7],
                ["Firebase", "created", results[1].number],
                ["iOS", "commented", 21]
            ]
        );
        assert.strictEqual(calls("post", `${firebaseUrl}/issues/7/comments`)[0].data.body, "갱신 a:503");
        assert.strictEqual(calls("post", `${iosUrl}/issues/21/comments`)[0].data.body, "갱신 c:404");
        assert.strictEqual(calls("post", `${firebaseUrl}/issues`).length, 1);
        assert.strictEqual(calls("post", `${iosUrl}/issues`).length, 0);
    }

    // 두 저장소에 같은 표식이 있으면 먼저 조회한 Firebase 저장소를 우선
    {
        reset();
        openIssues.Firebase = [{ number: 3, body: "<!-- crashlytics:a:503 -->" }];
        openIssues.iOS = [{ number: 4, body: "<!-- crashlytics:a:503 -->" }];

        const [result] = await syncIncidentIssues(token, [draft("a:503", "iOS")]);

        assert.deepStrictEqual([result.repository, result.number], ["Firebase", 3]);
    }

    // 라벨이 이미 있어 422가 와도 계속 진행
    {
        reset();
        failures["post /repos/DevLog-Labs/Firebase/labels"] = 422;
        failures["post /repos/DevLog-Labs/iOS/labels"] = 422;

        const results = await syncIncidentIssues(token, [draft("a:503")]);

        assert.strictEqual(results[0].action, "created");
    }

    // 이슈 하나가 실패해도 실패로 기록하고 나머지는 계속 처리하며 오류에 토큰이 없음
    {
        reset();
        let creates = 0;
        const original = axios.request;
        axios.request = async (config) => {
            if (config.method === "post" && config.url.endsWith("/issues")) {
                creates++;
                if (creates === 1) { return { status: 403, data: {} }; }
            }
            return original(config);
        };

        const results = await syncIncidentIssues(token, [draft("a:503"), draft("b:500")]);
        axios.request = original;

        assert.deepStrictEqual(results.map((result) => result.action), ["failed", "created"]);
        assert.strictEqual(results[0].number, null);
        assert.strictEqual(errorLogs.length, 1);
        assert.ok(!JSON.stringify(errorLogs).includes(token));
    }

    // 목록 조회가 실패하거나 네트워크 오류가 나면 예외를 던지되 오류에 토큰이 없음
    {
        reset();
        failures["get /repos/DevLog-Labs/iOS/issues"] = 500;
        await assert.rejects(
            syncIncidentIssues(token, [draft("a:503")]),
            (error) => /status=500/.test(error.message) && !error.message.includes(token)
        );

        reset();
        failures["post /repos/DevLog-Labs/Firebase/labels"] = "network";
        await assert.rejects(
            syncIncidentIssues(token, [draft("a:503")]),
            (error) => !error.message.includes(token) && !String(error.stack).includes(token)
        );
    }

    // 이슈 초안: 분류별 저장소와 라벨, 확인할 곳을 담고 근거 원문은 담지 않음
    {
        const flags = Object.fromEntries(flagNames.map((name) => [name, { value: false, evidenceIds: ["e1"] }]));
        const riskEvidence = {
            issueId: "issue-1",
            rubricVersion: "v1",
            classification: { layer: "server", cause: "server_5xx", httpStatus: 503 },
            evidence: [{ id: "e1", source: "stack", ref: "frame-0", quote: "SECRET-QUOTE" }],
            severity: flags,
            rootCause: {
                summary: "할 일 조회가 503으로 실패했습니다.",
                codeLocation: { file: "TodoMapper.swift", line: 42 },
                reproducible: true
            },
            proposedFix: { type: "responseDefault", files: ["functions/src/todo/update.ts"], reversible: true }
        };
        const metrics = { affectedUsers: 3, isRegression: false };
        const group = {
            issueId: "issue-1",
            restStatusCode: "503",
            issueSubtitle: "DevLogInfra.TodoServiceImpl.fetchTodos (1)",
            isFatal: false,
            affectedUsers: 3,
            isNew: true,
            isRegression: false,
            isSurge: true
        };
        const item = (kind, autoFixEligible) => ({
            issueId: "issue-1",
            title: "DevLogInfra.TodoServiceImpl.fetchTodos (1) · 503",
            url: "https://console.firebase.google.com/project/p/crashlytics/app/ios:opfic.DevLog/issues/issue-1",
            origin: { kind, reasons: ["서버가 503 응답"] },
            riskEvidence,
            score: { ...scoreRisk(riskEvidence, metrics), autoFixEligible },
            metrics
        });

        const server = buildIncidentIssue(group, item("server", true), "2026-10-28");

        assert.strictEqual(server.markerKey, "issue-1:503");
        assert.strictEqual(server.repository, "Firebase");
        assert.strictEqual(server.title, "DevLogInfra.TodoServiceImpl.fetchTodos (1) · 503 오류를 조사한다");
        assert.strictEqual(server.body.split("\n")[0], "<!-- crashlytics:issue-1:503 -->");
        assert.ok(server.body.includes("- 탐지일: 2026-10-28"));
        assert.ok(server.body.includes("- 영향 사용자: 3명"));
        assert.ok(server.body.includes("- 원인 위치: 서버"));
        assert.ok(server.body.includes("- 위치 판단 근거: 서버가 503 응답"));
        assert.ok(server.body.includes("- 분류: server_5xx / 503"));
        assert.ok(server.body.includes("- 탐지 사유: 신규, 급증"));
        assert.ok(server.body.includes("- Crashlytics: https://console.firebase.google.com/"));
        assert.ok(server.body.includes("할 일 조회가 503으로 실패했습니다."));
        assert.ok(server.body.includes("- blocksCoreFlow: false"));
        assert.ok(server.body.includes("- 서버 코드와 `api-v2` 로그 확인"));
        assert.ok(!server.body.includes("SECRET-QUOTE"));
        assert.ok(server.updateComment.startsWith("### 2026-10-28 갱신"));

        // 서버 이슈는 Firebase 저장소에 만들고 자동 수정 대상이면 auto-fix 라벨 추가
        assert.deepStrictEqual(server.labels, ["crashlytics", "area:server", "auto-fix"]);
        assert.deepStrictEqual(buildIncidentIssue(group, item("server", false), "2026-10-28").labels, ["crashlytics", "area:server"]);

        // iOS 이슈는 iOS 저장소에 만들고 수정 워크플로가 없으므로 자동 수정 대상이어도 auto-fix 라벨 없음
        const ios = buildIncidentIssue(group, item("ios", true), "2026-10-28");
        assert.strictEqual(ios.repository, "iOS");
        assert.deepStrictEqual(ios.labels, ["crashlytics", "area:ios"]);
        assert.ok(ios.body.includes("- 앱 코드와 요청 처리 확인"));

        // 공동 이슈는 기본 저장소 하나에만 만들고 양쪽 확인 항목과 이전 안내, 담당 확인 라벨을 담음
        const shared = buildIncidentIssue(group, item("shared", true), "2026-10-28");
        assert.strictEqual(shared.repository, "Firebase");
        assert.deepStrictEqual(shared.labels, ["crashlytics", "area:shared", "needs-triage"]);
        assert.ok(shared.body.includes("- 서버: 응답 스키마와 상태 코드 확인"));
        assert.ok(shared.body.includes("- iOS: 요청 내용과 모델 처리 확인"));
        assert.ok(shared.body.includes("`DevLog-Labs/iOS`로 이전"));
        assert.ok(shared.body.includes("- 원인 위치: 공동"));

        assert.deepStrictEqual(["server", "ios", "shared"].map(issueRepository), ["Firebase", "iOS", "Firebase"]);

        // REST가 아닌 오류는 상태 코드 없이 식별하고 긴 제목은 잘라 냄
        const nonRest = buildIncidentIssue(
            { ...group, restStatusCode: "", isNew: false, isSurge: false, isRegression: true },
            { ...item("ios", false), title: "가".repeat(500), riskEvidence: { ...riskEvidence, classification: { ...riskEvidence.classification, httpStatus: null } } },
            "2026-10-28"
        );
        assert.strictEqual(nonRest.markerKey, "issue-1:");
        assert.ok(nonRest.title.length <= 200);
        assert.ok(nonRest.body.includes("- 분류: server_5xx\n"));
        assert.ok(nonRest.body.includes("- 탐지 사유: 회귀"));
    }

    console.log("incident-github.test.js passed");
})();
