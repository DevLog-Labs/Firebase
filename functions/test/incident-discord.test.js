const assert = require("assert");
const axios = require("axios");

const { buildDailySummary, sendDiscordMessages } = require("../lib/incident/discord");
const { scoreRisk } = require("../lib/incident/score");

const flagNames = [
    "fatal",
    "launchCrash",
    "blocksCoreFlow",
    "dataLossPossible",
    "securityArea"
];

function riskEvidence(summary = "응답 필드 누락", quote = "keyNotFound") {
    return {
        issueId: "issue",
        rubricVersion: "v1",
        classification: { layer: "client", cause: "decode", httpStatus: 200 },
        evidence: [
            { id: "e1", source: "stack", ref: "TodoMapper.swift:42", quote },
            { id: "e2", source: "serverLog", ref: "log-1", quote: "status=200" }
        ],
        severity: Object.fromEntries(
            flagNames.map((name) => [name, { value: false, evidenceIds: ["e1"] }])
        ),
        rootCause: {
            summary,
            codeLocation: { file: "TodoMapper.swift", line: 42 },
            reproducible: true
        },
        proposedFix: {
            type: "optionalDecoding",
            files: ["functions/src/todo/update.ts"],
            reversible: true
        }
    };
}

// 영향 사용자 수로 등급을 조절한 요약 이슈 생성 (100명 이상 3, 20명 이상 2, 그 미만은 심각도 기본 수준에 따라 1)
function item(id, affectedUsers, overrides = {}) {
    const evidence = riskEvidence(overrides.summary, overrides.quote);
    const metrics = { affectedUsers, isRegression: false };
    return {
        issueId: id,
        title: overrides.title ?? `이슈 ${id}`,
        url: `https://console.firebase.google.com/issue/${id}`,
        riskEvidence: evidence,
        score: scoreRisk(evidence, metrics),
        metrics
    };
}

function totalLength(embed) {
    return embed.title.length
        + embed.description.length
        + embed.footer.text.length
        + embed.fields.reduce((sum, field) => sum + field.name.length + field.value.length, 0);
}

// 등급이 높은 이슈는 이슈별 embed로, 낮은 이슈는 한 embed에 한 줄씩 담고 높은 등급을 앞에 배치
{
    const messages = buildDailySummary(
        [item("low0", 1), item("high3", 100), item("mid1", 5), item("high2", 20)],
        "2026-10-28"
    );

    assert.strictEqual(messages.length, 1);
    assert.strictEqual(messages[0].content, "2026-10-28 오류 요약 · 신규·급증·회귀 4건");
    assert.deepStrictEqual(messages[0].allowed_mentions, { parse: [] });

    const [first, second, brief] = messages[0].embeds;
    assert.strictEqual(messages[0].embeds.length, 3);
    assert.ok(first.title.startsWith("등급 3"));
    assert.ok(second.title.startsWith("등급 2"));
    assert.strictEqual(brief.title, "그 외 2건");
    assert.ok(brief.description.includes("이슈 mid1"));
    assert.ok(brief.description.includes("이슈 low0"));
    assert.ok(first.fields.some((field) => field.name === "근거" && field.value.includes("TodoMapper.swift:42")));
}

// 이슈가 없으면 embed 없이 본문만 있는 메시지 한 건
{
    const messages = buildDailySummary([], "2026-10-28");

    assert.strictEqual(messages.length, 1);
    assert.deepStrictEqual(messages[0].embeds, []);
    assert.ok(messages[0].content.includes("이슈가 없습니다"));
}

// embed가 10개를 넘으면 메시지를 나누고 본문은 첫 메시지에만 포함
{
    const items = Array.from({ length: 12 }, (_, index) => item(`h${index}`, 100));
    const messages = buildDailySummary(items, "2026-10-28");

    assert.deepStrictEqual(messages.map((message) => message.embeds.length), [10, 2]);
    assert.ok(messages[0].content);
    assert.strictEqual(messages[1].content, undefined);
}

