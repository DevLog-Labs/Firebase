import axios from "axios";
import * as logger from "firebase-functions/logger";
import { toError } from "../common/error";
import type { SourceText } from "./analyze";

// 앱 코드를 읽을 저장소
const appRepository = "DevLog-Labs/iOS";

// 서버 코드를 읽을 저장소
const serverRepository = "DevLog-Labs/Firebase";

// 서버 컨트롤러와 서비스가 있는 디렉터리
const serverSourceDirectory = "nestjs-api/src";

// 오류 기록 도우미라서 원인 코드로 보지 않는 파일 이름
const crashlyticsHelperFile = "FirebaseCrashlyticsHelper.swift";

// 앱 코드 조각으로 가져오는 최대 파일 수
const maxAppSnippets = 3;

// 서버 코드 조각으로 가져오는 최대 파일 수
const maxServerSnippets = 2;

// 앱 스택 프레임 앞뒤로 가져오는 줄 수
const appContextLines = 20;

// 서버 파일에서 앞부분만 가져오는 줄 수
const serverHeadLines = 150;

// 코드 조각 하나의 최대 글자 수
const maxSnippetCharacters = 6000;

// GitHub REST API 주소
const apiBaseUrl = "https://api.github.com";

// 요청 한 건의 제한 시간(밀리초)
const requestTimeoutMilliseconds = 30 * 1000;

// 코드를 읽을 앱 스택 프레임 하나
export type CodeFrame = {
    // 소스 파일 이름
    file: string;
    // 소스 라인 번호
    line: number;
};

// 저장소에서 분석에 쓸 코드 조각을 읽는 객체
export type CodeReader = {
    // 앱 스택 프레임이 가리키는 파일의 앞뒤 코드를 읽음
    readAppFrames: (frames: CodeFrame[]) => Promise<SourceText[]>;
    // 요청 경로에 해당하는 서버 컨트롤러와 서비스의 앞부분 코드를 읽음
    readServerRoute: (requestPath: string) => Promise<SourceText[]>;
};

// 같은 실행 안에서 저장소 파일 목록과 파일 내용을 재사용하는 코드 읽기 객체 생성
export function createCodeReader(token: string): CodeReader {
    const trees = new Map<string, Promise<string[]>>();
    const files = new Map<string, Promise<string>>();

    const treePaths = (repository: string): Promise<string[]> => {
        const cached = trees.get(repository);
        if (cached !== undefined) { return cached; }
        const loaded = loadTreePaths(token, repository);
        trees.set(repository, loaded);
        return loaded;
    };

    const fileText = (
        repository: string,
        path: string
    ): Promise<string> => {
        const key = `${repository}:${path}`;
        const cached = files.get(key);
        if (cached !== undefined) { return cached; }
        const loaded = loadFileText(token, repository, path);
        files.set(key, loaded);
        return loaded;
    };

    return {
        readAppFrames: async (frames) => {
            try {
                return await readAppFrames(frames, treePaths, fileText);
            } catch (error) {
                logger.warn("앱 코드 조회에 실패해 코드 없이 분석합니다.", { error: toError(error).message });
                return [];
            }
        },
        readServerRoute: async (requestPath) => {
            try {
                return await readServerRoute(requestPath, treePaths, fileText);
            } catch (error) {
                logger.warn("서버 코드 조회에 실패해 코드 없이 분석합니다.", { error: toError(error).message });
                return [];
            }
        }
    };
}

// 앱 스택 프레임의 파일을 iOS 저장소에서 찾아 프레임 줄 앞뒤 코드로 변환
async function readAppFrames(
    frames: CodeFrame[],
    treePaths: (repository: string) => Promise<string[]>,
    fileText: (repository: string, path: string) => Promise<string>
): Promise<SourceText[]> {
    const wanted = frames
        .filter((frame) => frame.file !== crashlyticsHelperFile)
        .filter((frame, index, all) => all.findIndex((other) => other.file === frame.file) === index)
        .slice(0, maxAppSnippets);
    if (wanted.length === 0) { return []; }

    const paths = await treePaths(appRepository);
    const snippets: SourceText[] = [];
    for (const frame of wanted) {
        const path = paths
            .filter((candidate) => candidate === frame.file || candidate.endsWith(`/${frame.file}`))
            .sort((left, right) => left.length - right.length)[0];
        if (path === undefined) { continue; }

        const lines = (await fileText(appRepository, path)).split("\n");
        const start = Math.max(1, frame.line - appContextLines);
        const end = Math.min(lines.length, frame.line + appContextLines);
        snippets.push({
            ref: `iOS:${path}:${frame.line}`,
            text: numbered(lines, start, end)
        });
    }
    return snippets;
}

