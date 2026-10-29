// 마스킹 대상 패턴과 치환 문자열 쌍
type MaskRule = {
    // 마스킹 대상을 찾는 정규식
    pattern: RegExp;
    // 대상을 바꿀 치환 문자열
    replacement: string;
};

// 마스킹 규칙 목록. 앞에 있는 규칙부터 순서대로 적용
const maskRules: MaskRule[] = [
    // JWT 형태의 토큰
    {
        pattern: /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]{5,}/g,
        replacement: "[jwt]"
    },
    // Authorization 헤더의 Bearer, Basic 값
    {
        pattern: /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
        replacement: "$1 [token]"
    },
    // GitHub, OpenAI, Google, Slack 등 접두어가 알려진 비밀 값
    {
        pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{20,}|AIza[0-9A-Za-z_-]{30,}|xox[baprs]-[A-Za-z0-9-]{10,})/g,
        replacement: "[secret]"
    },
    // 비밀이나 사용자 식별자를 담는 키의 값
    {
        pattern: /(\b(?:access_?token|refresh_?token|id_?token|client_?secret|api_?key|password|secret|token|uid|user_?id)"?\s*[:=]\s*)("[^"]*"|'[^']*'|[^\s,;&}\]]+)/gi,
        replacement: "$1\"[masked]\""
    },
    // 이메일 주소
    {
        pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g,
        replacement: "[email]"
    },
    // IPv4 주소
    {
        pattern: /\b(?:25[0-5]|2[0-4]\d|1?\d?\d)(?:\.(?:25[0-5]|2[0-4]\d|1?\d?\d)){3}\b/g,
        replacement: "[ip]"
    }
];

// LLM과 Discord로 보내기 전에 토큰, 비밀 값, 사용자 식별자, 이메일, IP를 치환한 문자열 생성
export function maskSensitiveText(text: string): string {
    return maskRules.reduce(
        (masked, rule) => masked.replace(rule.pattern, rule.replacement),
        text
    );
}
