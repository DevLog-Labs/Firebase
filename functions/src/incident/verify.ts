import type {
    Evidence,
    EvidenceSource,
    Flag,
    RiskEvidence,
    SeverityFlagName
} from "./schema";
import { severityFlagNames } from "./schema";

// 출처별 원문을 위치(ref) 기준으로 모아 둔 검증용 원본
export type EvidenceSources = Record<EvidenceSource, Map<string, string>>;

// 검증을 거친 분석 결과와 걸러진 근거 id
export type VerificationResult = {
    // 근거와 심각도 플래그를 검증 결과로 교체한 분석 결과
    riskEvidence: RiskEvidence;
    // 검증에 실패해 제외한 근거 id 목록
    rejectedEvidenceIds: string[];
};

// 근거의 위치와 인용문을 원본과 대조하고 검증에 실패한 판단을 unknown으로 되돌림
export function verifyRiskEvidence(
    riskEvidence: RiskEvidence,
    sources: EvidenceSources
): VerificationResult {
    const idCounts = countEvidenceIds(riskEvidence.evidence);
    const verified = riskEvidence.evidence.filter((evidence) => (
        idCounts.get(evidence.id) === 1
        && isQuoteInSource(evidence, sources)
    ));
    const verifiedIds = new Set(verified.map((evidence) => evidence.id));

    const severity = {} as Record<SeverityFlagName, Flag>;
    for (const name of severityFlagNames) {
        severity[name] = verifyFlag(riskEvidence.severity[name], verifiedIds);
    }

    const rejectedEvidenceIds = Array.from(new Set(
        riskEvidence.evidence
            .map((evidence) => evidence.id)
            .filter((id) => !verifiedIds.has(id))
    ));

    return {
        riskEvidence: { ...riskEvidence, evidence: verified, severity },
        rejectedEvidenceIds
    };
}

// 근거 id별 등장 횟수 집계
function countEvidenceIds(evidence: Evidence[]): Map<string, number> {
    const counts = new Map<string, number>();
    for (const { id } of evidence) {
        counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return counts;
}

// 근거의 위치가 원본에 존재하고 인용문이 원본에 그대로 들어 있는지 확인
function isQuoteInSource(
    evidence: Evidence,
    sources: EvidenceSources
): boolean {
    const original = sources[evidence.source].get(evidence.ref);
    return original !== undefined
        && evidence.quote !== ""
        && original.includes(evidence.quote);
}

// 인용한 근거가 모두 검증된 판단만 유지하고 나머지는 unknown으로 변경
function verifyFlag(
    flag: Flag,
    verifiedIds: Set<string>
): Flag {
    const evidenceIds = flag.evidenceIds.filter((id) => verifiedIds.has(id));
    const isCited = (
        flag.evidenceIds.length > 0
        && evidenceIds.length === flag.evidenceIds.length
    );
    return { value: isCited ? flag.value : "unknown", evidenceIds };
}
