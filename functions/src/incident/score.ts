import type {
    ProposedFix,
    RiskEvidence,
    SeverityFlagName
} from "./schema";
import { allowedFixTypes } from "./schema";

// 현재 루브릭의 버전
export const rubricVersion = "v1";

// 축별 위험 수준(0 낮음 ~ 3 높음)
export type RiskLevel = 0 | 1 | 2 | 3;

// 위험도 계산에 사용하는 축 이름 목록. 확신도는 불확실성(uncertainty)으로 환산해 위험 방향을 통일
export const riskAxes = [
    "impact",
    "severity",
    "changeRisk",
    "uncertainty"
] as const;

// 위험도 계산에 사용하는 축 이름 하나
export type RiskAxis = typeof riskAxes[number];

// 영향도 계산에 쓰는 이슈 집계값
export type ImpactMetrics = {
    // 오류를 겪은 고유 사용자 수
    affectedUsers: number;
    // Crashlytics가 회귀로 표시한 이슈인지 여부
    isRegression: boolean;
};

// 이슈 하나의 위험도 계산 결과
export type RiskScore = {
    // 계산에 사용한 루브릭 버전
    rubricVersion: string;
    // 축별 위험 수준
    levels: Record<RiskAxis, RiskLevel>;
    // 충족한 확신 조건의 개수(0~3)
    confidence: number;
    // 영향도와 심각도 수준 중 높은 값인 알림 등급
    grade: RiskLevel;
    // 알림 등급을 결정한 축 목록. 등급이 0이면 빈 목록
    decidingAxes: RiskAxis[];
    // 자동 수정 대상으로 삼을 수 있는지 여부
    autoFixEligible: boolean;
};

// 고유 사용자 수가 도달할 때마다 영향도 수준이 오르는 기준값. 초기값이며 운영하며 조정
const impactUserThresholds = [5, 20, 100];

// 회귀로 표시된 이슈에 보장하는 최소 영향도 수준
const regressionMinimumImpactLevel: RiskLevel = 2;

// 보고된 오류가 최소한으로 갖는 심각도 수준. 오류가 났다면 기능 하나는 실패한 것으로 봄
const baselineSeverityLevel: RiskLevel = 1;

// 근거를 찾지 못한(unknown) 플래그가 부여할 수 있는 최대 수준. 상세 요약에 올라가 사람이 한 번 보게 하는 수준
const unknownFlagMaxLevel: RiskLevel = 2;

// 켜진 심각도 플래그가 부여하는 위험 수준
const severityFlagLevels: Record<SeverityFlagName, RiskLevel> = {
    fatal: 2,
    launchCrash: 3,
    blocksCoreFlow: 2,
    dataLossPossible: 3,
    securityArea: 3
};

// 수정 대상에 포함되면 변경 위험을 최고 수준으로 올리는 경로 접두어 목록
const sensitivePathPrefixes = [
    ".github/",
    "firebase.json",
    "firebase.test.json",
    "firestore.rules",
    "firestore.index.json",
    "functions/src/rest/oauth/",
    "functions/src/rest/authenticationConfiguration.ts",
    "functions/src/user/delete.ts",
    "nestjs-api/src/auth/",
    "nestjs-api/src/oauth/",
    "nestjs-api/src/apple/",
    "nestjs-api/src/github/",
    "nestjs-api/src/google/",
    "nestjs-api/src/firebase/"
];

// 알림 등급을 결정하는 축. 변경 위험과 불확실성은 자동 수정 가능 여부를 가르는 축이라 알림 등급에서 제외
const gradeAxes: RiskAxis[] = ["impact", "severity"];

// 자동 수정 대상이 되기 위해 각 축이 넘지 않아야 하는 최대 수준
const autoFixMaxLevels: Record<RiskAxis, RiskLevel> = {
    impact: 1,
    severity: 1,
    changeRisk: 1,
    uncertainty: 1
};

