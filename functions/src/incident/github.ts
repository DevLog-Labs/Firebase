import axios from "axios";
import * as logger from "firebase-functions/logger";
import { toError } from "../common/error";

// 이슈를 만드는 GitHub 저장소. 자동 수정 워크플로가 있는 저장소 하나에만 만듦
const repository = "DevLog-Labs/Firebase";

// GitHub REST API 주소
const apiBaseUrl = "https://api.github.com";

// 요청 한 건의 제한 시간(밀리초)
const requestTimeoutMilliseconds = 30 * 1000;

// 열린 이슈를 한 번에 가져오는 최대 개수
const openIssuePageSize = 100;

// Crashlytics 분석 이슈에 붙이는 라벨
export const incidentLabel = "crashlytics";

// 자동 수정 대상 이슈에 붙이는 라벨. 이 라벨이 붙은 이슈를 수정 워크플로가 처리함
export const autoFixLabel = "auto-fix";

// 저장소에 없으면 만드는 라벨 정의
const labelSpecs = [
    { name: incidentLabel, color: "b60205", description: "Crashlytics 오류 분석 이슈" },
    { name: autoFixLabel, color: "0e8a16", description: "자동 수정 대상" }
];

// 이슈 본문에서 Crashlytics 이슈를 식별하는 표식의 정규식
const markerPattern = /<!-- crashlytics:(\S+) -->/;

// 만들거나 갱신할 이슈 하나
export type IncidentIssueDraft = {
    // 같은 Crashlytics 이슈 그룹을 식별하는 키
    markerKey: string;
    // 이슈 제목
    title: string;
    // 이슈 본문. 첫 줄에 식별 표식을 포함
    body: string;
    // 이슈에 붙일 라벨 목록
    labels: string[];
    // 이미 열린 이슈가 있을 때 남기는 갱신 댓글
    updateComment: string;
};

// 이슈 하나를 처리한 결과
export type IssueSyncResult = {
    // 처리한 이슈 그룹의 식별 키
    markerKey: string;
    // 수행한 동작. 새로 만들기, 댓글 추가, 실패 중 하나
    action: "created" | "commented" | "failed";
    // 대상 이슈 번호. 실패하면 null
    number: number | null;
};

// 열린 이슈를 확인해 있으면 댓글로 갱신하고 없으면 새 이슈를 생성
export async function syncIncidentIssues(
    token: string,
    drafts: IncidentIssueDraft[]
): Promise<IssueSyncResult[]> {
    if (drafts.length === 0) { return []; }

    await ensureLabels(token);
    const openIssues = await listOpenIncidentIssues(token);

    const results: IssueSyncResult[] = [];
    for (const draft of drafts) {
        results.push(await syncDraft(token, draft, openIssues));
    }
    return results;
}

// 이슈 하나를 처리하고 실패해도 예외 대신 실패 결과를 반환
async function syncDraft(
    token: string,
    draft: IncidentIssueDraft,
    openIssues: Map<string, number>
): Promise<IssueSyncResult> {
    const existing = openIssues.get(draft.markerKey);
    try {
        if (existing !== undefined) {
            await request(token, "post", `/repos/${repository}/issues/${existing}/comments`, {
                body: draft.updateComment
            });
            return { markerKey: draft.markerKey, action: "commented", number: existing };
        }

        const created = await request(token, "post", `/repos/${repository}/issues`, {
            title: draft.title,
            body: draft.body,
            labels: draft.labels
        }) as { number: number };
        return { markerKey: draft.markerKey, action: "created", number: created.number };
    } catch (error) {
        logger.error("이슈 생성 또는 갱신 실패", toError(error), { markerKey: draft.markerKey });
        return { markerKey: draft.markerKey, action: "failed", number: null };
    }
}

// 저장소에 없는 라벨을 생성. 이미 있으면 그대로 사용
async function ensureLabels(token: string): Promise<void> {
    for (const spec of labelSpecs) {
        await request(token, "post", `/repos/${repository}/labels`, spec, [422]);
    }
}

// 열린 Crashlytics 이슈의 번호를 식별 키별로 조회. 풀 리퀘스트는 제외
async function listOpenIncidentIssues(token: string): Promise<Map<string, number>> {
    const issues = await request(
        token,
        "get",
        `/repos/${repository}/issues?labels=${incidentLabel}&state=open&per_page=${openIssuePageSize}`
    ) as { number: number; body: string | null; pull_request?: unknown }[];

    const openIssues = new Map<string, number>();
    for (const issue of issues) {
        const marker = markerPattern.exec(issue.body ?? "");
        if (issue.pull_request === undefined && marker !== null && !openIssues.has(marker[1])) {
            openIssues.set(marker[1], issue.number);
        }
    }
    return openIssues;
}

// GitHub API 요청 한 건을 보내고 응답 본문을 반환. 허용한 상태 코드 외에는 토큰이 섞이지 않는 오류로 실패
async function request(
    token: string,
    method: "get" | "post",
    path: string,
    data?: object,
    allowedStatuses: number[] = []
): Promise<unknown> {
    let status: number;
    let body: unknown;
    try {
        const response = await axios.request({
            method,
            url: `${apiBaseUrl}${path}`,
            data,
            headers: {
                "Accept": "application/vnd.github+json",
                "Authorization": `Bearer ${token}`,
                "User-Agent": "DevLog-Firebase",
                "X-GitHub-Api-Version": "2022-11-28"
            },
            timeout: requestTimeoutMilliseconds,
            validateStatus: () => true
        });
        status = response.status;
        body = response.data;
    } catch {
        throw new Error(`GitHub API 요청을 보내지 못했습니다. ${method} ${path}`);
    }

    if ((status >= 200 && status < 300) || allowedStatuses.includes(status)) {
        return body;
    }
    throw new Error(`GitHub API 요청에 실패했습니다. ${method} ${path} status=${status}`);
}
