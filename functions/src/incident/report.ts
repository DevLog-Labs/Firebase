import { originLabel } from "./classify";
import type { OriginKind } from "./classify";
import type { ErrorGroup } from "./context";
import type { SummaryItem } from "./discord";
import {
    areaLabels,
    autoFixLabel,
    incidentLabel,
    triageLabel
} from "./github";
import type {
    IncidentIssueDraft,
    RepositoryName
} from "./github";
import type { RiskAxis } from "./score";

// 이슈 제목의 최대 글자 수
const maxTitleLength = 200;

// 축 이름별 표시 이름
const axisLabels: Record<RiskAxis, string> = {
    impact: "영향도",
    severity: "심각도",
    changeRisk: "변경 위험",
    uncertainty: "불확실성"
};

// 분류별 확인할 곳 안내
const checkpoints: Record<OriginKind, string[]> = {
    server: ["- 서버 코드와 `api-v2` 로그 확인"],
    ios: ["- 앱 코드와 요청 처리 확인"],
    shared: [
        "- 서버: 응답 스키마와 상태 코드 확인",
        "- iOS: 요청 내용과 모델 처리 확인",
        "- 작업이 iOS 저장소에서 진행되어야 하면 이슈를 `DevLog-Labs/iOS`로 이전"
    ]
};

// 고칠 위치 분류에 따라 이슈를 만들 저장소를 정함. 공동은 기본 저장소 하나에만 만듦
export function issueRepository(kind: OriginKind): RepositoryName {
    return kind === "ios" ? "iOS" : "Firebase";
}

// 이슈 그룹 하나의 분석 결과를 공개 저장소에 올려도 되는 최소 정보만 담은 이슈 초안으로 변환
export function buildIncidentIssue(
    group: ErrorGroup,
    item: SummaryItem,
    date: string
): IncidentIssueDraft {
    const markerKey = `${group.issueId}:${group.restStatusCode}`;
    const { riskEvidence, score, origin } = item;
    const { classification } = riskEvidence;
    const decidingAxes = score.decidingAxes.map((axis) => axisLabels[axis]).join(", ") || "-";
    const flags = Object.entries(riskEvidence.severity)
        .map(([name, flag]) => `- ${name}: ${String(flag.value)}`);

    const body = [
        `<!-- crashlytics:${markerKey} -->`,
        "## 목적",
        "",
        "Crashlytics에서 탐지한 오류의 원인을 조사하고 필요하면 수정",
        "",
        "## 배경",
        "",
        `- 탐지일: ${date}`,
        `- 알림 등급: ${score.grade} (결정 축: ${decidingAxes})`,
        `- 영향 사용자: ${group.affectedUsers}명`,
        `- 원인 위치: ${originLabel(origin.kind)}`,
        `- 위치 판단 근거: ${origin.reasons.join(", ")}`,
        `- 분류: ${classification.cause}${classification.httpStatus === null ? "" : ` / ${classification.httpStatus}`}`,
        `- 탐지 사유: ${detectionReasons(group)}`,
        `- Crashlytics: ${item.url}`,
        "",
        "## 분석 요약",
        "",
        riskEvidence.rootCause.summary,
        "",
        "## 심각도 판단",
        "",
        ...flags,
        "",
        "## 확인할 곳",
        "",
        ...checkpoints[origin.kind],
        "",
        "## 완료 조건",
        "",
        "- [ ] 원인 확인",
        "- [ ] 재발 방지 조치 또는 종료 사유 기록"
    ].join("\n");

    return {
        markerKey,
        repository: issueRepository(origin.kind),
        title: truncate(`${item.title} 오류를 조사한다`),
        body,
        labels: issueLabels(item),
        updateComment: [
            `### ${date} 갱신`,
            "",
            `- 알림 등급: ${score.grade} (결정 축: ${decidingAxes})`,
            `- 영향 사용자: ${group.affectedUsers}명`,
            `- 원인 위치: ${originLabel(origin.kind)}`,
            `- 탐지 사유: ${detectionReasons(group)}`,
            "",
            riskEvidence.rootCause.summary
        ].join("\n")
    };
}

// 이슈에 붙일 라벨 목록 생성. 공동 이슈는 담당 확인 라벨을 붙이고, 자동 수정 라벨은 수정 워크플로가 있는 서버 이슈에만 붙임
function issueLabels(item: SummaryItem): string[] {
    const { kind } = item.origin;
    return [
        incidentLabel,
        areaLabels[kind],
        ...(kind === "shared" ? [triageLabel] : []),
        ...(kind === "server" && item.score.autoFixEligible ? [autoFixLabel] : [])
    ];
}

// 이슈 그룹이 선별된 사유 목록을 문자열로 변환
function detectionReasons(group: ErrorGroup): string {
    const reasons = [
        group.isNew ? "신규" : "",
        group.isSurge ? "급증" : "",
        group.isRegression ? "회귀" : ""
    ].filter((reason) => reason !== "");
    return reasons.join(", ") || "-";
}

// 최대 길이를 넘는 제목을 말줄임표로 축약
function truncate(text: string): string {
    return text.length <= maxTitleLength
        ? text
        : `${text.slice(0, maxTitleLength - 1)}…`;
}