// 검증을 거친 분석 결과와 이슈 집계값으로 축별 수준, 알림 등급, 자동 수정 자격 계산
export function scoreRisk(
    riskEvidence: RiskEvidence,
    metrics: ImpactMetrics
): RiskScore {
    const confidence = countConfidence(riskEvidence);
    const levels: Record<RiskAxis, RiskLevel> = {
        impact: impactLevel(metrics),
        severity: severityLevel(riskEvidence),
        changeRisk: changeRiskLevel(riskEvidence.proposedFix),
        uncertainty: (3 - confidence) as RiskLevel
    };
    const grade = maxLevel(gradeAxes.map((axis) => levels[axis]));
    const decidingAxes = grade === 0
        ? []
        : gradeAxes.filter((axis) => levels[axis] === grade);
    const autoFixEligible = (
        isAllowedFixType(riskEvidence.proposedFix.type)
        && riskAxes.every((axis) => levels[axis] <= autoFixMaxLevels[axis])
    );

    return {
        rubricVersion,
        levels,
        confidence,
        grade,
        decidingAxes,
        autoFixEligible
    };
}

// 수준 목록의 최댓값 계산
function maxLevel(levels: RiskLevel[]): RiskLevel {
    return levels.reduce<RiskLevel>(
        (max, level) => (level > max ? level : max),
        0
    );
}

// 고유 사용자 수와 회귀 여부로 영향도 수준 계산
function impactLevel(metrics: ImpactMetrics): RiskLevel {
    const byUsers = impactUserThresholds.filter(
        (threshold) => metrics.affectedUsers >= threshold
    ).length as RiskLevel;
    return metrics.isRegression
        ? maxLevel([byUsers, regressionMinimumImpactLevel])
        : byUsers;
}

// 기본 수준과 켜진 플래그, 알 수 없는 플래그 중 가장 높은 수준으로 심각도 수준 계산
function severityLevel(riskEvidence: RiskEvidence): RiskLevel {
    const names = Object.keys(severityFlagLevels) as SeverityFlagName[];
    const flagLevels = names
        .filter((name) => riskEvidence.severity[name].value !== false)
        .map((name) => (
            riskEvidence.severity[name].value === true
                ? severityFlagLevels[name]
                : minLevel(severityFlagLevels[name], unknownFlagMaxLevel)
        ));
    return maxLevel([baselineSeverityLevel, ...flagLevels]);
}

// 두 수준 중 낮은 값 계산
function minLevel(
    left: RiskLevel,
    right: RiskLevel
): RiskLevel {
    return left < right ? left : right;
}

// 수정 대상 파일의 민감도, 개수, 되돌림 가능 여부로 변경 위험 수준 계산
function changeRiskLevel(proposedFix: ProposedFix): RiskLevel {
    const { files, reversible } = proposedFix;
    if (files.length === 0) { return 0; }
    if (!reversible || files.some(isSensitivePath)) { return 3; }
    if (files.length > 3) { return 2; }
    if (files.length > 1) { return 1; }
    return 0;
}

// 경로가 민감 경로 접두어에 해당하는지 확인
function isSensitivePath(path: string): boolean {
    return sensitivePathPrefixes.some((prefix) => path.startsWith(prefix));
}

// 코드 위치 매핑, 재현 가능 여부, 서버 로그 교차 확인 중 충족한 조건 개수 계산
function countConfidence(riskEvidence: RiskEvidence): number {
    const { evidence, rootCause } = riskEvidence;
    const isLocationMapped = (
        rootCause.codeLocation !== null
        && evidence.some((item) => item.source === "stack" || item.source === "code")
    );
    const isServerCrossChecked = evidence.some((item) => item.source === "serverLog");
    return [
        isLocationMapped,
        rootCause.reproducible,
        isServerCrossChecked
    ].filter(Boolean).length;
}

// 수정 유형이 자동 수정 허용 목록에 있는지 확인
function isAllowedFixType(type: string): boolean {
    return (allowedFixTypes as readonly string[]).includes(type);
}
