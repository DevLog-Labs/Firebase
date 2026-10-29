import { BigQuery } from "@google-cloud/bigquery";
import { Logging } from "@google-cloud/logging";
import * as logger from "firebase-functions/logger";
import { getZonedParts } from "../common/date";
import { toError } from "../common/error";
import { classifyOrigin } from "./classify";
import type { Origin } from "./classify";
import type { CodeReader } from "./code";
import type {
    AnalysisContext,
    SourceText
} from "./analyze";
import type { ImpactMetrics } from "./score";

// Crashlytics 스트리밍 export 테이블의 전체 이름(데이터셋.테이블)
const crashlyticsTable = "firebase_crashlytics.opfic_DevLog_IOS_REALTIME";

// Crashlytics 콘솔 링크에 쓰는 iOS 앱 식별자
const crashlyticsAppId = "ios:opfic.DevLog";

// 서버 로그를 조회할 Cloud Run 서비스 이름
const serverLogServiceName = "api-v2";

// 날짜 경계를 정하는 타임존
const reportTimeZone = "Asia/Seoul";

// 한국 표준시의 UTC 오프셋 표기. 서머타임이 없어 고정값
const reportUtcOffset = "+09:00";

// 신규, 급증, 회귀 판정에 쓰는 이력 조회 기간(일). 스트리밍 테이블의 보관 기간과 같음
const lookbackDays = 30;

// 이 일수 이상 발생이 없다가 다시 나타나면 회귀로 보는 기준. 초기값이며 운영하며 조정
const regressionGapDays = 3;

// 최근 7일 일평균의 몇 배 이상이면 급증으로 보는 기준. 초기값이며 운영하며 조정
const surgeFactor = 3;

// 급증으로 보려면 필요한 하루 최소 발생 건수. 초기값이며 운영하며 조정
const surgeMinEvents = 5;

// 하루에 분석하는 이슈 그룹 최대 개수. 초기값이며 운영하며 조정
const maxGroups = 10;

// 이슈 그룹마다 원문으로 가져오는 대표 이벤트 최대 개수
const sampleEventLimit = 3;

// 스택트레이스에서 사용하는 최대 프레임 수
const maxStackFrames = 15;

// 서버 로그로 가져오는 최대 항목 수
const maxServerLogs = 8;

// 서버 에러 로그 메시지의 최대 글자 수
const maxServerLogMessageLength = 500;

// 발생 분포로 보여 주는 앱 버전과 OS 조합의 최대 개수
const maxDistributionRows = 5;

// 대표 이벤트 시각 앞뒤로 서버 로그를 찾는 범위(밀리초)
const serverLogWindowMilliseconds = 2 * 60 * 1000;

// 선별 조건에 해당하는 이슈 그룹을 조회하는 쿼리
const selectGroupsQuery = `
WITH events AS (
    SELECT
        issue_id,
        issue_subtitle,
        is_fatal,
        event_timestamp,
        installation_uuid,
        IFNULL((SELECT value FROM UNNEST(custom_keys) WHERE key = "restStatusCode"), "") AS status
    FROM \`${crashlyticsTable}\`
    WHERE event_timestamp >= TIMESTAMP_SUB(@dayStart, INTERVAL @lookbackDays DAY)
        AND event_timestamp < @dayEnd
),
stats AS (
    SELECT
        issue_id AS issueId,
        status AS restStatusCode,
        ANY_VALUE(issue_subtitle) AS issueSubtitle,
        LOGICAL_OR(is_fatal) AS isFatal,
        COUNT(DISTINCT IF(event_timestamp >= @dayStart, installation_uuid, NULL)) AS affectedUsers,
        COUNTIF(event_timestamp >= @dayStart) AS eventsDay,
        COUNTIF(
            event_timestamp >= TIMESTAMP_SUB(@dayStart, INTERVAL 7 DAY)
            AND event_timestamp < @dayStart
        ) / 7 AS eventsPrevDailyAverage,
        MIN(event_timestamp) >= @dayStart AS isNew,
        IFNULL(
            MAX(IF(event_timestamp < @dayStart, event_timestamp, NULL))
                < TIMESTAMP_SUB(@dayStart, INTERVAL @regressionGapDays DAY),
            FALSE
        ) AS isRegression
    FROM events
    GROUP BY issue_id, status
    HAVING eventsDay > 0
),
flagged AS (
    SELECT
        *,
        (
            NOT isNew
            AND eventsDay >= @surgeMinEvents
            AND eventsDay >= @surgeFactor * eventsPrevDailyAverage
        ) AS isSurge
    FROM stats
)
SELECT issueId, restStatusCode, issueSubtitle, isFatal, affectedUsers, isNew, isRegression, isSurge
FROM flagged
WHERE isNew OR isRegression OR isSurge
ORDER BY affectedUsers DESC, eventsDay DESC
LIMIT @maxGroups
`;

