const assert = require("assert");

const { classifyOrigin, originLabel, originLayer } = require("../lib/incident/classify");

const noLogs = { queried: false, requestMatches: 0, errorLogs: 0 };

function input(overrides = {}) {
    return {
        restStatusCode: "",
        isFatal: false,
        customKeys: [],
        hasDeveloperFrame: false,
        serverLogs: noLogs,
        ...overrides
    };
}

function nx(name, extra = "") {
    return [{ key: "NSUnderlyingError", value: `Nexa.NXError.${name}(${extra})` }];
}

// 모든 입력은 서버, iOS, 공동 중 하나로 분류되고 근거를 가짐
{
    const kinds = new Set(["server", "ios", "shared"]);
    const samples = [
        input(),
        input({ restStatusCode: "404" }),
        input({ restStatusCode: "503" }),
        input({ restStatusCode: "200", customKeys: nx("decoding") }),
        input({ isFatal: true }),
        input({ customKeys: nx("timeout") }),
        input({ customKeys: [{ key: "underlyingDomain", value: "FIRFirestoreErrorDomain" }] })
    ];

    for (const sample of samples) {
        const origin = classifyOrigin(sample);
        assert.ok(kinds.has(origin.kind), JSON.stringify(origin));
        assert.ok(origin.reasons.length > 0);
    }
}

// 전송 실패, 취소, 앱의 인증 상태, 잘못된 요청 생성은 iOS
for (const name of ["transport", "timeout", "cancelled", "authenticationRequired", "authProviderUnavailable", "invalidRequest"]) {
    assert.strictEqual(classifyOrigin(input({ customKeys: nx(name) })).kind, "ios", name);
}
assert.ok(classifyOrigin(input({ customKeys: nx("timeout") })).reasons[0].includes("재시도"));

// 오류 종류가 상태 코드보다 우선: 전송 실패는 상태 코드가 있어도 iOS
assert.strictEqual(classifyOrigin(input({ restStatusCode: "503", customKeys: nx("timeout") })).kind, "ios");

// 디코딩 실패는 상태 코드가 200이어도 공동
assert.strictEqual(classifyOrigin(input({ restStatusCode: "200", customKeys: nx("decoding", "error") })).kind, "shared");

// 5xx는 서버. 같은 시각 api-v2 요청 로그가 없으면 앞단 응답 가능성을 근거에 덧붙임
{
    const found = classifyOrigin(input({
        restStatusCode: "503",
        customKeys: nx("invalidStatus", "statusCode: 503"),
        serverLogs: { queried: true, requestMatches: 2, errorLogs: 0 }
    }));
    const missing = classifyOrigin(input({
        restStatusCode: "502",
        serverLogs: { queried: true, requestMatches: 0, errorLogs: 0 }
    }));
    const unknownLogs = classifyOrigin(input({ restStatusCode: "500" }));

    assert.deepStrictEqual(found, { kind: "server", reasons: ["서버가 503 응답"] });
    assert.strictEqual(missing.kind, "server");
    assert.ok(missing.reasons.some((reason) => reason.includes("요청 로그 없음")));
    assert.deepStrictEqual(unknownLogs.reasons, ["서버가 500 응답"]);
}

// 같은 시각 서버 에러 로그가 있으면 4xx여도 서버
assert.deepStrictEqual(
    classifyOrigin(input({ restStatusCode: "422", serverLogs: { queried: true, requestMatches: 1, errorLogs: 3 } })),
    { kind: "server", reasons: ["같은 시각 서버 에러 로그 3건"] }
);

// 서버 로그를 조회하지 못했으면 로그가 없다는 사실로 판단하지 않음
assert.strictEqual(classifyOrigin(input({ restStatusCode: "500", serverLogs: noLogs })).reasons.length, 1);

// 상태 코드별 분류: 429는 서버, 401과 403은 iOS, 404와 그 밖의 4xx는 서버와 앱을 함께 확인하는 공동
assert.strictEqual(classifyOrigin(input({ restStatusCode: "429" })).kind, "server");
assert.strictEqual(classifyOrigin(input({ restStatusCode: "401" })).kind, "ios");
assert.strictEqual(classifyOrigin(input({ restStatusCode: "403" })).kind, "ios");
for (const status of ["404", "400", "409", "422"]) {
    assert.strictEqual(classifyOrigin(input({ restStatusCode: status })).kind, "shared", status);
}
assert.ok(classifyOrigin(input({ restStatusCode: "404" })).reasons[0].includes("404"));
assert.ok(classifyOrigin(input({ restStatusCode: "422" })).reasons[0].includes("422"));

// REST가 아닌 오류: 크래시는 앱 프레임 유무와 상관없이 iOS이고 근거 문장이 다름
{
    const withFrame = classifyOrigin(input({ isFatal: true, hasDeveloperFrame: true }));
    const withoutFrame = classifyOrigin(input({ isFatal: true, hasDeveloperFrame: false }));

    assert.strictEqual(withFrame.kind, "ios");
    assert.strictEqual(withoutFrame.kind, "ios");
    assert.notStrictEqual(withFrame.reasons[0], withoutFrame.reasons[0]);
}

// REST 응답이 없는 비치명 오류는 오류 도메인과 무관하게 앱 내부 오류로 iOS
for (const domain of ["FIRFirestoreErrorDomain", "FIRAuthErrorDomain", "DevLog.TodoError"]) {
    const origin = classifyOrigin(input({ customKeys: [{ key: "underlyingDomain", value: domain }] }));
    assert.strictEqual(origin.kind, "ios", domain);
}

// 분류별 표시 이름과 오류 계층 변환
assert.deepStrictEqual(["server", "ios", "shared"].map(originLabel), ["서버", "iOS", "공동"]);
assert.deepStrictEqual(["server", "ios", "shared"].map(originLayer), ["server", "client", "unknown"]);

console.log("incident-classify.test.js passed");
