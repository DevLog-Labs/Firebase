// 자동 수정을 허용하는 수정 유형 목록
export const allowedFixTypes = [
    "optionalDecoding",
    "nilGuard",
    "messageText"
] as const;

// 자동 수정을 허용하는 수정 유형 하나
export type AllowedFixType = typeof allowedFixTypes[number];

// 심각도 판단에 사용하는 플래그 이름 목록
export const severityFlagNames = [
    "fatal",
    "launchCrash",
    "blocksCoreFlow",
    "dataLossPossible",
    "securityArea"
] as const;

// 심각도 판단에 사용하는 플래그 이름 하나
export type SeverityFlagName = typeof severityFlagNames[number];

// 근거가 나온 출처 종류
export type EvidenceSource = "stack" | "serverLog" | "code" | "event";

// 판단에 인용하는 원문 근거 하나
export type Evidence = {
    // 근거를 가리키는 id
    id: string;
    // 근거가 나온 출처
    source: EvidenceSource;
    // 출처 안의 위치(파일:라인 또는 로그 ID)
    ref: string;
    // 출처 원문에서 그대로 가져온 문장
    quote: string;
};

// 근거 인용이 달린 판단 하나
export type Flag = {
    // 판단 결과. 근거가 없으면 "unknown"
    value: boolean | "unknown";
    // 판단 근거로 인용한 evidence id 목록
    evidenceIds: string[];
};

// 오류가 발생한 계층과 원인 분류
export type Classification = {
    // 오류가 발생한 계층
    layer: "client" | "server" | "network" | "unknown";
    // 원인 분류 이름
    cause: string;
    // REST 오류의 HTTP 상태 코드. 해당하지 않으면 null
    httpStatus: number | null;
};

// 원인으로 추정하는 코드 위치
export type CodeLocation = {
    // 대상 파일 경로
    file: string;
    // 대상 라인 번호
    line: number;
};

// 추정 원인과 재현 가능 여부
export type RootCause = {
    // 원인 요약 문장
    summary: string;
    // 원인으로 추정하는 코드 위치. 알 수 없으면 null
    codeLocation: CodeLocation | null;
    // 오류 재현 가능 여부
    reproducible: boolean;
};

// 에이전트가 제안하는 수정 내용
export type ProposedFix = {
    // 수정 유형. 제안이 없으면 "none"
    type: "none" | AllowedFixType;
    // 수정 대상 파일 경로 목록
    files: string[];
    // 수정을 되돌리기 쉬운지 여부
    reversible: boolean;
};

// 에이전트가 이슈 하나에 대해 내놓는 분석 결과
export type RiskEvidence = {
    // 분석 대상 Crashlytics 이슈 ID
    issueId: string;
    // 점수 계산에 사용한 루브릭 버전
    rubricVersion: string;
    // 오류가 발생한 계층과 원인 분류
    classification: Classification;
    // 판단에 인용한 근거 목록
    evidence: Evidence[];
    // 심각도 플래그별 판단
    severity: Record<SeverityFlagName, Flag>;
    // 추정 원인과 코드 위치
    rootCause: RootCause;
    // 제안하는 수정 유형과 대상 파일
    proposedFix: ProposedFix;
};

// 에이전트가 직접 생성하는 분석 결과. 이슈 ID와 루브릭 버전은 호출 쪽에서 채움
export type RiskAnalysis = Omit<RiskEvidence, "issueId" | "rubricVersion">;

// 오류가 발생한 계층 값 목록
const classificationLayers: Classification["layer"][] = [
    "client",
    "server",
    "network",
    "unknown"
];

// 근거 출처 값 목록
const evidenceSources: EvidenceSource[] = [
    "stack",
    "serverLog",
    "code",
    "event"
];

// 속성을 모두 필수로 선언하고 추가 속성을 금지하는 strict 객체 스키마 생성
function objectSchema(properties: Record<string, object>): object {
    return {
        type: "object",
        additionalProperties: false,
        required: Object.keys(properties),
        properties
    };
}

// 문자열 스키마
const stringSchema = { type: "string" };

// 근거 인용이 달린 판단 하나의 스키마
const flagSchema = objectSchema({
    value: { anyOf: [{ type: "boolean" }, { type: "string", enum: ["unknown"] }] },
    evidenceIds: { type: "array", items: stringSchema }
});