// 이슈 그룹의 대표 이벤트와 스택, 사용자 정보를 조회하는 쿼리
const selectSamplesQuery = `
SELECT
    event_id AS eventId,
    event_timestamp AS eventTimestamp,
    application.display_version AS appVersion,
    application.build_version AS appBuild,
    operating_system.display_version AS osVersion,
    device.model AS deviceModel,
    TO_JSON_STRING(custom_keys) AS customKeys,
    TO_JSON_STRING(ARRAY(SELECT AS STRUCT b.name, b.params FROM UNNEST(breadcrumbs) b)) AS breadcrumbs,
    TO_JSON_STRING(ARRAY(
        SELECT AS STRUCT f.file, f.line, f.symbol, f.library, f.owner
        FROM UNNEST(errors[SAFE_OFFSET(0)].frames) f
    )) AS errorFrames,
    TO_JSON_STRING(ARRAY(
        SELECT AS STRUCT f.file, f.line, f.symbol, f.library, f.owner
        FROM UNNEST(exceptions[SAFE_OFFSET(0)].frames) f
    )) AS exceptionFrames,
    TO_JSON_STRING(ARRAY(
        SELECT AS STRUCT f.file, f.line, f.symbol, f.library, f.owner
        FROM UNNEST((SELECT t.frames FROM UNNEST(threads) t WHERE t.crashed LIMIT 1)) f
    )) AS crashFrames
FROM \`${crashlyticsTable}\`
WHERE event_timestamp >= @dayStart
    AND event_timestamp < @dayEnd
    AND issue_id = @issueId
    AND IFNULL((SELECT value FROM UNNEST(custom_keys) WHERE key = "restStatusCode"), "") = @status
ORDER BY event_timestamp DESC
LIMIT @sampleLimit
`;

// 이슈 그룹의 앱 버전과 OS 버전별 발생 분포를 조회하는 쿼리
const selectDistributionQuery = `
SELECT
    application.display_version AS appVersion,
    operating_system.display_version AS osVersion,
    COUNT(*) AS events,
    COUNT(DISTINCT installation_uuid) AS installs
FROM \`${crashlyticsTable}\`
WHERE event_timestamp >= @dayStart
    AND event_timestamp < @dayEnd
    AND issue_id = @issueId
    AND IFNULL((SELECT value FROM UNNEST(custom_keys) WHERE key = "restStatusCode"), "") = @status
GROUP BY appVersion, osVersion
ORDER BY events DESC
LIMIT @rowLimit
`;

// 일일 요약 대상으로 선별한 이슈 그룹 하나
export type ErrorGroup = {
    // Crashlytics 이슈 ID
    issueId: string;
    // 오류에 기록된 HTTP 상태 코드. REST 오류가 아니면 빈 문자열
    restStatusCode: string;
    // Crashlytics 이슈 부제. 오류 도메인과 코드를 담음
    issueSubtitle: string;
    // 앱이 종료된 크래시 이슈인지 여부
    isFatal: boolean;
    // 대상 날짜에 오류를 겪은 고유 설치 수
    affectedUsers: number;
    // 대상 날짜에 처음 발생했는지 여부
    isNew: boolean;
    // 오랜 공백 뒤에 다시 나타났는지 여부
    isRegression: boolean;
    // 최근 일평균보다 크게 늘었는지 여부
    isSurge: boolean;
};

