const assert = require("assert");

const { verifyRiskEvidence } = require("../lib/incident/verify");
const { scoreRisk, rubricVersion } = require("../lib/incident/score");

const flagNames = [
    "fatal",
    "launchCrash",
    "blocksCoreFlow",
    "dataLossPossible",
    "securityArea"
];

function sources(entries = {}) {
    return {
        stack: new Map(entries.stack ?? []),
        serverLog: new Map(entries.serverLog ?? []),
        code: new Map(entries.code ?? []),
        event: new Map(entries.event ?? [])
    };
}

function flags(value, evidenceIds = ["e1"]) {
    return Object.fromEntries(
        flagNames.map((name) => [name, { value, evidenceIds }])
    );
}

function riskEvidence(overrides = {}) {
    return {
        issueId: "issue-1",
        rubricVersion,
        classification: { layer: "client", cause: "decode", httpStatus: null },
        evidence: [
            { id: "e1", source: "stack", ref: "TodoMapper.swift:42", quote: "keyNotFound" },
            { id: "e2", source: "serverLog", ref: "log-1", quote: "status=200" }
        ],
        severity: flags(false),
        rootCause: {
            summary: "응답 필드 누락",
            codeLocation: { file: "TodoMapper.swift", line: 42 },
            reproducible: true
        },
        proposedFix: {
            type: "responseDefault",
            files: ["functions/src/todo/update.ts"],
            reversible: true
        },
        ...overrides
    };
}

const originals = sources({
    stack: [["TodoMapper.swift:42", "Fatal: keyNotFound(CodingKeys.title)"]],
    serverLog: [["log-1", "GET /todos status=200 body={}"]]
});
const lowImpact = { affectedUsers: 3, isRegression: false };

// 원본에 있는 근거와 그 근거를 인용한 판단은 그대로 유지
{
    const result = verifyRiskEvidence(riskEvidence(), originals);

    assert.deepStrictEqual(result.rejectedEvidenceIds, []);
    assert.strictEqual(result.riskEvidence.evidence.length, 2);
    assert.strictEqual(result.riskEvidence.severity.fatal.value, false);
}

// 인용문이 원본에 없는 근거는 제외하고 그 근거를 인용한 판단은 unknown 처리
{
    const input = riskEvidence({
        evidence: [
            { id: "e1", source: "stack", ref: "TodoMapper.swift:42", quote: "존재하지 않는 문장" }
        ]
    });
    const result = verifyRiskEvidence(input, originals);

    assert.deepStrictEqual(result.rejectedEvidenceIds, ["e1"]);
    assert.deepStrictEqual(result.riskEvidence.evidence, []);
    for (const name of flagNames) {
        assert.strictEqual(result.riskEvidence.severity[name].value, "unknown");
    }
}

// 위치가 원본에 없는 근거는 제외
{
    const input = riskEvidence({
        evidence: [
            { id: "e1", source: "stack", ref: "Missing.swift:1", quote: "keyNotFound" }
        ]
    });
    const result = verifyRiskEvidence(input, originals);

    assert.deepStrictEqual(result.rejectedEvidenceIds, ["e1"]);
}

// 근거를 인용하지 않은 판단은 unknown 처리
{
    const input = riskEvidence({ severity: flags(false, []) });
    const result = verifyRiskEvidence(input, originals);

    assert.strictEqual(result.riskEvidence.severity.securityArea.value, "unknown");
}

// 인용한 근거 중 하나라도 검증에 실패하면 판단을 unknown 처리하고 검증된 id만 남김
{
    const input = riskEvidence({ severity: flags(false, ["e1", "e9"]) });
    const result = verifyRiskEvidence(input, originals);

    assert.strictEqual(result.riskEvidence.severity.fatal.value, "unknown");
    assert.deepStrictEqual(result.riskEvidence.severity.fatal.evidenceIds, ["e1"]);
}

