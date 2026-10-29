const assert = require("assert");
const axios = require("axios");

const warnings = [];
require.cache[require.resolve("firebase-functions/logger")] = {
    exports: { warn: (...values) => warnings.push(values), error() {}, info() {} }
};

const { createCodeReader } = require("../lib/incident/code");

const token = "ghp_secrettoken";
const iosFile = "Application/Infra/Sources/Service/TodoCommandServiceImpl.swift";

function fileOf(lineCount, prefix = "line") {
    return Array.from({ length: lineCount }, (_, index) => `${prefix} ${index + 1}`).join("\n");
}

const trees = {
    "DevLog-Labs/iOS": [
        iosFile,
        "Application/Infra/Sources/Common/FirebaseCrashlyticsHelper.swift",
        "Application/Presentation/Sources/TodoStore.swift",
        "Legacy/Archived/Deprecated/Old/Sources/TodoCommandServiceImpl.swift",
        "README.md"
    ],
    "DevLog-Labs/Firebase": [
        "nestjs-api/src/todos/todos.service.ts",
        "nestjs-api/src/todos/todos.controller.ts",
        "nestjs-api/src/todos/todos.controller.spec.ts",
        "nestjs-api/src/todos/todos.module.ts",
        "nestjs-api/src/todos/dto/create-todo.dto.test.ts",
        "nestjs-api/src/google/google.controller.ts",
        "functions/src/index.ts"
    ]
};
const contents = {
    [`DevLog-Labs/iOS/${iosFile}`]: fileOf(100),
    "DevLog-Labs/iOS/Application/Presentation/Sources/TodoStore.swift": fileOf(10),
    "DevLog-Labs/Firebase/nestjs-api/src/todos/todos.controller.ts": fileOf(400, "controller"),
    "DevLog-Labs/Firebase/nestjs-api/src/todos/todos.service.ts": "x".repeat(9000),
    "DevLog-Labs/Firebase/nestjs-api/src/todos/todos.module.ts": fileOf(5, "module"),
    "DevLog-Labs/Firebase/nestjs-api/src/google/google.controller.ts": fileOf(3, "google")
};

const requests = [];
let treeStatus = 200;
axios.request = async (config) => {
    requests.push(config);
    const path = config.url.replace("https://api.github.com/repos/", "");
    const repository = path.split("/").slice(0, 2).join("/");
    const rest = path.split("/").slice(2).join("/");

    if (rest === "") { return { status: 200, data: { default_branch: "develop" } }; }
    if (rest.startsWith("git/trees/")) {
        if (treeStatus !== 200) { return { status: treeStatus, data: {} }; }
        return { status: 200, data: { tree: trees[repository].map((entry) => ({ path: entry, type: "blob" })) } };
    }
    const content = contents[`${repository}/${decodeURIComponent(rest.replace("contents/", ""))}`];
    return content === undefined
        ? { status: 404, data: {} }
        : { status: 200, data: { encoding: "base64", content: Buffer.from(content).toString("base64") } };
};

function treeRequests() {
    return requests.filter((request) => request.url.includes("/git/trees/")).length;
}

