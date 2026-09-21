"use strict";

/* Stripe subscription webhooks (pre-auth: Stripe cannot send an API key).
 *
 *   POST /api/v1/webhooks/stripe
 *
 * Signature is verified with the Stripe-Signature header, then the event is
 * mapped to a client entitlement (roles/access level) when it identifies one.
 */
const express = require("express");

const { createHttpError } = require("../lib/http-errors");
const stripe = require("../services/stripe-webhook-service");
const { getRuntimeSettingValue } = require("../services/runtime-settings");

const router = express.Router();

router.post("/", (request, response, next) => {
  try {
    let secret = "";
    try {
      secret = String(getRuntimeSettingValue("stripeWebhookSecret") || "").trim();
    } catch (_error) {}

    if (!secret) {
      throw createHttpError(
        503,
        "webhook_not_configured",
        "Set the Stripe webhook signing secret (Admin → Server → Payments) before using this endpoint."
      );
    }

    const rawBody = request.rawBody;
    if (!rawBody || !rawBody.length) {
      throw createHttpError(400, "invalid_webhook", "Webhook body is empty.");
    }

    const verified = stripe.verifyStripeSignature({
      rawBody,
      header: request.headers["stripe-signature"],
      secret
    });
    if (!verified) {
      throw createHttpError(401, "invalid_signature", "Stripe signature did not verify.");
    }

    const event = stripe.normalizeStripeEvent(request.body || {});
    const result = stripe.applyStripeEvent(event);
    const record = stripe.recordStripeEvent({ ...event, ...result });

    response.status(202).apiSuccess({
      received: true,
      id: record.id,
      type: record.type,
      granted: record.granted,
      revoked: record.revoked
    });
  } catch (error) {
    next(error);
  }
});

module.exports = router;
