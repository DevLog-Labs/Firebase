const assert = require("assert");
const axios = require("axios");

const errorLogs = [];
const warnLogs = [];
require.cache[require.resolve("firebase-functions/logger")] = {
    exports: { error: (...values) => errorLogs.push(values), warn: (...values) => warnLogs.push(values), info() {} }
};

const records = new Map();
let recordFailure;
const firestore = require("firebase-admin/firestore");
require.cache[require.resolve("firebase-admin/firestore")] = {
    exports: {
        ...firestore,
        getFirestore: () => ({
            doc: (path) => ({
                async get() {
                    if (recordFailure === "read") { throw new Error("read failed"); }
                    const data = records.get(path);
                    return { get: (field) => data?.[field] };
                },
                async set(data) {
                    if (recordFailure === "write") { throw new Error("write failed"); }
                    records.set(path, data);
                }
            })
        })
    }
};

const { syncIncidentIssues } = require("../lib/incident/github");
const { buildIncidentIssue } = require("../lib/incident/report");
const { scoreRisk } = require("../lib/incident/score");

const token = "ghp_secrettoken";
const firebaseUrl = "https://api.github.com/repos/DevLog-Labs/Firebase";
const flagNames = [
    "fatal",
    "launchCrash",
    "blocksCoreFlow",
    "dataLossPossible",
    "securityArea"
];

function draft(markerKey, labels = ["crashlytics"]) {
    return {
        markerKey,
        title: `제목 ${markerKey}`,
        body: `<!-- crashlytics:${markerKey} -->\n본문`,
        labels,
        updateComment: `갱신 ${markerKey}`
    };
}

const requests = [];
let openIssues = [];
let issueStates = {};
let failures = {};
axios.request = async (config) => {
    requests.push(config);
    const path = config.url.replace("https://api.github.com", "");
    const key = `${config.method} ${path.split("?")[0]}`;
    const override = failures[key];
    if (override === "network") { throw new Error(`failed ${config.headers.Authorization}`); }
    if (override) { return { status: override, data: {} }; }

    const single = /\/issues\/(\d+)$/.exec(path);
    if (config.method === "get" && single !== null) {
        const state = issueStates[single[1]];
        return state === undefined ? { status: 404, data: {} } : { status: 200, data: { state } };
    }
    if (config.method === "get") {
        return { status: 200, data: openIssues };
    }
    if (path.endsWith("/labels") || path.endsWith("/comments")) { return { status: 201, data: {} }; }
    return { status: 201, data: { number: 100 + requests.length } };
};

