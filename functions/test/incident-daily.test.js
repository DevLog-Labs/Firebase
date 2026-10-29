const assert = require("assert");
const axios = require("axios");

process.env.GCLOUD_PROJECT = "devlog-test";
process.env.OPENAI_API_KEY = "sk-test-key";
process.env.DISCORD_WEBHOOK_URL = "https://discord.com/api/webhooks/1/secret-token";

let bigQueryResponses = [];
let bigQueryFailure;
class FakeBigQuery {
    async query() {
        if (bigQueryFailure) { throw bigQueryFailure; }
        return [bigQueryResponses.shift() ?? []];
    }
}
require.cache[require.resolve("@google-cloud/bigquery")] = {
    exports: { BigQuery: FakeBigQuery }
};

class FakeLogging {
    async getEntries() {
        return [[]];
    }
}
require.cache[require.resolve("@google-cloud/logging")] = {
    exports: { Logging: FakeLogging }
};

const infoLogs = [];
const errorLogs = [];
require.cache[require.resolve("firebase-functions/logger")] = {
    exports: {
        info: (...values) => infoLogs.push(values),
        warn() {},
        error: (...values) => errorLogs.push(values)
    }
};

const { sendDailyIncidentReport } = require("../lib/incident/daily");

const flagNames = [
    "fatal",
    "launchCrash",
    "blocksCoreFlow",
    "dataLossPossible",
    "securityArea"
];

function groupRow(issueId, status, users, isFatal = false) {
    return {
        issueId,
        restStatusCode: status,
        issueSubtitle: `DevLogInfra.Service.op${issueId} (1)`,
        isFatal,
        affectedUsers: users,
        isNew: true,
        isRegression: false,
        isSurge: false
    };
}

function sampleRow(id) {
    return {
        eventId: id,
        eventTimestamp: { value: "2026-10-28T03:10:00.000000Z" },
        appVersion: "1.6",
        appBuild: "1",
        osVersion: "26.7.1",
        deviceModel: "iPhone17,1",
        customKeys: JSON.stringify([{ key: "restErrorMessage", value: "user@example.com 확인" }]),
        breadcrumbNames: "[]",
        errorFrames: JSON.stringify([
            { file: "TodoCommandServiceImpl.swift", line: 62, symbol: "requestTodoDeletion", library: "Infra" }
        ]),
        exceptionFrames: "[]",
        crashFrames: "[]"
    };
}

function analysis(quote = "requestTodoDeletion") {
    return {
        classification: { layer: "server", cause: "server_5xx", httpStatus: 503 },
        evidence: [{ id: "e1", source: "stack", ref: "frame-0", quote }],
        severity: Object.fromEntries(
            flagNames.map((name) => [name, { value: false, evidenceIds: ["e1"] }])
        ),
        rootCause: {
            summary: "삭제 요청이 503으로 실패합니다.",
            codeLocation: { file: "TodoCommandServiceImpl.swift", line: 62 },
            reproducible: false
        },
        proposedFix: { type: "none", files: [], reversible: true }
    };
}

function completed(value) {
    return {
        status: 200,
        data: {
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: JSON.stringify(value) }] }]
        }
    };
}

const requests = [];
let openAiHandler;
let discordStatus = 204;
axios.request = async (config) => {
    requests.push(config);
    if (config.url.startsWith("https://api.openai.com")) { return openAiHandler(config); }
    return { status: discordStatus, data: "" };
};

function reset() {
    requests.length = 0;
    infoLogs.length = 0;
    errorLogs.length = 0;
    bigQueryFailure = undefined;
    discordStatus = 204;
}

function discordMessages() {
    return requests
        .filter((request) => request.url.startsWith("https://discord.com"))
        .map((request) => request.data);
}

