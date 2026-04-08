"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.webhookHandler = webhookHandler;
const functions_1 = require("@azure/functions");
const data_tables_1 = require("@azure/data-tables");
const apn = __importStar(require("node-apn"));
const app_1 = require("firebase-admin/app");
const messaging_1 = require("firebase-admin/messaging");
// --- Configuración Storage ---
const storageAccountName = process.env.STORAGE_ACCOUNT_NAME || "";
const storageAccountKey = process.env.STORAGE_ACCOUNT_KEY || "";
const tableName = "DeviceRegistration";
const tableClient = (storageAccountName && storageAccountKey)
    ? new data_tables_1.TableClient(`https://${storageAccountName}.table.core.windows.net`, tableName, new data_tables_1.AzureNamedKeyCredential(storageAccountName, storageAccountKey))
    : null;
// --- Configuración APNs (iOS) ---
const apnOptions = {
    token: {
        key: process.env.APNS_P8_CONTENT || "",
        keyId: process.env.APNS_KEY_ID || "",
        teamId: process.env.APNS_TEAM_ID || "",
    },
    production: false
};
let apnProvider = null;
if (apnOptions.token.key) {
    apnProvider = new apn.Provider(apnOptions);
}
// --- Configuración FCM (Android) ---
let firebaseApp = null;
let firebaseMessaging = null;
try {
    const fcmProjectId = process.env.FCM_PROJECT_ID || "";
    const fcmClientEmail = process.env.FCM_CLIENT_EMAIL || "";
    const fcmPrivateKey = (process.env.FCM_PRIVATE_KEY || "").replace(/\\n/g, "\n");
    let serviceAccount = null;
    if (fcmProjectId && fcmClientEmail && fcmPrivateKey) {
        serviceAccount = {
            projectId: fcmProjectId,
            clientEmail: fcmClientEmail,
            privateKey: fcmPrivateKey,
        };
    }
    if (serviceAccount) {
        firebaseApp = (0, app_1.getApps)().length ? (0, app_1.getApps)()[0] : (0, app_1.initializeApp)({ credential: (0, app_1.cert)(serviceAccount) });
        firebaseMessaging = (0, messaging_1.getMessaging)(firebaseApp);
    }
}
catch (error) {
    // Keep function alive even if Android push config is invalid
    firebaseMessaging = null;
}
async function webhookHandler(request, context) {
    context.log(`Webhook received from Vio. Method: ${request.method}`);
    try {
        const body = await request.json();
        const { vio_notification_version, vio_user_id, vio_event_type, vio_payload } = body;
        if (vio_notification_version !== 1 || vio_event_type !== "cart_intent") {
            return { status: 400, body: "Invalid envelope" };
        }
        if (!vio_user_id || !vio_payload || !vio_payload.product_id || !vio_payload.campaign_id) {
            return { status: 400, body: "Invalid cart_intent payload" };
        }
        const userId = String(vio_user_id);
        const productId = String(vio_payload.product_id);
        const campaignId = String(vio_payload.campaign_id);
        const productName = vio_payload.product_name || "";
        context.log(`Buscando dispositivos para userId: ${userId}...`);
        let notifiedCount = 0;
        if (tableClient) {
            const entities = tableClient.listEntities({
                queryOptions: { filter: `PartitionKey eq '${userId}'` }
            });
            for await (const entity of entities) {
                const deviceToken = String(entity.rowKey);
                const platform = String(entity.platform).toLowerCase();
                if (platform === "ios" && apnProvider) {
                    // --- Lógica iOS (APNs) ---
                    const note = new apn.Notification();
                    note.expiry = Math.floor(Date.now() / 1000) + 3600;
                    note.badge = 1;
                    note.sound = "default";
                    note.alert = {
                        title: "Nuevo producto disponible",
                        body: `Revisa ${productName || 'el producto'} que vimos en el stream`
                    };
                    note.topic = process.env.APNS_BUNDLE_ID || "";
                    note.payload = {
                        vio_notification_version,
                        vio_user_id: userId,
                        vio_event_type,
                        vio_payload
                    };
                    const result = await apnProvider.send(note, deviceToken);
                    context.log(`APNs Result for ${deviceToken}:`, JSON.stringify(result));
                    if (result.sent.length > 0)
                        notifiedCount++;
                }
                else if (platform === "android" && firebaseMessaging) {
                    // --- Lógica Android (FCM) ---
                    const message = {
                        token: deviceToken,
                        notification: {
                            title: "Nuevo producto disponible",
                            body: `Revisa ${productName || 'el producto'} que vimos en el stream`
                        },
                        data: {
                            vio_notification_version: String(vio_notification_version ?? "1"),
                            vio_user_id: userId,
                            vio_event_type,
                            // aplanamos vio_payload como string JSON para Android
                            vio_payload: JSON.stringify(vio_payload)
                        }
                    };
                    try {
                        const response = await firebaseMessaging.send(message);
                        context.log(`FCM Result for ${deviceToken}:`, response);
                        notifiedCount++;
                    }
                    catch (error) {
                        context.error(`FCM Error for ${deviceToken}:`, error);
                    }
                }
                else {
                    context.log(`Platform ${platform} not supported or provider not configured for token ${deviceToken}`);
                }
            }
        }
        return {
            status: 200,
            jsonBody: { status: "success", devices_notified: notifiedCount }
        };
    }
    catch (error) {
        context.error("Error processing webhook:", error);
        return { status: 400, body: "Invalid JSON" };
    }
}
;
functions_1.app.http('partnerWebhook', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'v1/partner/webhook',
    handler: webhookHandler
});
functions_1.app.http('registerDevice', {
    methods: ['POST'],
    authLevel: 'anonymous',
    route: 'v1/partner/devices/register',
    handler: async (request, context) => {
        try {
            const { userId, deviceToken, platform } = await request.json();
            if (tableClient) {
                await tableClient.upsertEntity({
                    partitionKey: userId,
                    rowKey: deviceToken,
                    platform: platform.toLowerCase(),
                    updatedAt: new Date().toISOString()
                });
                return { status: 200, body: "Device registered" };
            }
            return { status: 500, body: "Storage not configured" };
        }
        catch (error) {
            return { status: 400, body: "Invalid request" };
        }
    }
});
