import axios from "axios";
import type { RiskEvidence } from "./schema";
import type {
    ImpactMetrics,
    RiskAxis,
    RiskScore
} from "./score";

// Discord 메시지 한 건에 담을 수 있는 embed 최대 개수
const maxEmbedsPerMessage = 10;

// Discord 메시지 한 건의 embed 전체 글자 수 상한
const maxEmbedCharactersPerMessage = 6000;

// embed 제목 최대 글자 수
const maxTitleLength = 256;

// embed 설명 최대 글자 수. Discord 상한보다 낮게 둔 값
const maxDescriptionLength = 1500;

// embed 필드 값 최대 글자 수
const maxFieldValueLength = 1024;

// 근거 인용문 한 줄의 최대 글자 수
const maxQuoteLength = 120;

// 요약에 근거로 보여 주는 최대 개수
const maxEvidenceLines = 3;

// 이슈별 embed로 자세히 보여 주는 최소 등급
const detailedGradeMinimum = 2;

// 이슈별 embed로 자세히 보여 주는 최대 개수. 나머지는 "그 외" 목록으로 넘겨 메시지 길이를 제한
const maxDetailedEmbeds = 5;

// 웹훅 요청을 시도하는 최대 횟수
const maxRequestAttempts = 3;

// 속도 제한 응답에서 기다리는 최대 시간(초)
const maxRetryAfterSeconds = 10;

// 등급별 embed 색상
const gradeColors = [0x95a5a6, 0xf1c40f, 0xe67e22, 0xc0392b];

// 축 이름별 표시 이름
const axisLabels: Record<RiskAxis, string> = {
    impact: "영향도",
    severity: "심각도",
    changeRisk: "변경 위험",
    uncertainty: "불확실성"
};

// 일일 요약에 올리는 이슈 하나
export type SummaryItem = {
    // Crashlytics 이슈 ID
    issueId: string;
    // Crashlytics 이슈 제목
    title: string;
    // Crashlytics 콘솔의 이슈 링크
    url: string;
    // 검증을 거친 분석 결과
    riskEvidence: RiskEvidence;
    // 위험도 계산 결과
    score: RiskScore;
    // 영향도 계산에 쓴 이슈 집계값
    metrics: ImpactMetrics;
};

// Discord embed 필드 하나
type DiscordEmbedField = {
    // 필드 이름
    name: string;
    // 필드 값
    value: string;
    // 다른 필드와 한 줄에 배치할지 여부
    inline: boolean;
};

// Discord embed 하나
export type DiscordEmbed = {
    // embed 제목
    title: string;
    // 제목에 연결할 링크
    url?: string;
    // embed 설명
    description: string;
    // 왼쪽 띠 색상
    color: number;
    // embed 필드 목록
    fields: DiscordEmbedField[];
    // embed 하단 문구
    footer: { text: string };
};

// Discord 웹훅으로 보내는 메시지 한 건
export type DiscordMessage = {
    // 메시지 본문. 첫 메시지에만 포함
    content?: string;
    // 메시지에 포함하는 embed 목록
    embeds: DiscordEmbed[];
    // 본문과 embed 안의 멘션을 모두 무효화하는 설정
    allowed_mentions: { parse: string[] };
};

// 이슈 목록을 등급 순으로 정렬해 Discord 일일 요약 메시지 목록으로 변환
export function buildDailySummary(
    items: SummaryItem[],
    dateLabel: string
): DiscordMessage[] {
    const sorted = [...items].sort((left, right) => (
        right.score.grade - left.score.grade
        || right.metrics.affectedUsers - left.metrics.affectedUsers
    ));
    const detailed = sorted
        .filter((item) => item.score.grade >= detailedGradeMinimum)
        .slice(0, maxDetailedEmbeds);
    const brief = sorted.filter((item) => !detailed.includes(item));

    const embeds = detailed.map(detailEmbed);
    if (brief.length > 0) {
        embeds.push(briefEmbed(brief));
    }

    return splitMessages(headerContent(dateLabel, sorted.length), embeds);
}

// 메시지 목록을 순서대로 웹훅에 전송
export async function sendDiscordMessages(
    webhookUrl: string,
    messages: DiscordMessage[]
): Promise<void> {
    for (const message of messages) {
        await postWithRetry(webhookUrl, message);
    }
}

// 요약 첫 메시지의 본문 생성
function headerContent(
    dateLabel: string,
    total: number
): string {
    return total === 0
        ? `${dateLabel} 오류 요약 · 신규·급증·회귀 이슈가 없습니다`
        : `${dateLabel} 오류 요약 · 신규·급증·회귀 ${total}건`;
}

// 등급이 높은 이슈 하나의 상세 embed 생성
function detailEmbed(item: SummaryItem): DiscordEmbed {
    const { riskEvidence, score, metrics } = item;
    const { classification } = riskEvidence;
    const classificationText = [
        classification.layer,
        classification.cause,
        classification.httpStatus === null ? "" : String(classification.httpStatus)
    ].filter((part) => part !== "").join(" · ");

    return {
        title: truncate(`등급 ${score.grade} · ${plainTitle(item.title)}`, maxTitleLength),
        url: item.url,
        description: truncate(riskEvidence.rootCause.summary, maxDescriptionLength),
        color: gradeColors[score.grade],
        fields: [
            {
                name: "영향 사용자",
                value: `${metrics.affectedUsers}명${metrics.isRegression ? " · 회귀" : ""}`,
                inline: true
            },
            {
                name: "결정 축",
                value: score.decidingAxes.map((axis) => axisLabels[axis]).join(", ") || "-",
                inline: true
            },
            {
                name: "자동 수정",
                value: score.autoFixEligible ? "가능" : "불가",
                inline: true
            },
            {
                name: "분류",
                value: truncate(classificationText || "-", maxFieldValueLength),
                inline: true
            },
            {
                name: "근거",
                value: truncate(evidenceLines(riskEvidence), maxFieldValueLength),
                inline: false
            }
        ],
        footer: { text: `issue ${item.issueId} · 루브릭 ${score.rubricVersion}` }
    };
}

