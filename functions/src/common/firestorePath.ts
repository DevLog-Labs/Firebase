export namespace FirestorePath {
    enum Collection {
        users = "users",
        userData = "userData",
        todoLists = "todoLists",
        notifications = "notifications",
        notificationDispatches = "notificationDispatches",
        authCredentials = "authCredentials",
        providers = "providers",
        oauthSessions = "oauthSessions",
        oauthTickets = "oauthTickets"
    }

    export enum UserDataDocument {
        info = "info",
        tokens = "tokens",
        settings = "settings",
        categories = "categories"
    }

    // 사용자 데이터 하위 컬렉션을 collection group query에 사용할 이름입니다.
    export const userDataCollectionGroup = Collection.userData;

    export function user(userId: string): string {
        return `${Collection.users}/${userId}`;
    }

    export function userData(userId: string, document?: UserDataDocument): string {
        const path = `${user(userId)}/${Collection.userData}`;
        if (!document) { return path; }
        return `${path}/${document}`;
    }

    export function todos(userId: string): string {
        return `${user(userId)}/${Collection.todoLists}`;
    }

    export function todo(userId: string, todoId: string): string {
        return `${todos(userId)}/${todoId}`;
    }

    export function notifications(userId: string): string {
        return `${user(userId)}/${Collection.notifications}`;
    }

    export function notification(userId: string, notificationId: string): string {
        return `${notifications(userId)}/${notificationId}`;
    }

    export function notificationDispatches(userId: string): string {
        return `${user(userId)}/${Collection.notificationDispatches}`;
    }

    export function notificationDispatch(userId: string, dispatchId: string): string {
        return `${notificationDispatches(userId)}/${dispatchId}`;
    }

    // 지정한 사용자의 서버 전용 인증 자격 증명 루트 경로를 반환합니다.
    export function authCredential(userId: string): string {
        return `${Collection.authCredentials}/${userId}`;
    }

    // 지정한 사용자의 서버 전용 provider credential 컬렉션 경로를 반환합니다.
    export function authCredentialProviders(userId: string): string {
        return `${authCredential(userId)}/${Collection.providers}`;
    }

    // 지정한 사용자의 서버 전용 GitHub 자격 증명 문서 경로를 반환합니다.
    export function githubCredential(userId: string): string {
        return `${authCredential(userId)}/${Collection.providers}/github`;
    }

    // 지정한 사용자의 서버 전용 Google 자격 증명 문서 경로를 반환합니다.
    export function googleCredential(userId: string): string {
        return `${authCredential(userId)}/${Collection.providers}/google`;
    }

    // provider 공통 OAuth session 컬렉션 경로를 저장합니다.
    export const oauthSessions = Collection.oauthSessions;

    // 지정한 OAuth state에 대응하는 session 문서 경로를 반환합니다.
    export function oauthSession(state: string): string {
        return `${oauthSessions}/${state}`;
    }

    // provider 공통 OAuth ticket 컬렉션 경로를 저장합니다.
    export const oauthTickets = Collection.oauthTickets;

    // 지정한 OAuth ticket 문서 경로를 반환합니다.
    export function oauthTicket(ticket: string): string {
        return `${oauthTickets}/${ticket}`;
    }
}