// 긴 원인 요약과 인용문은 잘라서 글자 수 상한을 지키고 메시지당 embed 전체 글자 수도 6000자를 넘지 않음
{
    const long = "가".repeat(5000);
    const items = Array.from({ length: 8 }, (_, index) => item(`h${index}`, 100, {
        summary: long,
        quote: long,
        title: long
    }));
    const messages = buildDailySummary(items, "2026-10-28");

    assert.ok(messages.length > 1);
    for (const message of messages) {
        assert.ok(message.embeds.length <= 10);
        assert.ok(message.embeds.reduce((sum, embed) => sum + totalLength(embed), 0) <= 6000);
        for (const embed of message.embeds) {
            assert.ok(embed.title.length <= 256);
            assert.ok(embed.description.length <= 4096);
            for (const field of embed.fields) {
                assert.ok(field.value.length <= 1024);
            }
        }
    }
}

// 제목의 대괄호와 줄바꿈은 제거해 링크 문법을 깨뜨리지 않음
{
    const messages = buildDailySummary([item("x", 1, { title: "a[b](c)\nd" })], "2026-10-28");

    assert.ok(messages[0].embeds[0].description.includes("[ab(c) d](https://"));
}

(async () => {
    const webhookUrl = "https://discord.com/api/webhooks/123/secret-token";
    const originalRequest = axios.request;

    try {
        // 메시지를 순서대로 JSON 본문으로 전송
        {
            const calls = [];
            axios.request = async (config) => {
                calls.push(config);
                return { status: 204, data: "" };
            };
            const messages = buildDailySummary(
                Array.from({ length: 12 }, (_, index) => item(`h${index}`, 100)),
                "2026-10-28"
            );

            await sendDiscordMessages(webhookUrl, messages);

            assert.strictEqual(calls.length, 2);
            assert.strictEqual(calls[0].url, webhookUrl);
            assert.strictEqual(calls[0].method, "post");
            assert.strictEqual(calls[0].data, messages[0]);
            assert.strictEqual(calls[1].data, messages[1]);
        }

        // 속도 제한(429) 응답이면 retry_after만큼 기다린 뒤 다시 전송
        {
            const statuses = [429, 204];
            let calls = 0;
            axios.request = async () => {
                calls++;
                const status = statuses.shift();
                return { status, data: status === 429 ? { retry_after: 0.01 } : "" };
            };

            await sendDiscordMessages(webhookUrl, buildDailySummary([], "2026-10-28"));

            assert.strictEqual(calls, 2);
        }

        // 속도 제한이 계속되면 시도 횟수를 채운 뒤 실패
        {
            let calls = 0;
            axios.request = async () => {
                calls++;
                return { status: 429, data: { retry_after: 0.01 } };
            };

            await assert.rejects(
                sendDiscordMessages(webhookUrl, buildDailySummary([], "2026-10-28")),
                /status=429/
            );
            assert.strictEqual(calls, 3);
        }

        // 속도 제한이 아닌 실패는 재시도 없이 즉시 실패하며 오류에 웹훅 주소가 없음
        {
            let calls = 0;
            axios.request = async () => {
                calls++;
                return { status: 400, data: {} };
            };

            await assert.rejects(
                sendDiscordMessages(webhookUrl, buildDailySummary([], "2026-10-28")),
                (error) => /status=400/.test(error.message) && !error.message.includes("secret-token")
            );
            assert.strictEqual(calls, 1);
        }

        // 네트워크 오류가 나도 오류에 웹훅 주소가 섞이지 않음
        {
            axios.request = async (config) => {
                throw new Error(`connect ECONNREFUSED ${config.url}`);
            };

            await assert.rejects(
                sendDiscordMessages(webhookUrl, buildDailySummary([], "2026-10-28")),
                (error) => !error.message.includes("secret-token") && !String(error.stack).includes("secret-token")
            );
        }
    } finally {
        axios.request = originalRequest;
    }

    console.log("incident-discord.test.js passed");
})();