// 분석 결과를 structured outputs로 강제하는 JSON schema
export const riskAnalysisJsonSchema = objectSchema({
    classification: objectSchema({
        layer: { type: "string", enum: classificationLayers },
        cause: stringSchema,
        httpStatus: { type: ["integer", "null"] }
    }),
    evidence: {
        type: "array",
        items: objectSchema({
            id: stringSchema,
            source: { type: "string", enum: evidenceSources },
            ref: stringSchema,
            quote: stringSchema
        })
    },
    severity: objectSchema(
        severityFlagNames.reduce<Record<string, object>>(
            (properties, name) => ({ ...properties, [name]: flagSchema }),
            {}
        )
    ),
    rootCause: objectSchema({
        summary: stringSchema,
        codeLocation: {
            anyOf: [
                objectSchema({ file: stringSchema, line: { type: "integer" } }),
                { type: "null" }
            ]
        },
        reproducible: { type: "boolean" }
    }),
    proposedFix: objectSchema({
        type: { type: "string", enum: ["none", ...allowedFixTypes] },
        files: { type: "array", items: stringSchema },
        reversible: { type: "boolean" }
    })
});

// 모델이 반환한 JSON 문자열을 파싱하고 스키마와 일치하는지 확인
export function parseRiskAnalysis(text: string): RiskAnalysis {
    let value: unknown;
    try {
        value = JSON.parse(text);
    } catch {
        throw new Error("분석 결과가 JSON 형식이 아닙니다.");
    }
    if (!isRiskAnalysis(value)) {
        throw new Error("분석 결과가 스키마와 일치하지 않습니다.");
    }
    return value;
}

// 값이 키를 가진 객체인지 확인
function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

// 값이 문자열 배열인지 확인
function isStringArray(value: unknown): value is string[] {
    return Array.isArray(value) && value.every((item) => typeof item === "string");
}

// 값이 분석 결과 스키마와 일치하는지 확인
function isRiskAnalysis(value: unknown): value is RiskAnalysis {
    return (
        isRecord(value)
        && isClassification(value.classification)
        && Array.isArray(value.evidence)
        && value.evidence.every(isEvidence)
        && isSeverity(value.severity)
        && isRootCause(value.rootCause)
        && isProposedFix(value.proposedFix)
    );
}

// 값이 오류 분류 스키마와 일치하는지 확인
function isClassification(value: unknown): value is Classification {
    return (
        isRecord(value)
        && classificationLayers.includes(value.layer as Classification["layer"])
        && typeof value.cause === "string"
        && (value.httpStatus === null || typeof value.httpStatus === "number")
    );
}

// 값이 근거 스키마와 일치하는지 확인
function isEvidence(value: unknown): value is Evidence {
    return (
        isRecord(value)
        && typeof value.id === "string"
        && evidenceSources.includes(value.source as EvidenceSource)
        && typeof value.ref === "string"
        && typeof value.quote === "string"
    );
}

// 값이 심각도 플래그 묶음 스키마와 일치하는지 확인
function isSeverity(value: unknown): value is Record<SeverityFlagName, Flag> {
    return isRecord(value) && severityFlagNames.every((name) => isFlag(value[name]));
}

// 값이 판단 하나의 스키마와 일치하는지 확인
function isFlag(value: unknown): value is Flag {
    return (
        isRecord(value)
        && (typeof value.value === "boolean" || value.value === "unknown")
        && isStringArray(value.evidenceIds)
    );
}

// 값이 원인 스키마와 일치하는지 확인
function isRootCause(value: unknown): value is RootCause {
    return (
        isRecord(value)
        && typeof value.summary === "string"
        && (value.codeLocation === null || isCodeLocation(value.codeLocation))
        && typeof value.reproducible === "boolean"
    );
}

// 값이 코드 위치 스키마와 일치하는지 확인
function isCodeLocation(value: unknown): value is CodeLocation {
    return (
        isRecord(value)
        && typeof value.file === "string"
        && typeof value.line === "number"
    );
}

// 값이 수정 제안 스키마와 일치하는지 확인
function isProposedFix(value: unknown): value is ProposedFix {
    return (
        isRecord(value)
        && (value.type === "none" || (allowedFixTypes as readonly unknown[]).includes(value.type))
        && isStringArray(value.files)
        && typeof value.reversible === "boolean"
    );
}