(async () => {
    // 앱 스택 프레임의 파일을 이름으로 찾아 프레임 줄 앞뒤 20줄을 줄 번호와 함께 반환. 같은 이름이 여럿이면 짧은 경로를 선택
    {
        const reader = createCodeReader(token);
        const [snippet] = await reader.readAppFrames([{ file: "TodoCommandServiceImpl.swift", line: 50 }]);
        const lines = snippet.text.split("\n");

        assert.strictEqual(snippet.ref, `iOS:${iosFile}:50`);
        assert.strictEqual(lines.length, 41);
        assert.strictEqual(lines[0], "30| line 30");
        assert.strictEqual(lines[40], "70| line 70");
        assert.ok(requests.every((request) => request.headers.Authorization === `Bearer ${token}`));
    }

    // 줄 번호 범위는 파일의 처음과 끝을 넘지 않고, 도우미 파일과 같은 파일의 중복 프레임은 제외하며 없는 파일은 건너뜀
    {
        const reader = createCodeReader(token);
        const snippets = await reader.readAppFrames([
            { file: "FirebaseCrashlyticsHelper.swift", line: 32 },
            { file: "TodoCommandServiceImpl.swift", line: 3 },
            { file: "TodoCommandServiceImpl.swift", line: 90 },
            { file: "Missing.swift", line: 1 },
            { file: "TodoStore.swift", line: 9 }
        ]);

        assert.deepStrictEqual(snippets.map((snippet) => snippet.ref), [
            `iOS:${iosFile}:3`,
            "iOS:Application/Presentation/Sources/TodoStore.swift:9"
        ]);
        assert.ok(snippets[0].text.startsWith("1| line 1\n"));
        assert.ok(snippets[0].text.endsWith("23| line 23"));
        assert.ok(snippets[1].text.endsWith("10| line 10"));
    }

    // 같은 읽기 객체는 저장소 파일 목록과 파일 내용을 한 번만 조회
    {
        requests.length = 0;
        const reader = createCodeReader(token);
        await reader.readAppFrames([{ file: "TodoStore.swift", line: 5 }]);
        await reader.readAppFrames([{ file: "TodoStore.swift", line: 6 }]);

        assert.strictEqual(treeRequests(), 1);
        assert.strictEqual(requests.filter((request) => request.url.endsWith("TodoStore.swift")).length, 1);
    }

    // 읽을 프레임이 없으면 요청을 보내지 않음
    {
        requests.length = 0;
        assert.deepStrictEqual(await createCodeReader(token).readAppFrames([]), []);
        assert.strictEqual(requests.length, 0);
    }

    // 서버 요청 경로의 첫 세그먼트로 디렉터리를 정해 컨트롤러, 서비스 순으로 최대 2개를 앞부분 150줄만 반환하고 테스트 파일은 제외
    {
        const reader = createCodeReader(token);
        const snippets = await reader.readServerRoute("/api/todos/t1/deletion-request");

        assert.deepStrictEqual(snippets.map((snippet) => snippet.ref), [
            "Firebase:nestjs-api/src/todos/todos.controller.ts:1-150",
            "Firebase:nestjs-api/src/todos/todos.service.ts:1-1"
        ]);
        assert.strictEqual(snippets[0].text.split("\n").length, 150);
        assert.ok(snippets[0].text.startsWith("1| controller 1\n"));
        assert.ok(snippets[1].text.length <= 6000);
    }

    // auth 아래 경로는 다음 세그먼트를 디렉터리로 쓰고, 알 수 없는 경로와 잘못된 문자는 빈 결과
    {
        const reader = createCodeReader(token);

        assert.deepStrictEqual(
            (await reader.readServerRoute("/api/auth/google/callback")).map((snippet) => snippet.ref),
            ["Firebase:nestjs-api/src/google/google.controller.ts:1-3"]
        );
        assert.deepStrictEqual(await reader.readServerRoute("/api/unknown/x"), []);
        assert.deepStrictEqual(await reader.readServerRoute("/"), []);
        assert.deepStrictEqual(await reader.readServerRoute("/api/../etc"), []);
    }

    // 조회가 실패하면 예외 대신 빈 결과와 경고를 남기고 오류에 토큰이 없음
    {
        treeStatus = 500;
        warnings.length = 0;
        const reader = createCodeReader(token);

        assert.deepStrictEqual(await reader.readAppFrames([{ file: "TodoStore.swift", line: 5 }]), []);
        assert.deepStrictEqual(await reader.readServerRoute("/api/todos/x"), []);
        assert.strictEqual(warnings.length, 2);
        assert.ok(!JSON.stringify(warnings).includes(token));
        treeStatus = 200;
    }

    console.log("incident-code.test.js passed");
})();
