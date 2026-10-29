const assert = require("assert");
const axios = require("axios");

const { analyzeIssue } = require("../lib/incident/analyze");
const {
    parseRiskAnalysis,
    riskAnalysisJsonSchema
} = require("../lib/incident/schema");
const { verifyRiskEvidence } = require("../lib/incident/verify");
const { rubricVersion } = require("../lib/incident/score");

const flagNames = [
    "fatal",
    "launchCrash",
    "blocksCoreFlow",
    "dataLossPossible",
    "securityArea"
];

const analysis = {
    classification: { layer: "client", cause: "decode", httpStatus: 200 },
    evidence: [
        { id: "e1", source: "stack", ref: "TodoMapper.swift:42", quote: "keyNotFound" }
    ],
    severity: Object.fromEntries(
        flagNames.map((name) => [name, { value: false, evidenceIds: ["e1"] }])
    ),
    rootCause: {
        summary: "응답 필드 누락",
        codeLocation: { file: "TodoMapper.swift", line: 42 },
        reproducible: true
    },
    proposedFix: { type: "responseDefault", files: ["functions/src/todo/update.ts"], reversible: true }
};

const context = {
    issueId: "issue-1",
    title: "fetchTodos 실패 user@example.com",
    isFatal: false,
    origin: { kind: "server", reasons: ["서버가 503 응답"] },
    sources: {
        stack: [{ ref: "TodoMapper.swift:42", text: "Fatal: keyNotFound token=abc123" }],
        serverLog: [],
        code: [],
        event: [{ ref: "ev-1", text: "restErrorMessage=계정 user@example.com 확인" }]
    }
};

function completed(output) {
    return {
        status: 200,
        data: {
            status: "completed",
            output: [{ type: "message", content: [{ type: "output_text", text: output }] }]
        }
    };
}

// strict 모드 규칙: 모든 객체는 추가 속성을 금지하고 모든 속성을 required에 선언
function assertStrictObjects(schema, path = "root") {
    if (Array.isArray(schema)) {
        schema.forEach((item, index) => assertStrictObjects(item, `${path}[${index}]`));
        return;
    }
    if (typeof schema !== "object" || schema === null) { return; }

    if (schema.type === "object") {
        assert.strictEqual(schema.additionalProperties, false, `${path}: additionalProperties`);
        assert.deepStrictEqual(
            [...schema.required].sort(),
            Object.keys(schema.properties).sort(),
            `${path}: required`
        );
    }
    for (const [key, value] of Object.entries(schema)) {
        assertStrictObjects(value, `${path}.${key}`);
    }
}

// JSON schema는 strict 모드 규칙을 지키고 루트는 객체
assertStrictObjects(riskAnalysisJsonSchema);
assert.strictEqual(riskAnalysisJsonSchema.type, "object");

// 스키마와 일치하는 결과는 파싱하고 어긋난 결과는 거부
assert.deepStrictEqual(parseRiskAnalysis(JSON.stringify(analysis)), analysis);
assert.throws(() => parseRiskAnalysis("not json"), /JSON 형식/);
for (const broken of [
    { ...analysis, classification: { ...analysis.classification, layer: "mobile" } },
    { ...analysis, evidence: [{ id: "e1" }] },
    { ...analysis, severity: { ...analysis.severity, fatal: { value: "maybe", evidenceIds: [] } } },
    { ...analysis, rootCause: { ...analysis.rootCause, codeLocation: { file: "a" } } },
    { ...analysis, proposedFix: { ...analysis.proposedFix, type: "rewriteEverything" } },
    { ...analysis, severity: { fatal: analysis.severity.fatal } }
]) {
    assert.throws(() => parseRiskAnalysis(JSON.stringify(broken)), /스키마와 일치하지 않습니다/);
}