// 조회한 대표 이벤트 하나
type SampleEvent = {
    // 이벤트 ID
    eventId: string;
    // 이벤트 발생 시각
    eventTimestamp: string;
    // 앱 표시 버전
    appVersion: string;
    // 앱 빌드 번호
    appBuild: string;
    // OS 버전
    osVersion: string;
    // 기기 모델
    deviceModel: string;
    // custom key 목록을 직렬화한 JSON 문자열
    customKeys: string;
    // breadcrumb 이름과 파라미터 목록을 직렬화한 JSON 문자열
    breadcrumbs: string;
    // 비치명 오류의 스택 프레임을 직렬화한 JSON 문자열
    errorFrames: string;
    // 예외의 스택 프레임을 직렬화한 JSON 문자열
    exceptionFrames: string;
    // 크래시 스레드의 스택 프레임을 직렬화한 JSON 문자열
    crashFrames: string;
};

// 스택 프레임 하나
type StackFrame = {
    // 소스 파일 이름
    file: string | null;
    // 소스 라인 번호
    line: number | null;
    // 함수 심볼
    symbol: string | null;
    // 프레임이 속한 라이브러리 이름
    library: string | null;
    // 프레임 소유 구분. 앱 개발자 코드는 DEVELOPER
    owner: string | null;
};

// breadcrumb 하나
type Breadcrumb = {
    // breadcrumb 이름
    name: string;
    // breadcrumb 파라미터 목록
    params: { key: string; value: string }[] | null;
};

// 서버 로그 항목에서 사용하는 메타데이터
type ServerLogMetadata = {
    // 로그 항목 고유 ID
    insertId?: string;
    // 로그 심각도
    severity?: string;
    // HTTP 요청 정보
    httpRequest?: {
        // 요청 메서드
        requestMethod?: string;
        // 요청 URL
        requestUrl?: string;
        // 응답 상태 코드
        status?: number;
        // 처리 시간
        latency?: unknown;
    };
};

// 지정한 날짜(YYYY-MM-DD)의 직전 날짜를 한국 시간 기준으로 계산
export function yesterdayInSeoul(now: Date): string {
    const { year, month, day } = getZonedParts(now, reportTimeZone);
    const previous = new Date(Date.UTC(year, month - 1, day - 1));
    return previous.toISOString().slice(0, 10);
}

// 신규, 급증, 회귀 중 하나에 해당하는 이슈 그룹을 영향 사용자 수 순으로 조회
export async function selectErrorGroups(date: string): Promise<ErrorGroup[]> {
    const { dayStart, dayEnd } = dayWindow(date);
    const [rows] = await new BigQuery().query({
        query: selectGroupsQuery,
        params: {
            dayStart,
            dayEnd,
            lookbackDays,
            regressionGapDays,
            surgeFactor,
            surgeMinEvents,
            maxGroups
        }
    });
    return (rows as ErrorGroup[]).map((row) => ({
        issueId: row.issueId,
        restStatusCode: row.restStatusCode,
        issueSubtitle: row.issueSubtitle,
        isFatal: Boolean(row.isFatal),
        affectedUsers: Number(row.affectedUsers),
        isNew: row.isNew,
        isRegression: row.isRegression,
        isSurge: row.isSurge
    }));
}

// 이슈 그룹의 영향도 계산 입력 생성
export function toImpactMetrics(group: ErrorGroup): ImpactMetrics {
    return {
        affectedUsers: group.affectedUsers,
        isRegression: group.isRegression
    };
}

// 이슈 그룹을 Discord 요약에 보여 줄 제목 생성
export function groupTitle(group: ErrorGroup): string {
    return group.restStatusCode === ""
        ? group.issueSubtitle
        : `${group.issueSubtitle} · ${group.restStatusCode}`;
}

