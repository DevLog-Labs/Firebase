import {
    FieldValue,
    getFirestore
} from "firebase-admin/firestore";
import { FirestorePath } from "../common/firestorePath";

// 식별 키로 기록된 GitHub 이슈 번호 조회
// 기록이 없으면 undefined 반환
export async function readIssueRecord(markerKey: string): Promise<number | undefined> {
    const snapshot = await getFirestore().doc(FirestorePath.incidentIssue(markerKey)).get();
    const number = snapshot.get("number");
    return typeof number === "number" ? number : undefined;
}

// 새로 만든 GitHub 이슈 번호를 식별 키로 기록
// 이전 기록은 덮어씀
export async function writeIssueRecord(
    markerKey: string,
    number: number
): Promise<void> {
    await getFirestore().doc(FirestorePath.incidentIssue(markerKey)).set({
        // 마지막으로 만든 GitHub 이슈 번호
        number,
        // 기록 시각
        createdAt: FieldValue.serverTimestamp()
    });
}