// 등급이 낮은 이슈들을 한 줄씩 담은 embed 생성
function briefEmbed(items: SummaryItem[]): DiscordEmbed {
    const lines: string[] = [];
    let length = 0;
    for (const item of items) {
        const line = `• [${plainTitle(item.title)}](${item.url}) · 등급 ${item.score.grade} · ${item.metrics.affectedUsers}명`;
        if (length + line.length + 1 > maxDescriptionLength) {
            lines.push(`…외 ${items.length - lines.length}건`);
            break;
        }
        lines.push(line);
        length += line.length + 1;
    }

    return {
        title: `그 외 ${items.length}건`,
        description: lines.join("\n"),
        color: gradeColors[items[0].score.grade],
        fields: [],
        footer: { text: `루브릭 ${items[0].score.rubricVersion}` }
    };
}

// 검증된 근거를 최대 개수만큼 한 줄씩 정리
function evidenceLines(riskEvidence: RiskEvidence): string {
    const lines = riskEvidence.evidence.slice(0, maxEvidenceLines).map((evidence) => (
        `• ${evidence.source} ${evidence.ref}: ${truncate(singleLine(evidence.quote), maxQuoteLength)}`
    ));
    return lines.length > 0 ? lines.join("\n") : "검증된 근거 없음";
}

// 개수와 글자 수 상한에 맞춰 embed 목록을 메시지 여러 건으로 분할
function splitMessages(
    header: string,
    embeds: DiscordEmbed[]
): DiscordMessage[] {
    const groups: DiscordEmbed[][] = [];
    let current: DiscordEmbed[] = [];
    let size = 0;

    for (const embed of embeds) {
        const length = embedLength(embed);
        if (
            current.length > 0
            && (
                current.length === maxEmbedsPerMessage
                || size + length > maxEmbedCharactersPerMessage
            )
        ) {
            groups.push(current);
            current = [];
            size = 0;
        }
        current.push(embed);
        size += length;
    }
    if (current.length > 0 || groups.length === 0) {
        groups.push(current);
    }

    return groups.map((group, index) => ({
        ...(index === 0 ? { content: header } : {}),
        embeds: group,
        allowed_mentions: { parse: [] }
    }));
}

// Discord가 합산하는 embed 글자 수 계산
function embedLength(embed: DiscordEmbed): number {
    const fieldLength = embed.fields.reduce(
        (sum, field) => sum + field.name.length + field.value.length,
        0
    );
    return embed.title.length
        + embed.description.length
        + embed.footer.text.length
        + fieldLength;
}

// 링크 문법을 깨뜨리는 대괄호를 제거한 제목 생성
function plainTitle(title: string): string {
    return singleLine(title).replace(/[[\]]/g, "");
}

// 줄바꿈을 공백으로 바꾼 한 줄 문자열 생성
function singleLine(text: string): string {
    return text.replace(/\s+/g, " ").trim();
}

// 최대 길이를 넘는 문자열을 말줄임표로 축약
function truncate(
    text: string,
    maxLength: number
): string {
    return text.length <= maxLength
        ? text
        : `${text.slice(0, maxLength - 1)}…`;
}

// 속도 제한 응답이면 기다린 뒤 다시 시도하며 메시지 한 건을 전송
async function postWithRetry(
    webhookUrl: string,
    message: DiscordMessage
): Promise<void> {
    for (let attempt = 1; ; attempt++) {
        const { status, retryAfterSeconds } = await requestOnce(webhookUrl, message);
        if (status >= 200 && status < 300) { return; }
        if (status === 429 && attempt < maxRequestAttempts) {
            await delay(retryAfterSeconds * 1000);
            continue;
        }
        throw new Error(`Discord 웹훅 전송에 실패했습니다. status=${status}`);
    }
}

// 웹훅에 요청을 한 번 보내고 상태 코드와 대기 시간을 반환. 오류에 웹훅 주소가 섞이지 않도록 새 오류로 변환
async function requestOnce(
    webhookUrl: string,
    message: DiscordMessage
): Promise<{ status: number; retryAfterSeconds: number }> {
    try {
        const response = await axios.request({
            method: "post",
            url: webhookUrl,
            data: message,
            headers: { "Content-Type": "application/json" },
            validateStatus: () => true
        });
        return {
            status: response.status,
            retryAfterSeconds: parseRetryAfter(response.data)
        };
    } catch {
        throw new Error("Discord 웹훅 요청을 보내지 못했습니다.");
    }
}

// 속도 제한 응답 본문의 대기 시간(초)을 읽고 상한 적용
function parseRetryAfter(data: unknown): number {
    const value = (data as { retry_after?: unknown } | null)?.retry_after;
    return typeof value === "number"
        ? Math.min(value, maxRetryAfterSeconds)
        : 1;
}

// 지정한 시간(밀리초)만큼 대기
function delay(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