// Crashlytics 콘솔의 이슈 링크 생성
export function issueUrl(
    projectId: string,
    issueId: string
): string {
    return `https://console.firebase.google.com/project/${projectId}/crashlytics/app/${crashlyticsAppId}/issues/${issueId}`;
}

// 이슈 그룹의 대표 이벤트, 스택, 서버 로그를 모아 분석 입력 생성
export async function buildAnalysisContext(
    group: ErrorGroup,
    date: string,
    codeReader?: CodeReader
): Promise<AnalysisContext> {
    const samples = await selectSamples(group, date);
    const serverLogs = await serverLogResult(group, samples);
    const latest = samples[0];
    const origin = classifyOrigin({
        restStatusCode: group.restStatusCode,
        isFatal: group.isFatal,
        customKeys: latest === undefined
            ? []
            : JSON.parse(latest.customKeys) as { key: string; value: string }[],
        hasDeveloperFrame: latestFrames(samples).some((frame) => frame.owner === "DEVELOPER"),
        serverLogs: {
            queried: serverLogs.queried,
            requestMatches: serverLogs.requestMatches,
            errorLogs: serverLogs.errorLogs
        }
    });

    return {
        issueId: group.issueId,
        title: groupTitle(group),
        isFatal: group.isFatal,
        origin,
        sources: {
            stack: stackSources(samples),
            serverLog: serverLogs.sources,
            code: codeReader === undefined
                ? []
                : await codeSources(codeReader, origin, samples, serverLogs),
            event: [
                ...samples.map(eventSource),
                ...await distributionSources(group, date)
            ]
        }
    };
}

// 고칠 위치에 맞춰 앱 스택 프레임의 코드와 서버 요청 경로의 코드를 읽어 코드 원문으로 변환
async function codeSources(
    codeReader: CodeReader,
    origin: Origin,
    samples: SampleEvent[],
    serverLogs: ServerLogResult
): Promise<SourceText[]> {
    const appFrames = latestFrames(samples)
        .filter((frame) => frame.owner === "DEVELOPER" && frame.file !== null && frame.line !== null)
        .map((frame) => ({ file: frame.file as string, line: frame.line as number }));
    const requestPath = serverLogs.requestPaths[0];

    return [
        ...(origin.kind === "server" ? [] : await codeReader.readAppFrames(appFrames)),
        ...(origin.kind === "ios" || requestPath === undefined
            ? []
            : await codeReader.readServerRoute(requestPath))
    ];
}

// 날짜(YYYY-MM-DD)를 한국 시간 하루 구간의 시작과 끝 시각으로 변환
function dayWindow(date: string): { dayStart: Date; dayEnd: Date } {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        throw new Error(`날짜 형식이 올바르지 않습니다: ${date}`);
    }
    const dayStart = new Date(`${date}T00:00:00${reportUtcOffset}`);
    return { dayStart, dayEnd: new Date(dayStart.getTime() + 24 * 60 * 60 * 1000) };
}

// 이슈 그룹의 최근 대표 이벤트 조회
async function selectSamples(
    group: ErrorGroup,
    date: string
): Promise<SampleEvent[]> {
    const { dayStart, dayEnd } = dayWindow(date);
    const [rows] = await new BigQuery().query({
        query: selectSamplesQuery,
        params: {
            dayStart,
            dayEnd,
            issueId: group.issueId,
            status: group.restStatusCode,
            sampleLimit: sampleEventLimit
        }
    });
    return (rows as Record<string, unknown>[]).map((row) => ({
        eventId: String(row.eventId),
        eventTimestamp: timestampText(row.eventTimestamp),
        appVersion: String(row.appVersion ?? ""),
        appBuild: String(row.appBuild ?? ""),
        osVersion: String(row.osVersion ?? ""),
        deviceModel: String(row.deviceModel ?? ""),
        customKeys: String(row.customKeys ?? "[]"),
        breadcrumbs: String(row.breadcrumbs ?? "[]"),
        errorFrames: String(row.errorFrames ?? "[]"),
        exceptionFrames: String(row.exceptionFrames ?? "[]"),
        crashFrames: String(row.crashFrames ?? "[]")
    }));
}

