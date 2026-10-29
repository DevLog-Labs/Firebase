import { originLabel } from "./classify";
import type { ErrorGroup } from "./context";
import type { SummaryItem } from "./discord";
import { autoFixLabel, incidentLabel } from "./github";
import type { IncidentIssueDraft } from "./github";
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

// 자동 수정 대상인 이슈 그룹 하나의 분석 결과를 공개 저장소에 올려도 되는 최소 정보만 담은 이슈 초안으로 변환
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
        "- 서버 코드와 `api-v2` 로그 확인",
        "",
        "## 완료 조건",
        "",
        "- [ ] 원인 확인",
        "- [ ] 재발 방지 조치 또는 종료 사유 기록"
    ].join("\n");

    return {
        markerKey,
        title: truncate(`${item.title} 오류를 조사한다`),
        body,
        labels: [incidentLabel, autoFixLabel],
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
