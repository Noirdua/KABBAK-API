"use strict";

/* Inbound email webhooks (pre-auth: providers cannot send an API key).
 *
 *   POST /api/v1/webhooks/email/resend    Resend/Svix signed
 *   POST /api/v1/webhooks/email/generic   shared token (x-webhook-token)
 *
 * Secrets live in runtime settings so they can be set from Admin → Server.
 */
const express = require("express");

const { createHttpError } = require("../lib/http-errors");
const webhooks = require("../services/email-webhook-service");
const { getRuntimeSettingValue } = require("../services/runtime-settings");

const router = express.Router();

function getSecret(key) {
  try {
    return String(getRuntimeSettingValue(key) || "").trim();
  } catch (_error) {
    return "";
  }
}

router.post("/resend", (request, response, next) => {
  try {
    const secret = getSecret("resendWebhookSecret");
    if (!secret) {
      throw createHttpError(
        503,
        "webhook_not_configured",
        "Set the Resend webhook signing secret (Admin → Server → Email) before using this endpoint."
      );
    }
    const rawBody = request.rawBody;
    if (!rawBody || !rawBody.length) {
      throw createHttpError(400, "invalid_webhook", "Webhook body is empty.");
    }
    const verified = webhooks.verifySvixSignature({
      rawBody,
      headers: request.headers,
      secret
    });
    if (!verified) {
      throw createHttpError(401, "invalid_signature", "Webhook signature did not verify.");
    }

    const event = webhooks.recordEmailEvent(webhooks.normalizeResendEvent(request.body || {}));
    response.status(202).apiSuccess({ received: true, id: event.id, type: event.type });
  } catch (error) {
    next(error);
  }
});

router.post("/generic", (request, response, next) => {
  try {
    const token = getSecret("emailWebhookToken");
    if (!token) {
      throw createHttpError(
        503,
        "webhook_not_configured",
        "Set the email webhook token (Admin → Server → Email) before using this endpoint."
      );
    }
    if (!webhooks.safeTokenEqual(token, webhooks.extractWebhookToken(request))) {
      throw createHttpError(401, "invalid_token", "Webhook token did not match.");
    }

    const event = webhooks.recordEmailEvent(webhooks.normalizeGenericEvent(request.body || {}));
    response.status(202).apiSuccess({ received: true, id: event.id, type: event.type });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
