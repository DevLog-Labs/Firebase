// 오류를 고칠 위치 분류. 공동은 서버와 앱을 함께 확인해야 하는 경우
export type OriginKind = "server" | "ios" | "shared";

// 원인 위치 판정 결과
export type Origin = {
    // 고칠 위치 분류
    kind: OriginKind;
    // 분류를 정한 근거 목록
    reasons: string[];
};

// 원인 위치 판정에 쓰는 입력
export type OriginInput = {
    // 오류에 기록된 HTTP 상태 코드. REST 오류가 아니면 빈 문자열
    restStatusCode: string;
    // 앱이 종료된 크래시 이슈인지 여부
    isFatal: boolean;
    // 대표 이벤트의 custom key 목록
    customKeys: { key: string; value: string }[];
    // 스택에 앱 개발자 코드 프레임이 있는지 여부
    hasDeveloperFrame: boolean;
    // 같은 시각 서버 로그 조회 결과
    serverLogs: {
        // 서버 로그를 조회했고 성공했는지 여부
        queried: boolean;
        // 같은 상태 코드의 서버 요청 로그 개수
        requestMatches: number;
        // 요청 로그가 아닌 서버 에러 로그 개수
        errorLogs: number;
    };
};

// 분류별 표시 이름
const originLabels: Record<OriginKind, string> = {
    server: "서버",
    ios: "iOS",
    shared: "공동"
};

// 분류별 표시 이름 조회
export function originLabel(kind: OriginKind): string {
    return originLabels[kind];
}

// 분석 결과의 계층 값으로 쓰는 분류 변환
export function originLayer(kind: OriginKind): "client" | "server" | "unknown" {
    switch (kind) {
        case "server":
            return "server";
        case "ios":
            return "client";
        default:
            return "unknown";
    }
}

// 상태 코드, 오류 종류, 스택, 서버 로그로 고칠 위치를 규칙에 따라 판정
export function classifyOrigin(input: OriginInput): Origin {
    const valueOf = (key: string): string => (
        input.customKeys.find((item) => item.key === key)?.value ?? ""
    );
    const nxCase = /Nexa\.NXError\.(\w+)/.exec(valueOf("NSUnderlyingError"))?.[1];
    const status = input.restStatusCode === "" ? null : Number(input.restStatusCode);

    if (nxCase === "transport" || nxCase === "timeout") {
        return { kind: "ios", reasons: [`요청 전송 단계 실패(${nxCase}). 재시도와 오프라인 처리 확인`] };
    }
    if (nxCase === "cancelled") {
        return { kind: "ios", reasons: ["앱이 요청을 취소함"] };
    }
    if (nxCase === "authenticationRequired" || nxCase === "authProviderUnavailable") {
        return { kind: "ios", reasons: [`앱의 인증 상태 문제(${nxCase})`] };
    }
    if (nxCase === "invalidRequest") {
        return { kind: "ios", reasons: ["앱이 잘못된 요청을 만듦"] };
    }
    if (nxCase === "decoding") {
        return { kind: "shared", reasons: ["응답 디코딩 실패. 서버 응답과 앱 모델을 함께 확인"] };
    }

    if (status !== null) {
        return classifyStatus(status, input.serverLogs);
    }

    if (input.isFatal) {
        return {
            kind: "ios",
            reasons: [input.hasDeveloperFrame
                ? "크래시 스택에 앱 코드 프레임 존재"
                : "크래시 스택에 앱 코드 프레임 없음. 외부 SDK 사용 방식 확인"]
        };
    }
    return { kind: "ios", reasons: ["REST 응답 없이 앱 내부에서 발생한 오류"] };
}

// REST 상태 코드와 서버 로그로 고칠 위치를 판정
function classifyStatus(
    status: number,
    serverLogs: OriginInput["serverLogs"]
): Origin {
    if (serverLogs.queried && serverLogs.errorLogs > 0) {
        return { kind: "server", reasons: [`같은 시각 서버 에러 로그 ${serverLogs.errorLogs}건`] };
    }
    if (status >= 500) {
        const noRequestLog = serverLogs.queried && serverLogs.requestMatches === 0;
        return {
            kind: "server",
            reasons: [
                `서버가 ${status} 응답`,
                ...(noRequestLog ? ["api-v2 요청 로그 없음. 앞단 또는 인프라 응답 가능성"] : [])
            ]
        };
    }
    if (status === 429) {
        return { kind: "server", reasons: ["요청 한도 초과(429)"] };
    }
    if (status === 401 || status === 403) {
        return { kind: "ios", reasons: [`인증 또는 권한 실패(${status}). 토큰 갱신과 세션 처리 확인`] };
    }
    return {
        kind: "shared",
        reasons: [status === 404
            ? "대상을 찾지 못함(404). 서버 데이터와 앱 요청을 함께 확인"
            : `요청 내용과 서버 검증 불일치(${status}). 서버 규칙과 앱 요청을 함께 확인`]
    };
}
