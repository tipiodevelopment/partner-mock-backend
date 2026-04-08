import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TableClient, AzureNamedKeyCredential } from "@azure/data-tables";
import * as apn from "node-apn";
import { initializeApp, cert, getApps, App as FirebaseApp } from "firebase-admin/app";
import { getMessaging, Messaging } from "firebase-admin/messaging";

// --- Configuración Storage ---
const storageAccountName = process.env.STORAGE_ACCOUNT_NAME || "";
const storageAccountKey = process.env.STORAGE_ACCOUNT_KEY || "";
const tableName = "DeviceRegistration";

const tableClient = (storageAccountName && storageAccountKey)
  ? new TableClient(`https://${storageAccountName}.table.core.windows.net`, tableName, new AzureNamedKeyCredential(storageAccountName, storageAccountKey))
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

let apnProvider: apn.Provider | null = null;
if (apnOptions.token.key) {
  apnProvider = new apn.Provider(apnOptions);
}

// --- Configuración FCM (Android) ---
let firebaseApp: FirebaseApp | null = null;
let firebaseMessaging: Messaging | null = null;

try {
    const fcmProjectId = process.env.FCM_PROJECT_ID || "";
    const fcmClientEmail = process.env.FCM_CLIENT_EMAIL || "";
    const fcmPrivateKey = (process.env.FCM_PRIVATE_KEY || "").replace(/\\n/g, "\n");

    let serviceAccount: any = null;
    if (fcmProjectId && fcmClientEmail && fcmPrivateKey) {
        serviceAccount = {
            projectId: fcmProjectId,
            clientEmail: fcmClientEmail,
            privateKey: fcmPrivateKey,
        };
    }

    if (serviceAccount) {
        firebaseApp = getApps().length ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
        firebaseMessaging = getMessaging(firebaseApp);
    }
} catch (error) {
    // Keep function alive even if Android push config is invalid
    firebaseMessaging = null;
}

export async function webhookHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
  context.log(`Webhook received from Vio. Method: ${request.method}`);

  try {
    const body: any = await request.json();

    const {
      vio_notification_version,
      vio_user_id,
      vio_event_type,
      vio_payload
    } = body;

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

    // Texto de notificación: viene del backend si está, si no usamos fallback
    const notificationTitle = vio_payload.notification_title || productName || "Nytt produkt";
    const notificationBody =
      vio_payload.notification_body ||
      (productName ? `${productName} – klikk for å kjøpe.` : "Klikk for å kjøpe.");

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
            title: notificationTitle,
            body: notificationBody,
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
          if (result.sent.length > 0) notifiedCount++;

        } else if (platform === "android" && firebaseMessaging) {
          // --- Lógica Android (FCM) ---
          const message = {
            token: deviceToken,
            notification: {
              title: notificationTitle,
              body: notificationBody,
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
          } catch (error) {
            context.error(`FCM Error for ${deviceToken}:`, error);
          }
        } else {
          context.log(`Platform ${platform} not supported or provider not configured for token ${deviceToken}`);
        }
      }
    }

    return {
      status: 200,
      jsonBody: { status: "success", devices_notified: notifiedCount }
    };

  } catch (error) {
    context.error("Error processing webhook:", error);
    return { status: 400, body: "Invalid JSON" };
  }
};

app.http('partnerWebhook', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/partner/webhook',
  handler: webhookHandler
});

app.http('registerDevice', {
  methods: ['POST'],
  authLevel: 'anonymous',
  route: 'v1/partner/devices/register',
  handler: async (request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> => {
    try {
      const { userId, deviceToken, platform } = await request.json() as any;
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
    } catch (error) {
      return { status: 400, body: "Invalid request" };
    }
  }
});
