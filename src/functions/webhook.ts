import { app, HttpRequest, HttpResponseInit, InvocationContext } from "@azure/functions";
import { TableClient, AzureNamedKeyCredential } from "@azure/data-tables";
import * as apn from "node-apn";

// Configuración de Table Storage
const storageAccountName = process.env.STORAGE_ACCOUNT_NAME || "";
const storageAccountKey = process.env.STORAGE_ACCOUNT_KEY || "";
const tableName = "DeviceRegistration";

const tableClient = (storageAccountName && storageAccountKey) 
    ? new TableClient(`https://${storageAccountName}.table.core.windows.net`, tableName, new AzureNamedKeyCredential(storageAccountName, storageAccountKey))
    : null;

// Configuración APNs (TV2 Demo)
const apnOptions = {
    token: {
        key: process.env.APNS_P8_CONTENT || "", // Contenido del .p8
        keyId: process.env.APNS_KEY_ID || "7RCV68L77Z",
        teamId: process.env.APNS_TEAM_ID || "U4R2B2U7E6",
    },
    production: false // Sandbox para lab/demo
};

let apnProvider: apn.Provider | null = null;
if (apnOptions.token.key) {
    apnProvider = new apn.Provider(apnOptions);
}

export async function webhookHandler(request: HttpRequest, context: InvocationContext): Promise<HttpResponseInit> {
    context.log(`Webhook received from Vio. Method: ${request.method}`);

    try {
        const body: any = await request.json();
        context.log("Payload:", JSON.stringify(body));

        const { vio_notification_version, vio_event_type, userId, productId, campaignId, productName } = body;

        if (vio_notification_version !== 1 || vio_event_type !== "cart_intent") {
            return { status: 400, body: "Invalid envelope" };
        }

        context.log(`Buscando dispositivos para userId: ${userId}...`);
        
        let notifiedCount = 0;
        if (tableClient) {
            const entities = tableClient.listEntities({
                queryOptions: { filter: `PartitionKey eq '${userId}'` }
            });

            for await (const entity of entities) {
                if (entity.platform === "ios" && apnProvider) {
                    const note = new apn.Notification();
                    note.expiry = Math.floor(Date.now() / 1000) + 3600; // 1 hora
                    note.badge = 1;
                    note.sound = "default";
                    note.alert = {
                        title: "Nuevo producto disponible",
                        body: `Revisa ${productName || 'el producto'} que vimos en el stream`
                    };
                    note.topic = process.env.APNS_BUNDLE_ID || "viodev.tv2demo";
                    
                    // Payload alineado con feedback de Angelo
                    note.payload = {
                        vio_notification_version: 1,
                        vio_event_type: "cart_intent",
                        vio_cartIntent_kind: "cart_intent",
                        vio_cartIntent_productId: String(productId),
                        vio_cartIntent_campaignId: String(campaignId),
                        vio_cartIntent_productName: productName || ""
                    };

                    const result = await apnProvider.send(note, String(entity.rowKey));
                    context.log(`APNs Result for ${entity.rowKey}:`, JSON.stringify(result));
                    if (result.sent.length > 0) notifiedCount++;
                } else {
                    context.log(`Mock Push for ${entity.platform}: ${productName}`);
                    notifiedCount++;
                }
            }
        }

        return {
            status: 200,
            jsonBody: {
                status: "success",
                message: "Webhook processed",
                devices_notified: notifiedCount
            }
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
                    platform: platform,
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