(async () => {
    const originalRequest = axios.request;
    const originalSetTimeout = global.setTimeout;
    global.setTimeout = (callback) => originalSetTimeout(callback, 0);

    try {
        // 요청 본문: 모델, 추론 강도, strict 스키마, 저장 안 함, 마스킹된 입력
        {
            const calls = [];
            axios.request = async (config) => {
                calls.push(config);
                return completed(JSON.stringify(analysis));
            };

            const result = await analyzeIssue("sk-test-key", context);
            const [call] = calls;

            assert.strictEqual(calls.length, 1);
            assert.strictEqual(call.url, "https://api.openai.com/v1/responses");
            assert.strictEqual(call.headers.Authorization, "Bearer sk-test-key");
            assert.strictEqual(call.data.model, "gpt-6.1-terra");
            assert.deepStrictEqual(call.data.reasoning, { effort: "medium" });
            assert.strictEqual(call.data.store, false);
            assert.strictEqual(call.data.text.format.type, "json_schema");
            assert.strictEqual(call.data.text.format.strict, true);
            assert.strictEqual(call.data.text.format.schema, riskAnalysisJsonSchema);
            assert.ok(!JSON.stringify(call.data).includes("user@example.com"));
            assert.ok(!JSON.stringify(call.data).includes("abc123"));
            assert.ok(call.data.input.includes("[email]"));
            assert.ok(call.data.input.includes('"isFatal":false'));
            assert.ok(call.data.input.includes('"origin":{"kind":"server"'));
            assert.ok(!JSON.stringify(call.data).includes("sk-test-key"));

            // 결과: 이슈 ID와 루브릭 버전을 채우고 마스킹된 원본을 반환
            assert.strictEqual(result.riskEvidence.issueId, "issue-1");
            assert.strictEqual(result.riskEvidence.rubricVersion, rubricVersion);
            assert.strictEqual(result.riskEvidence.rootCause.summary, "응답 필드 누락");
            assert.ok(result.sources.event.get("ev-1").includes("[email]"));
            assert.strictEqual(
                result.sources.stack.get("TodoMapper.swift:42"),
                "Fatal: keyNotFound token=\"[masked]\""
            );

            // 반환한 원본으로 근거 검증이 통과
            const verified = verifyRiskEvidence(result.riskEvidence, result.sources);
            assert.deepStrictEqual(verified.rejectedEvidenceIds, []);
        }

        // 속도 제한(429)과 서버 오류(5xx)는 다시 시도
        {
            const responses = [
                { status: 429, data: { error: { message: "rate limit" } } },
                { status: 503, data: {} },
                completed(JSON.stringify(analysis))
            ];
            let calls = 0;
            axios.request = async () => {
                calls++;
                return responses.shift();
            };

            await analyzeIssue("sk-test-key", context);

            assert.strictEqual(calls, 3);
        }

        // 재시도를 모두 소진하거나 재시도 대상이 아닌 오류는 실패하며 오류에 API 키가 없음
        {
            let calls = 0;
            axios.request = async () => {
                calls++;
                return { status: 429, data: { error: { message: "rate limit" } } };
            };
            await assert.rejects(
                analyzeIssue("sk-secret-key", context),
                (error) => /status=429 rate limit/.test(error.message) && !error.message.includes("sk-secret-key")
            );
            assert.strictEqual(calls, 3);

            calls = 0;
            axios.request = async () => {
                calls++;
                return { status: 400, data: { error: { message: "bad schema" } } };
            };
            await assert.rejects(analyzeIssue("sk-secret-key", context), /status=400 bad schema/);
            assert.strictEqual(calls, 1);
        }

        // 네트워크 오류가 나도 오류에 API 키가 섞이지 않음
        {
            axios.request = async (config) => {
                throw new Error(`failed ${config.headers.Authorization}`);
            };

            await assert.rejects(
                analyzeIssue("sk-secret-key", context),
                (error) => !error.message.includes("sk-secret-key") && !String(error.stack).includes("sk-secret-key")
            );
        }

        // 미완료 응답, 거부, 출력 없음, 스키마 불일치는 오류
        {
            const cases = [
                [{ status: 200, data: { status: "incomplete", output: [] } }, /완료되지 않았습니다/],
                [
                    {
                        status: 200,
                        data: { status: "completed", output: [{ type: "message", content: [{ type: "refusal", refusal: "no" }] }] }
                    },
                    /거부했습니다/
                ],
                [{ status: 200, data: { status: "completed", output: [] } }, /출력 텍스트가 없습니다/],
                [completed(JSON.stringify({ ...analysis, evidence: "x" })), /스키마와 일치하지 않습니다/]
            ];
            for (const [response, pattern] of cases) {
                axios.request = async () => response;
                await assert.rejects(analyzeIssue("sk-test-key", context), pattern);
            }
        }
    } finally {
        axios.request = originalRequest;
        global.setTimeout = originalSetTimeout;
    }

    console.log("incident-analyze.test.js passed");
})();