// 같은 id를 가진 근거는 모두 제외
{
    const input = riskEvidence({
        evidence: [
            { id: "e1", source: "stack", ref: "TodoMapper.swift:42", quote: "keyNotFound" },
            { id: "e1", source: "serverLog", ref: "log-1", quote: "status=200" }
        ]
    });
    const result = verifyRiskEvidence(input, originals);

    assert.deepStrictEqual(result.rejectedEvidenceIds, ["e1"]);
    assert.deepStrictEqual(result.riskEvidence.evidence, []);
}

// 허용된 수정 유형이고 수정 범위가 작으며 확신 조건을 충족하고 데이터 손실과 보안 문제가 없으면 자동 수정 대상
{
    const score = scoreRisk(riskEvidence(), lowImpact);

    assert.deepStrictEqual(score.levels, {
        impact: 0,
        severity: 1,
        changeRisk: 0,
        uncertainty: 0
    });
    assert.strictEqual(score.confidence, 3);
    assert.strictEqual(score.grade, 1);
    assert.deepStrictEqual(score.decidingAxes, ["severity"]);
    assert.strictEqual(score.autoFixEligible, true);
    assert.strictEqual(score.rubricVersion, rubricVersion);
}

// 알 수 없는 심각도 플래그는 최대 수준 2를 부여하고, 데이터 손실이나 보안이 알 수 없으면 자동 수정 대상에서 제외
{
    for (const name of flagNames) {
        const input = riskEvidence({
            severity: {
                ...flags(false),
                [name]: { value: "unknown", evidenceIds: [] }
            }
        });
        const score = scoreRisk(input, lowImpact);

        assert.strictEqual(score.levels.severity, 2, name);
        assert.strictEqual(
            score.autoFixEligible,
            name !== "dataLossPossible" && name !== "securityArea",
            name
        );
    }
}

// 켜진 플래그는 각자의 수준을 부여하고 가장 높은 수준이 심각도 수준이 됨
{
    const levelOf = (name) => scoreRisk(
        riskEvidence({ severity: { ...flags(false), [name]: { value: true, evidenceIds: ["e1"] } } }),
        lowImpact
    ).levels.severity;

    assert.deepStrictEqual(
        flagNames.map(levelOf),
        [2, 3, 2, 3, 3]
    );
}

// 고유 사용자 수가 기준값에 도달할 때마다 영향도 수준이 오름
{
    const levels = [0, 4, 5, 19, 20, 99, 100].map((affectedUsers) => (
        scoreRisk(riskEvidence(), { affectedUsers, isRegression: false }).levels.impact
    ));

    assert.deepStrictEqual(levels, [0, 0, 1, 1, 2, 2, 3]);
}

// 회귀 이슈는 사용자 수가 적어도 영향도 수준이 2 이상이지만 영향도는 자동 수정 자격을 막지 않음
{
    const score = scoreRisk(riskEvidence(), { affectedUsers: 1, isRegression: true });

    assert.strictEqual(score.levels.impact, 2);
    assert.strictEqual(score.autoFixEligible, true);
}

// 민감 경로를 수정하거나 되돌리기 어려운 수정은 변경 위험 수준이 3
{
    const sensitive = riskEvidence({
        proposedFix: { type: "nullGuard", files: ["firestore.rules"], reversible: true }
    });
    const irreversible = riskEvidence({
        proposedFix: { type: "nullGuard", files: ["functions/src/todo/update.ts"], reversible: false }
    });

    assert.strictEqual(scoreRisk(sensitive, lowImpact).levels.changeRisk, 3);
    assert.strictEqual(scoreRisk(irreversible, lowImpact).levels.changeRisk, 3);
}

// 수정 파일 수가 늘수록 변경 위험 수준이 오름
{
    const withFiles = (count) => riskEvidence({
        proposedFix: {
            type: "nullGuard",
            files: Array.from({ length: count }, (_, index) => `functions/src/file${index}.ts`),
            reversible: true
        }
    });
    const levels = [1, 2, 3, 4].map(
        (count) => scoreRisk(withFiles(count), lowImpact).levels.changeRisk
    );

    assert.deepStrictEqual(levels, [0, 1, 1, 2]);
}

