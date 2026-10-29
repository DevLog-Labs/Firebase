import * as admin from "firebase-admin";

import {
    cleanupDeletedUserFirestoreData
} from "./user/delete";

import {
    sendPushNotification
} from "./fcm/notification";

import {
    scheduleTodoReminder
} from "./fcm/schedule";

import {
    compactSoftDeletedTodos
} from "./todo/cleanup";

import {
    syncTodoNotificationCategory
} from "./todo/update";

import {
    requestMoveRemovedCategoryTodosToEtc,
    completeMoveRemovedCategoryTodosToEtc
} from "./todoCategory/update";

import {
    removeTodoNotificationDocuments,
    removeCompletedTodoNotificationRecords,
    cleanupNotificationDispatches,
    cleanupSoftDeletedNotifications
} from "./notification/cleanup";

import {
    cleanupSoftDeletedWebPages
} from "./webPage/cleanup";

import {
    sendDailyIncidentReport
} from "./incident/daily";

import { api } from "./rest/api";
import {
    cleanupExpiredOAuthSessions,
    cleanupExpiredOAuthTickets
} from "./rest/oauth/cleanup";

// Cloud Functions REST base URL: https://${region}-${projectId}.cloudfunctions.net/api/api

// Firebase 앱 초기화
admin.initializeApp();

export {
    cleanupDeletedUserFirestoreData
};

// FCM 관련 함수들 내보내기
export {
    sendPushNotification,
    scheduleTodoReminder
};

export {
    cleanupNotificationDispatches,
    cleanupExpiredOAuthSessions,
    cleanupExpiredOAuthTickets,
    compactSoftDeletedTodos,
    completeMoveRemovedCategoryTodosToEtc,
    requestMoveRemovedCategoryTodosToEtc,
    removeCompletedTodoNotificationRecords,
    removeTodoNotificationDocuments,
    cleanupSoftDeletedNotifications,
    cleanupSoftDeletedWebPages,
    sendDailyIncidentReport,
    syncTodoNotificationCategory,
    api
};
