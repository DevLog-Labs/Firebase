const assert = require("assert");

const { maskSensitiveText } = require("../lib/incident/mask");

const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ1c2VyMSJ9.c2lnbmF0dXJlMTIzNDU";

// 이메일 주소 마스킹
assert.strictEqual(
    maskSensitiveText("사용자 opfic.dev+test@gmail.com 요청 실패"),
    "사용자 [email] 요청 실패"
);

// JWT 마스킹
assert.strictEqual(maskSensitiveText(`token invalid: ${jwt}`), "token invalid: [jwt]");

// Authorization 헤더의 Bearer와 Basic 값 마스킹
assert.strictEqual(
    maskSensitiveText("Authorization: Bearer abcDEF123456.xyz"),
    "Authorization: Bearer [token]"
);
assert.strictEqual(
    maskSensitiveText("authorization: Basic dXNlcjpwYXNz"),
    "authorization: Basic [token]"
);

// 접두어가 알려진 비밀 값 마스킹
for (const secret of [
    "ghp_" + "a".repeat(36),
    "github_pat_" + "b".repeat(30),
    "sk-" + "c".repeat(32),
    "AIza" + "d".repeat(35),
    "xoxb-1234567890-abcdef"
]) {
    assert.strictEqual(maskSensitiveText(`key ${secret} end`), "key [secret] end");
}

// 키 이름으로 판단하는 값 마스킹 (JSON, 쿼리 문자열, key=value 형태)
assert.strictEqual(
    maskSensitiveText('{"access_token":"abc123","other":"keep"}'),
    '{"access_token":"[masked]","other":"keep"}'
);
assert.strictEqual(
    maskSensitiveText("GET /cb?code=1&refreshToken=abcdef&state=ok"),
    'GET /cb?code=1&refreshToken="[masked]"&state=ok'
);
assert.strictEqual(
    maskSensitiveText("uid=Zk3mPq9 userId: 'u-1' clientSecret=s3cr3t"),
    'uid="[masked]" userId: "[masked]" clientSecret="[masked]"'
);

// IPv4 주소 마스킹
assert.strictEqual(maskSensitiveText("from 203.0.113.42 refused"), "from [ip] refused");

// 일반 오류 문장과 비슷한 이름은 바꾸지 않음
for (const text of [
    "DecodingError.keyNotFound(CodingKeys(stringValue: \"category\"))",
    "restStatusCode=503 domain=DevLogInfra.TodoServiceImpl.fetchTodos",
    "tokenCount: 12 uidList: none",
    "앱 버전 2.1.0 빌드 305",
    "서버가 category 필드를 내려주지 않습니다."
]) {
    assert.strictEqual(maskSensitiveText(text), text);
}

// 이미 마스킹한 문자열을 다시 마스킹해도 결과가 같음
{
    const once = maskSensitiveText(`mail a@b.co token=xyz ${jwt} 10.0.0.1`);

    assert.strictEqual(maskSensitiveText(once), once);
}

console.log("incident-mask.test.js passed");