// 충족한 확신 조건 개수만큼 확신도가 오르고 불확실성은 그만큼 내려감
{
    const noLocation = riskEvidence({
        rootCause: { summary: "", codeLocation: null, reproducible: false },
        evidence: [{ id: "e2", source: "serverLog", ref: "log-1", quote: "status=200" }]
    });
    const score = scoreRisk(noLocation, lowImpact);

    assert.strictEqual(score.confidence, 1);
    assert.strictEqual(score.levels.uncertainty, 2);
    assert.strictEqual(score.autoFixEligible, false);
}

// 알림 등급은 영향도와 심각도 중 높은 수준이며 변경 위험과 불확실성은 등급에 반영하지 않고 자동 수정 자격만 막음
{
    const noEvidence = riskEvidence({
        evidence: [],
        rootCause: { summary: "", codeLocation: null, reproducible: false },
        proposedFix: { type: "none", files: [], reversible: false }
    });
    const score = scoreRisk(noEvidence, lowImpact);

    assert.strictEqual(score.levels.uncertainty, 3);
    assert.strictEqual(score.grade, 1);
    assert.deepStrictEqual(score.decidingAxes, ["severity"]);
    assert.strictEqual(score.autoFixEligible, false);
}

// 알림 등급은 가장 나쁜 축의 수준이며 그 축을 결정 축으로 보고
{
    const input = riskEvidence({
        severity: {
            ...flags(false),
            dataLossPossible: { value: true, evidenceIds: ["e1"] }
        }
    });
    const score = scoreRisk(input, { affectedUsers: 20, isRegression: false });

    assert.strictEqual(score.grade, 3);
    assert.deepStrictEqual(score.decidingAxes, ["severity"]);
}

// 허용 목록에 없는 수정 유형과 수정 제안이 없는 경우는 자동 수정 대상에서 제외
{
    const notAllowed = riskEvidence({
        proposedFix: { type: "refactor", files: ["functions/src/a.ts"], reversible: true }
    });
    const none = riskEvidence({
        proposedFix: { type: "none", files: [], reversible: true }
    });

    assert.strictEqual(scoreRisk(notAllowed, lowImpact).autoFixEligible, false);
    assert.strictEqual(scoreRisk(none, lowImpact).autoFixEligible, false);
}

// 영향도와 심각도가 높아도 수정이 작고 원인이 확인되며 데이터 손실과 보안 문제가 없으면 자동 수정 대상
{
    const input = riskEvidence({
        severity: {
            ...flags(false),
            fatal: { value: true, evidenceIds: ["e1"] },
            launchCrash: { value: true, evidenceIds: ["e1"] },
            blocksCoreFlow: { value: true, evidenceIds: ["e1"] }
        }
    });
    const score = scoreRisk(input, { affectedUsers: 500, isRegression: true });

    assert.deepStrictEqual([score.levels.impact, score.levels.severity, score.grade], [3, 3, 3]);
    assert.strictEqual(score.autoFixEligible, true);
}

// 데이터 손실이나 보안 문제가 있으면 자동 수정 대상에서 제외하고, 변경 위험이나 불확실성이 2 이상이어도 제외
{
    const withFlag = (name, value) => scoreRisk(
        riskEvidence({ severity: { ...flags(false), [name]: { value, evidenceIds: ["e1"] } } }),
        lowImpact
    ).autoFixEligible;
    const manyFiles = riskEvidence({
        proposedFix: { type: "nullGuard", files: ["a.ts", "b.ts", "c.ts", "d.ts"], reversible: true }
    });

    assert.strictEqual(withFlag("dataLossPossible", true), false);
    assert.strictEqual(withFlag("securityArea", true), false);
    assert.strictEqual(scoreRisk(manyFiles, lowImpact).levels.changeRisk, 2);
    assert.strictEqual(scoreRisk(manyFiles, lowImpact).autoFixEligible, false);
}

console.log("incident-risk.test.js passed");