// 앱 버전과 OS 버전별 발생 분포를 한 건의 원문으로 변환. 발생이 없으면 빈 목록
async function distributionSources(
    group: ErrorGroup,
    date: string
): Promise<SourceText[]> {
    const { dayStart, dayEnd } = dayWindow(date);
    const [rows] = await new BigQuery().query({
        query: selectDistributionQuery,
        params: {
            dayStart,
            dayEnd,
            issueId: group.issueId,
            status: group.restStatusCode,
            rowLimit: maxDistributionRows
        }
    });
    const lines = (rows as Record<string, unknown>[]).map((row) => (
        `app=${String(row.appVersion ?? "?")} os=${String(row.osVersion ?? "?")} events=${Number(row.events)} installs=${Number(row.installs)}`
    ));
    return lines.length === 0
        ? []
        : [{ ref: "distribution", text: ["발생 분포", ...lines].join("\n") }];
}

// breadcrumb 하나를 이름과 파라미터를 담은 문자열로 변환
function breadcrumbText(breadcrumb: Breadcrumb): string {
    const params = (breadcrumb.params ?? []).map(({ key, value }) => `${key}=${value}`);
    return params.length === 0
        ? breadcrumb.name
        : `${breadcrumb.name}(${params.join(" ")})`;
}

// BigQuery 타임스탬프 값을 ISO 문자열로 변환
function timestampText(value: unknown): string {
    const raw = (value as { value?: string } | null)?.value ?? value;
    return new Date(String(raw)).toISOString();
}

// 가장 최근 대표 이벤트의 스택 프레임 목록. 비치명 오류, 예외, 크래시 스레드 순으로 비어 있지 않은 첫 목록
function latestFrames(samples: SampleEvent[]): StackFrame[] {
    const latest = samples[0];
    if (latest === undefined) { return []; }

    return [latest.errorFrames, latest.exceptionFrames, latest.crashFrames]
        .map((json) => JSON.parse(json) as StackFrame[])
        .find((candidate) => candidate.length > 0) ?? [];
}

// 가장 최근 대표 이벤트의 스택 프레임을 프레임 하나당 원문 한 건으로 변환
function stackSources(samples: SampleEvent[]): SourceText[] {
    return latestFrames(samples)
        .filter((frame) => frame.file !== null || frame.symbol !== null)
        .slice(0, maxStackFrames)
        .map((frame, index) => ({
            ref: `frame-${index}`,
            text: `${frame.symbol ?? "?"} (${frame.file ?? "?"}:${frame.line ?? "?"}) [${frame.library ?? "?"}]`
        }));
}

// 대표 이벤트 하나를 시각, 환경, custom key, breadcrumb을 담은 원문 한 건으로 변환
function eventSource(sample: SampleEvent): SourceText {
    const customKeys = (JSON.parse(sample.customKeys) as { key: string; value: string }[])
        .map(({ key, value }) => `${key}=${value}`);
    const breadcrumbs = (JSON.parse(sample.breadcrumbs) as Breadcrumb[])
        .map(breadcrumbText)
        .join(", ");

    return {
        ref: `event-${sample.eventId}`,
        text: [
            `time=${sample.eventTimestamp} app=${sample.appVersion}(${sample.appBuild}) os=${sample.osVersion} model=${sample.deviceModel}`,
            ...customKeys,
            `breadcrumbs=${breadcrumbs}`
        ].join("\n")
    };
}