// 요청 경로에서 서버 디렉터리를 정해 컨트롤러와 서비스의 앞부분 코드로 변환
async function readServerRoute(
    requestPath: string,
    treePaths: (repository: string) => Promise<string[]>,
    fileText: (repository: string, path: string) => Promise<string>
): Promise<SourceText[]> {
    const segments = requestPath.split("/").filter((segment) => segment !== "");
    const trimmed = segments[0] === "api" ? segments.slice(1) : segments;
    const key = trimmed[0] === "auth" ? trimmed[1] : trimmed[0];
    if (key === undefined || !/^[\w-]+$/.test(key)) { return []; }

    const directory = `${serverSourceDirectory}/${key}/`;
    const candidates = (await treePaths(serverRepository))
        .filter((path) => path.startsWith(directory) && path.endsWith(".ts") && !/\.(spec|test)\.ts$/.test(path))
        .sort((left, right) => serverFileRank(left) - serverFileRank(right) || left.length - right.length)
        .slice(0, maxServerSnippets);

    const snippets: SourceText[] = [];
    for (const path of candidates) {
        const lines = (await fileText(serverRepository, path)).split("\n");
        const end = Math.min(lines.length, serverHeadLines);
        snippets.push({
            ref: `Firebase:${path}:1-${end}`,
            text: numbered(lines, 1, end)
        });
    }
    return snippets;
}

// 서버 파일의 우선순위. 컨트롤러, 서비스, 그 밖의 순
function serverFileRank(path: string): number {
    if (path.endsWith(".controller.ts")) { return 0; }
    if (path.endsWith(".service.ts")) { return 1; }
    return 2;
}

// 지정한 줄 범위를 줄 번호와 함께 이어 붙이고 최대 글자 수로 축약
function numbered(
    lines: string[],
    start: number,
    end: number
): string {
    const text = lines
        .slice(start - 1, end)
        .map((line, index) => `${start + index}| ${line}`)
        .join("\n");
    return text.length <= maxSnippetCharacters
        ? text
        : `${text.slice(0, maxSnippetCharacters - 1)}…`;
}

// 저장소의 기본 브랜치에 있는 모든 파일 경로를 조회
async function loadTreePaths(
    token: string,
    repository: string
): Promise<string[]> {
    const info = await getJson(token, `/repos/${repository}`) as { default_branch?: string };
    const branch = info.default_branch ?? "develop";
    const tree = await getJson(
        token,
        `/repos/${repository}/git/trees/${encodeURIComponent(branch)}?recursive=1`
    ) as { tree?: { path: string; type: string }[] };
    return (tree.tree ?? [])
        .filter((entry) => entry.type === "blob")
        .map((entry) => entry.path);
}

// 저장소 파일 하나의 내용을 문자열로 조회
async function loadFileText(
    token: string,
    repository: string,
    path: string
): Promise<string> {
    const encodedPath = path.split("/").map(encodeURIComponent).join("/");
    const file = await getJson(token, `/repos/${repository}/contents/${encodedPath}`) as {
        content?: string;
        encoding?: string;
    };
    if (file.encoding !== "base64" || file.content === undefined) {
        throw new Error(`파일 내용을 읽을 수 없습니다. ${repository}/${path}`);
    }
    return Buffer.from(file.content, "base64").toString("utf8");
}

// GitHub API GET 요청 한 건을 보내고 응답 본문을 반환. 오류에 토큰이 섞이지 않게 새 오류로 변환
async function getJson(
    token: string,
    path: string
): Promise<unknown> {
    let status: number;
    let body: unknown;
    try {
        const response = await axios.request({
            method: "get",
            url: `${apiBaseUrl}${path}`,
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
        throw new Error(`GitHub API 요청을 보내지 못했습니다. get ${path}`);
    }
    if (status < 200 || status >= 300) {
        throw new Error(`GitHub API 요청에 실패했습니다. get ${path} status=${status}`);
    }
    return body ?? {};
}
