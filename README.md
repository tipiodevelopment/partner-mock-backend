# Partner Mock Backend (Vio.live Lab)

Servicio para simular el rol de un partner real (Viaplay, TV2) en el flujo de integración con Vio.live.

## Alcance
1. **Webhook Receiver:** Endpoint que recibe webhooks de `cart-intent` desde el backend de Vio.
2. **Device Registry:** Almacena la relación `userId` <-> `deviceToken` en Azure Table Storage.
3. **Push Forwarder:** Reenvía notificaciones push reales a dispositivos registrados usando APNs (iOS) y Firebase Cloud Messaging (Android).

## Endpoints

### 1. Webhook (Consumido por Vio)
- **POST** `/api/v1/partner/webhook`
- **Payload:**
```json
{
  "vio_notification_version": 1,
  "vio_event_type": "cart_intent",
  "userId": "<string>",
  "productId": "<string>",
  "campaignId": <number>,
  "productName": "<string>"
}
```

### 2. Device Registration (Consumido por Apps Demo)
- **POST** `/api/v1/partner/devices/register`
- **Payload:**
```json
{
  "userId": "usuario_de_demo",
  "deviceToken": "token_apns_real",
  "platform": "ios | android"
}
```

## Configuración de Infraestructura
El proyecto está desplegado como una **Azure Function (Node.js)** vinculada a un **Azure Table Storage**.

### Variables de Entorno (Secrets)
- `STORAGE_ACCOUNT_NAME`: Nombre de la cuenta de storage.
- `STORAGE_ACCOUNT_KEY`: Llave de acceso a la tabla `DeviceRegistration`.
- `APNS_P8_CONTENT`: Contenido del archivo `.p8` de Apple.
- `APNS_KEY_ID`: ID de la llave APNs.
- `APNS_TEAM_ID`: ID del equipo de Apple Developer.
- `APNS_BUNDLE_ID`: Bundle ID de la app demo (ej. `viodev.tv2demo`).
- `FCM_PROJECT_ID`: Project ID de Firebase (formato usado en `socket-server`).
- `FCM_CLIENT_EMAIL`: Client email del service account.
- `FCM_PRIVATE_KEY`: Private key del service account (con `\n` escapados).
- `FIREBASE_SERVICE_ACCOUNT_JSON`: JSON completo de service account de Firebase (alternativa compatible).
- `FIREBASE_SERVICE_ACCOUNT_B64`: El mismo JSON codificado en base64 (alternativa compatible).