function reset() {
    requests.length = 0;
    errorLogs.length = 0;
    warnLogs.length = 0;
    openIssues = [];
    issueStates = {};
    failures = {};
    records.clear();
    recordFailure = undefined;
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

    // Firebase 저장소에 라벨을 보장하고 열린 이슈를 조회한 뒤 없으면 이슈를 생성
    {
        reset();
        const results = await syncIncidentIssues(token, [draft("a:503", ["crashlytics", "auto-fix"])]);

        assert.deepStrictEqual(
            calls("post", `${firebaseUrl}/labels`).map((request) => request.data.name),
            ["crashlytics", "auto-fix"]
        );
        assert.ok(requests.some((request) => request.method === "get" && request.url.startsWith(`${firebaseUrl}/issues?labels=crashlytics&state=open`)));
        assert.ok(requests.every((request) => request.url.startsWith(firebaseUrl)));

        const [created] = calls("post", `${firebaseUrl}/issues`);
        assert.deepStrictEqual(created.data.labels, ["crashlytics", "auto-fix"]);
        assert.strictEqual(created.data.title, "제목 a:503");
        assert.strictEqual(created.headers.Authorization, `Bearer ${token}`);
        assert.strictEqual(created.headers["User-Agent"], "DevLog-Firebase");
        assert.strictEqual(results[0].action, "created");
        assert.ok(results[0].number > 100);
        assert.strictEqual(records.get("incidentIssues/a:503").number, results[0].number);
    }

    // 목록에 아직 반영되지 않았어도 기록된 이슈가 열려 있으면 댓글로 갱신하고 새로 만들지 않음
    {
        reset();
        records.set("incidentIssues/a:503", { number: 7 });
        issueStates["7"] = "open";

        const results = await syncIncidentIssues(token, [draft("a:503")]);

        assert.deepStrictEqual(results, [{ markerKey: "a:503", action: "commented", number: 7 }]);
        assert.strictEqual(calls("post", `${firebaseUrl}/issues/7/comments`)[0].data.body, "갱신 a:503");
        assert.strictEqual(calls("post", `${firebaseUrl}/issues`).length, 0);
    }

    // 기록된 이슈가 닫혔거나 삭제됐으면 새 이슈를 만들고 기록을 새 번호로 교체
    {
        reset();
        records.set("incidentIssues/a:503", { number: 7 });
        records.set("incidentIssues/b:500", { number: 8 });
        issueStates["7"] = "closed";

        const results = await syncIncidentIssues(token, [draft("a:503"), draft("b:500")]);

        assert.deepStrictEqual(results.map((result) => result.action), ["created", "created"]);
        assert.strictEqual(records.get("incidentIssues/a:503").number, results[0].number);
        assert.strictEqual(records.get("incidentIssues/b:500").number, results[1].number);
    }

    // 기록된 이슈의 조회가 실패하면 중복을 피하려고 만들지 않고 실패로 기록
    {
        reset();
        records.set("incidentIssues/a:503", { number: 7 });
        failures["get /repos/DevLog-Labs/Firebase/issues/7"] = 500;

        const results = await syncIncidentIssues(token, [draft("a:503")]);

        assert.deepStrictEqual(results, [{ markerKey: "a:503", action: "failed", number: null }]);
        assert.strictEqual(calls("post", `${firebaseUrl}/issues`).length, 0);
    }

    // 기록 조회가 실패하면 이슈를 만들고, 기록 저장이 실패해도 생성 결과를 유지
    {
        reset();
        recordFailure = "read";
        const read = await syncIncidentIssues(token, [draft("a:503")]);
        assert.strictEqual(read[0].action, "created");
        assert.strictEqual(warnLogs.length, 1);

        reset();
        recordFailure = "write";
        const written = await syncIncidentIssues(token, [draft("a:503")]);
        assert.strictEqual(written[0].action, "created");
        assert.ok(written[0].number > 100);
        assert.strictEqual(errorLogs.length, 1);
    }

    // 같은 식별 표식의 열린 이슈가 있으면 댓글로 갱신하고 풀 리퀘스트와 표식 없는 이슈는 무시
    {
        reset();
        openIssues = [
            { number: 7, body: "<!-- crashlytics:a:503 -->\n본문" },
            { number: 8, body: "<!-- crashlytics:b:500 -->", pull_request: {} },
            { number: 9, body: "표식 없는 이슈" }
        ];

        const results = await syncIncidentIssues(token, [draft("a:503"), draft("b:500")]);

        assert.deepStrictEqual(
            results.map((result) => [result.action, result.number]),
            [["commented", 7], ["created", results[1].number]]
        );
        assert.strictEqual(calls("post", `${firebaseUrl}/issues/7/comments`)[0].data.body, "갱신 a:503");
        assert.strictEqual(calls("post", `${firebaseUrl}/issues`).length, 1);
    }

    // 라벨이 이미 있어 422가 와도 계속 진행
    {
        reset();
        failures["post /repos/DevLog-Labs/Firebase/labels"] = 422;

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
        failures["get /repos/DevLog-Labs/Firebase/issues"] = 500;
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

    // 이슈 초안: 자동 수정 라벨과 확인할 곳을 담고 근거 원문은 담지 않음
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

        assert.deepStrictEqual(server.labels, ["crashlytics", "auto-fix"]);

        // REST가 아닌 오류는 상태 코드 없이 식별하고 긴 제목은 잘라 냄
        const nonRest = buildIncidentIssue(
            { ...group, restStatusCode: "", isNew: false, isSurge: false, isRegression: true },
            { ...item("server", true), title: "가".repeat(500), riskEvidence: { ...riskEvidence, classification: { ...riskEvidence.classification, httpStatus: null } } },
            "2026-10-28"
        );
        assert.strictEqual(nonRest.markerKey, "issue-1:");
        assert.ok(nonRest.title.length <= 200);
        assert.ok(nonRest.body.includes("- 분류: server_5xx\n"));
        assert.ok(nonRest.body.includes("- 탐지 사유: 회귀"));
    }

    console.log("incident-github.test.js passed");
})();