// 서버 로그 조회 결과. 원문과 원인 위치 판정에 쓰는 개수를 함께 담음
type ServerLogResult = {
    // 분석 입력으로 쓰는 서버 로그 원문 목록
    sources: SourceText[];
    // 서버 로그를 조회했고 성공했는지 여부
    queried: boolean;
    // 같은 상태 코드의 요청 로그 개수
    requestMatches: number;
    // 요청 로그가 아닌 에러 심각도 로그 개수
    errorLogs: number;
    // 같은 상태 코드 요청 로그의 요청 경로 목록. 서버 코드를 찾는 데 사용
    requestPaths: string[];
};

// REST 오류일 때 가장 최근 이벤트 시각 전후의 서버 로그 중 상태 코드가 같은 요청 로그와 에러 심각도 로그를 원문과 개수로 변환
async function serverLogResult(
    group: ErrorGroup,
    samples: SampleEvent[]
): Promise<ServerLogResult> {
    const latest = samples[0];
    const none: ServerLogResult = { sources: [], queried: false, requestMatches: 0, errorLogs: 0, requestPaths: [] };
    if (group.restStatusCode === "" || latest === undefined) { return none; }

    const center = new Date(latest.eventTimestamp).getTime();
    const from = new Date(center - serverLogWindowMilliseconds).toISOString();
    const to = new Date(center + serverLogWindowMilliseconds).toISOString();
    const filter = [
        'resource.type="cloud_run_revision"',
        `resource.labels.service_name="${serverLogServiceName}"`,
        `(httpRequest.status=${Number(group.restStatusCode)} OR severity>=ERROR)`,
        `timestamp>="${from}"`,
        `timestamp<="${to}"`
    ].join(" AND ");

    try {
        const [entries] = await new Logging().getEntries({
            filter,
            orderBy: "timestamp desc",
            pageSize: maxServerLogs
        });
        const found = entries.slice(0, maxServerLogs);
        const metadata = found.map((entry) => entry.metadata as ServerLogMetadata);
        return {
            sources: found.map((entry, index) => serverLogSource(metadata[index], entry.data)),
            queried: true,
            requestMatches: metadata.filter(
                (item) => item.httpRequest?.status === Number(group.restStatusCode)
            ).length,
            errorLogs: metadata.filter((item) => item.httpRequest === undefined).length,
            requestPaths: metadata
                .filter((item) => item.httpRequest?.status === Number(group.restStatusCode))
                .map((item) => pathOf(item.httpRequest?.requestUrl))
                .filter((path) => path !== "?")
        };
    } catch (error) {
        logger.warn("서버 로그 조회에 실패해 서버 로그 없이 분석합니다.", {
            issueId: group.issueId,
            error: toError(error).message
        });
        return none;
    }
}

// 요청 로그는 메서드, 경로, 상태, 처리 시간만 남기고 앱 로그는 심각도와 메시지를 남긴 원문 한 건으로 변환
function serverLogSource(
    metadata: ServerLogMetadata,
    data: unknown
): SourceText {
    const ref = `log-${metadata.insertId ?? "unknown"}`;
    const request = metadata.httpRequest;
    if (request === undefined) {
        return { ref, text: `${metadata.severity ?? "?"} ${payloadText(data)}` };
    }
    return {
        ref,
        text: `${request.requestMethod ?? "?"} ${pathOf(request.requestUrl)} status=${request.status ?? "?"} latency=${String(request.latency ?? "?")}`
    };
}

// 로그 페이로드에서 메시지를 한 줄로 추출하고 최대 글자 수로 축약
function payloadText(data: unknown): string {
    const message = typeof data === "string"
        ? data
        : (data as { message?: unknown } | null)?.message;
    const text = typeof message === "string" ? message : JSON.stringify(data ?? "");
    const oneLine = text.replace(/\s+/g, " ").trim();
    return oneLine.length <= maxServerLogMessageLength
        ? oneLine
        : `${oneLine.slice(0, maxServerLogMessageLength - 1)}…`;
}

// 요청 URL에서 쿼리 문자열을 제외한 경로 추출
function pathOf(url: string | undefined): string {
    if (url === undefined) { return "?"; }
    try {
        return new URL(url).pathname;
    } catch {
        return url.split("?")[0];
    }
}
