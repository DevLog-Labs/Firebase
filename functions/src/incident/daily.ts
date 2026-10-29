import * as logger from "firebase-functions/logger";
import { defineSecret } from "firebase-functions/params";
import { onSchedule } from "firebase-functions/v2/scheduler";
import { toError } from "../common/error";
import { analyzeIssue } from "./analyze";
import {
    buildAnalysisContext,
    groupTitle,
    issueUrl,
    selectErrorGroups,
    toImpactMetrics,
    yesterdayInSeoul
} from "./context";
import type { ErrorGroup } from "./context";
import {
    buildDailySummary,
    sendDiscordMessages
} from "./discord";
import type { SummaryItem } from "./discord";
import type { RiskEvidence } from "./schema";
import { scoreRisk } from "./score";
import { verifyRiskEvidence } from "./verify";

const LOCATION = "asia-northeast3";

// 분석 요청에 쓰는 OpenAI API 키
const openAiApiKeySecret = defineSecret("OPENAI_API_KEY");

// 일일 요약을 보내는 Discord 웹훅 주소
const discordWebhookUrlSecret = defineSecret("DISCORD_WEBHOOK_URL");

// 어제 신규, 급증, 회귀 이슈를 분석해 Discord 일일 요약으로 전송
export const sendDailyIncidentReport = onSchedule({
        maxInstances: 1,
        region: LOCATION,
        schedule: "0 9 * * *",
        timeZone: "Asia/Seoul",
        timeoutSeconds: 540,
        secrets: [openAiApiKeySecret, discordWebhookUrlSecret]
    },
    async () => {
        const webhookUrl = discordWebhookUrlSecret.value();

        try {
            const date = yesterdayInSeoul(new Date());
            const items = await analyzeGroups(date);
            await sendDiscordMessages(webhookUrl, buildDailySummary(items, date));
        } catch (error) {
            logger.error("일일 오류 요약 생성 실패", toError(error));
            await notifyFailure(webhookUrl);
        }
    }
);

// 대상 날짜의 이슈 그룹을 선별해 하나씩 순서대로 분석
async function analyzeGroups(date: string): Promise<SummaryItem[]> {
    const groups = await selectErrorGroups(date);
    const items: SummaryItem[] = [];
    for (const group of groups) {
        items.push(await analyzeGroup(group, date));
    }
    return items;
}

// 이슈 그룹 하나를 분석하고 근거 검증과 위험도 계산을 거쳐 요약 항목으로 변환. 분석에 실패하면 판단 불가 항목으로 대체
async function analyzeGroup(
    group: ErrorGroup,
    date: string
): Promise<SummaryItem> {
    const metrics = toImpactMetrics(group);
    const summary = {
        issueId: group.issueId,
        title: groupTitle(group),
        url: issueUrl(process.env.GCLOUD_PROJECT ?? "", group.issueId),
        metrics
    };

    try {
        const context = await buildAnalysisContext(group, date);
        const { riskEvidence, sources } = await analyzeIssue(
            openAiApiKeySecret.value(),
            context
        );
        const { riskEvidence: checked, rejectedEvidenceIds } = verifyRiskEvidence(
            riskEvidence,
            sources
        );
        const verified = applyKnownFlags(checked, group.isFatal);
        const score = scoreRisk(verified, metrics);

        logger.info("이슈 분석 완료", {
            issueId: group.issueId,
            restStatusCode: group.restStatusCode,
            affectedUsers: group.affectedUsers,
            rubricVersion: score.rubricVersion,
            levels: score.levels,
            grade: score.grade,
            decidingAxes: score.decidingAxes,
            autoFixEligible: score.autoFixEligible,
            rejectedEvidenceIds
        });
        return { ...summary, riskEvidence: verified, score };
    } catch (error) {
        logger.error("이슈 분석 실패", toError(error), { issueId: group.issueId });
        const riskEvidence = unanalyzedEvidence(group.issueId);
        return { ...summary, riskEvidence, score: scoreRisk(riskEvidence, metrics) };
    }
}

// 데이터로 확정되는 플래그를 모델의 판단 위에 덮어씀. fatal은 크래시 여부 그대로이고, 크래시가 아니면 launchCrash는 false
function applyKnownFlags(
    riskEvidence: RiskEvidence,
    isFatal: boolean
): RiskEvidence {
    const { severity } = riskEvidence;
    return {
        ...riskEvidence,
        severity: {
            ...severity,
            fatal: { value: isFatal, evidenceIds: [] },
            launchCrash: isFatal ? severity.launchCrash : { value: false, evidenceIds: [] }
        }
    };
}

// 분석하지 못한 이슈를 모든 판단이 unknown이고 근거가 없는 결과로 표현. 심각도가 최대 수준 2가 되어 상세 요약에 올라감
function unanalyzedEvidence(issueId: string): RiskEvidence {
    const unknownFlag = { value: "unknown" as const, evidenceIds: [] };
    return {
        issueId,
        rubricVersion: "unanalyzed",
        classification: { layer: "unknown", cause: "unanalyzed", httpStatus: null },
        evidence: [],
        severity: {
            fatal: unknownFlag,
            launchCrash: unknownFlag,
            blocksCoreFlow: unknownFlag,
            dataLossPossible: unknownFlag,
            securityArea: unknownFlag
        },
        rootCause: {
            summary: "자동 분석에 실패했습니다. Crashlytics에서 직접 확인해 주세요.",
            codeLocation: null,
            reproducible: false
        },
        proposedFix: { type: "none", files: [], reversible: false }
    };
}

// 요약 생성에 실패했음을 Discord로 알리고 전송까지 실패하면 로그만 남김
async function notifyFailure(webhookUrl: string): Promise<void> {
    try {
        await sendDiscordMessages(webhookUrl, [{
            content: "일일 오류 요약을 만들지 못했습니다. Cloud Functions 로그를 확인해 주세요.",
            embeds: [],
            allowed_mentions: { parse: [] }
        }]);
    } catch (error) {
        logger.error("일일 오류 요약 실패 알림 전송 실패", toError(error));
    }
}