(async () => {
    // 분석 결과를 근거 검증과 위험도 계산을 거쳐 사용자 수 순서의 Discord 요약으로 전송하고, 분석 입력은 마스킹
    {
        reset();
        bigQueryResponses = [
            [groupRow("a", "503", 2), groupRow("b", "404", 120)],
            [sampleRow("ea")],
            [sampleRow("eb")]
        ];
        openAiHandler = () => completed(analysis());

        await sendDailyIncidentReport.run({});

        const openAiRequests = requests.filter((request) => request.url.startsWith("https://api.openai.com"));
        const [message] = discordMessages();

        assert.strictEqual(openAiRequests.length, 2);
        assert.strictEqual(openAiRequests[0].headers.Authorization, "Bearer sk-test-key");
        assert.ok(!JSON.stringify(openAiRequests[0].data).includes("user@example.com"));
        assert.strictEqual(requests.at(-1).url, "https://discord.com/api/webhooks/1/secret-token");
        assert.strictEqual(discordMessages().length, 1);
        assert.ok(message.content.endsWith("신규·급증·회귀 2건"));
        assert.deepStrictEqual(message.allowed_mentions, { parse: [] });
        assert.ok(message.embeds[0].title.startsWith("등급 3"));
        assert.ok(message.embeds[0].title.includes("opb"));
        assert.ok(message.embeds[1].title.includes("opa") || message.embeds[1].description.includes("opa"));
        assert.deepStrictEqual(errorLogs, []);

        const [, fields] = infoLogs.find(([text, values]) => text === "이슈 분석 완료" && values.issueId === "b");
        assert.deepStrictEqual(
            Object.keys(fields).sort(),
            [
                "affectedUsers", "autoFixEligible", "decidingAxes", "grade", "issueId",
                "levels", "rejectedEvidenceIds", "restStatusCode", "rubricVersion"
            ]
        );
        assert.deepStrictEqual(fields.rejectedEvidenceIds, []);
    }

    // 모델이 지어낸 인용문은 걸러내고 해당 판단을 unknown으로 되돌려 심각도를 최악으로 계산
    {
        reset();
        bigQueryResponses = [[groupRow("a", "503", 1)], [sampleRow("ea")]];
        openAiHandler = () => completed(analysis("존재하지 않는 인용문"));

        await sendDailyIncidentReport.run({});

        const [, fields] = infoLogs.find(([text]) => text === "이슈 분석 완료");
        assert.deepStrictEqual(fields.rejectedEvidenceIds, ["e1"]);
        assert.strictEqual(fields.levels.severity, 2);
        assert.strictEqual(fields.autoFixEligible, false);
    }

    // 비치명 오류에서는 모델이 launchCrash를 true로 판단해도 false로 덮어쓰고, 크래시 이슈는 fatal이 true로 확정되어 심각도 수준이 2
    {
        reset();
        bigQueryResponses = [[groupRow("a", "503", 1)], [sampleRow("ea")]];
        const crashingOutput = analysis();
        crashingOutput.severity.launchCrash = { value: true, evidenceIds: ["e1"] };
        openAiHandler = () => completed(crashingOutput);

        await sendDailyIncidentReport.run({});

        const [, nonFatal] = infoLogs.find(([text]) => text === "이슈 분석 완료");
        assert.strictEqual(nonFatal.levels.severity, 1);

        reset();
        bigQueryResponses = [[groupRow("a", "", 1, true)], [sampleRow("ea")]];
        openAiHandler = () => completed(analysis());

        await sendDailyIncidentReport.run({});

        const [, fatal] = infoLogs.find(([text]) => text === "이슈 분석 완료");
        assert.strictEqual(fatal.levels.severity, 2);
    }

    // 분석에 실패한 이슈도 요약에 판단 불가 항목으로 포함하고 나머지 이슈 분석은 계속
    {
        reset();
        bigQueryResponses = [
            [groupRow("a", "503", 5), groupRow("b", "404", 1)],
            [sampleRow("ea")],
            [sampleRow("eb")]
        ];
        let calls = 0;
        openAiHandler = () => {
            calls++;
            return calls === 1
                ? { status: 400, data: { error: { message: "bad request" } } }
                : completed(analysis());
        };

        await sendDailyIncidentReport.run({});

        const [message] = discordMessages();
        const failed = message.embeds.find((embed) => embed.description.includes("자동 분석에 실패했습니다"));

        assert.ok(failed);
        assert.ok(failed.title.startsWith("등급 3"));
        assert.strictEqual(errorLogs.length, 1);
        assert.strictEqual(errorLogs[0][0], "이슈 분석 실패");
        assert.strictEqual(message.content.endsWith("2건"), true);
    }

    // 대상 이슈가 없으면 이슈가 없다는 메시지 전송
    {
        reset();
        bigQueryResponses = [[]];

        await sendDailyIncidentReport.run({});

        const [message] = discordMessages();
        assert.deepStrictEqual(message.embeds, []);
        assert.ok(message.content.includes("이슈가 없습니다"));
    }

    // 조회 자체가 실패하면 로그를 남기고 Discord에 실패 알림을 보내며 예외를 던지지 않음
    {
        reset();
        bigQueryFailure = new Error("BigQuery unavailable");

        await sendDailyIncidentReport.run({});

        const [message] = discordMessages();
        assert.strictEqual(errorLogs[0][0], "일일 오류 요약 생성 실패");
        assert.ok(message.content.includes("만들지 못했습니다"));
        assert.ok(!JSON.stringify(message).includes("BigQuery unavailable"));
    }

    // 실패 알림 전송까지 실패해도 예외 없이 로그만 남김
    {
        reset();
        bigQueryFailure = new Error("BigQuery unavailable");
        discordStatus = 500;

        await sendDailyIncidentReport.run({});

        assert.deepStrictEqual(
            errorLogs.map(([text]) => text),
            ["일일 오류 요약 생성 실패", "일일 오류 요약 실패 알림 전송 실패"]
        );
    }

    console.log("incident-daily.test.js passed");
})();
