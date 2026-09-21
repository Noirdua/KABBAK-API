/* stripe-webhook-service.js — Stripe subscription webhooks.
 *
 * Stripe signs webhooks with `Stripe-Signature: t=<unix>,v1=<hex>…`:
 *   signed content = "<t>.<raw body>"
 *   signature      = hex(HMAC-SHA256(webhook secret, content))
 *
 * How a payment becomes an entitlement:
 *   1. Find the target client — `metadata.clientId` (recommended) or
 *      `client_reference_id` on checkout sessions, else the client already
 *      linked to that Stripe customer from a previous event.
 *   2. Find the tier — `metadata.roles` if the operator sets it, otherwise the
 *      tier whose `price.providerPlanId` matches the subscription price id.
 *   3. Active subscription: ensure those roles are on the client and apply the
 *      tier's access level (remembering the previous one).
 *      Canceled/unpaid: remove exactly the roles we granted and restore the
 *      previous access level.
 *
 * The subscription record on the client is the source of truth for revocation,
 * so the mapped tier roles belong to the subscription — do not also assign them
 * by hand.
 */
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const { storageConfigRoot } = require("../config/paths");
const {
  readManagedApiClients,
  upsertManagedApiClient
} = require("./api-client-registry");
const { listRoleDefinitions } = require("./api-roles");

const EVENTS_PATH = process.env.KABBAK_STRIPE_EVENTS_PATH
  ? path.resolve(String(process.env.KABBAK_STRIPE_EVENTS_PATH))
  : path.join(storageConfigRoot, "stripe-events.json");
const MAX_EVENTS = 200;
const SIGNATURE_TOLERANCE_SECONDS = 5 * 60;

const ACTIVE_SUBSCRIPTION_STATUSES = new Set(["active", "trialing"]);
const INACTIVE_SUBSCRIPTION_STATUSES = new Set(["canceled", "unpaid", "incomplete_expired", "paused"]);

function readEvents() {
  try {
    const parsed = JSON.parse(fs.readFileSync(EVENTS_PATH, "utf8"));
    return Array.isArray(parsed) ? parsed : [];
  } catch (_error) {
    return [];
  }
}

function writeEvents(events) {
  fs.mkdirSync(path.dirname(EVENTS_PATH), { recursive: true });
  fs.writeFileSync(EVENTS_PATH, `${JSON.stringify(events, null, 2)}\n`, "utf8");
}

function recordStripeEvent(event = {}) {
  const record = {
    id: crypto.randomUUID(),
    receivedAt: new Date().toISOString(),
    type: String(event.type || "unknown").slice(0, 80),
    status: String(event.status || "").slice(0, 40),
    clientId: String(event.clientId || "").slice(0, 120),
    customerId: String(event.customerId || "").slice(0, 200),
    subscriptionId: String(event.subscriptionId || "").slice(0, 200),
    priceId: String(event.priceId || "").slice(0, 200),
    granted: Array.isArray(event.granted) ? event.granted.slice(0, 20) : [],
    revoked: Array.isArray(event.revoked) ? event.revoked.slice(0, 20) : [],
    note: String(event.note || "").slice(0, 300)
  };
  const events = readEvents();
  events.unshift(record);
  writeEvents(events.slice(0, MAX_EVENTS));
  return record;
}

function listStripeEvents(limit = 50) {
  const capped = Math.min(MAX_EVENTS, Math.max(1, Number(limit) || 50));
  return readEvents().slice(0, capped);
}

function timingSafeEqual(a, b) {
  const left = Buffer.from(String(a || ""));
  const right = Buffer.from(String(b || ""));
  if (left.length !== right.length || left.length === 0) {
    return false;
  }
  return crypto.timingSafeEqual(left, right);
}

// Verifies the `Stripe-Signature` header over the exact request body.
function verifyStripeSignature({ rawBody, header, secret, nowMs = Date.now(), toleranceSeconds = SIGNATURE_TOLERANCE_SECONDS } = {}) {
  const signatureHeader = String(header || "").trim();
  const key = String(secret || "").trim();
  const body = Buffer.isBuffer(rawBody) ? rawBody : Buffer.from(String(rawBody || ""));
  if (!signatureHeader || !key || !body.length) {
    return false;
  }

  let timestamp = "";
  const signatures = [];
  signatureHeader.split(",").forEach((part) => {
    const [name, value] = part.split("=").map((entry) => String(entry || "").trim());
    if (name === "t" && value) timestamp = value;
    if (name === "v1" && value) signatures.push(value);
  });
  if (!timestamp || !signatures.length) {
    return false;
  }

  const timestampSeconds = Number(timestamp);
  if (!Number.isFinite(timestampSeconds)) {
    return false;
  }
  if (Math.abs(nowMs / 1000 - timestampSeconds) > Number(toleranceSeconds || SIGNATURE_TOLERANCE_SECONDS)) {
    return false;
  }

  const expected = crypto
    .createHmac("sha256", key)
    .update(`${timestamp}.${body.toString("utf8")}`)
    .digest("hex");
  return signatures.some((value) => timingSafeEqual(value, expected));
}

function firstPriceId(object = {}) {
  const items = Array.isArray(object?.items?.data) ? object.items.data : [];
  const price = items[0]?.price || object?.plan || null;
  return String(price?.id || price?.price || "").trim();
}

function rolesFromMetadata(metadata = {}) {
  return String(metadata?.roles || metadata?.kabbakRoles || "")
    .split(/[\s,;]+/)
    .map((role) => role.trim())
    .filter(Boolean);
}

// Maps a Stripe event to the fields the entitlement logic needs.
function normalizeStripeEvent(payload = {}) {
  const type = String(payload?.type || "").trim();
  const object = payload?.data?.object && typeof payload.data.object === "object" ? payload.data.object : {};
  const metadata = object.metadata && typeof object.metadata === "object" ? object.metadata : {};
  const subscriptionId = type.startsWith("customer.subscription")
    ? String(object.id || "")
    : String(object.subscription || "");
  const currentPeriodEnd = Number.isFinite(Number(object.current_period_end))
    ? new Date(Number(object.current_period_end) * 1000).toISOString()
    : "";

  let active = null;
  if (type === "customer.subscription.created" || type === "customer.subscription.updated") {
    const status = String(object.status || "");
    active = ACTIVE_SUBSCRIPTION_STATUSES.has(status)
      ? true
      : (INACTIVE_SUBSCRIPTION_STATUSES.has(status) ? false : null);
  } else if (type === "customer.subscription.deleted") {
    active = false;
  } else if (type === "invoice.paid") {
    active = true;
  } else if (type === "checkout.session.completed") {
    const paymentStatus = String(object.payment_status || "");
    active = ["paid", "no_payment_required"].includes(paymentStatus);
  }

  return {
    type,
    active,
    status: String(object.status || object.payment_status || ""),
    clientId: String(metadata.clientId || object.client_reference_id || "").trim(),
    customerId: String(object.customer || "").trim(),
    subscriptionId,
    priceId: firstPriceId(object),
    roles: rolesFromMetadata(metadata),
    currentPeriodEnd
  };
}

function rolesForPrice(priceId) {
  const id = String(priceId || "").trim();
  if (!id) {
    return null;
  }
  const tier = listRoleDefinitions().find((role) => String(role?.price?.providerPlanId || "").trim() === id) || null;
  return tier ? { tier, roles: [tier.id] } : null;
}

// Applies a normalized event to the target client. Returns the recorded event
// fields (granted/revoked/note) for the event log.
function applyStripeEvent(event = {}, { options = {} } = {}) {
  const clients = readManagedApiClients(options);
  let target = event.clientId
    ? clients.find((client) => client.id === event.clientId) || null
    : null;
  if (!target && event.customerId) {
    target = clients.find((client) => client.subscription?.customerId === event.customerId) || null;
  }
  if (!target) {
    return { note: "no matching client", granted: [], revoked: [] };
  }
  if (event.active === null) {
    return { note: "event does not change access", granted: [], revoked: [] };
  }

  const mapped = event.roles.length
    ? { tier: null, roles: event.roles }
    : rolesForPrice(event.priceId);
  const mappedRoles = mapped?.roles || [];
  const tier = mapped?.tier || null;

  const currentRoles = Array.isArray(target.roles) ? target.roles : [];
  const previous = target.subscription || null;

  if (event.active) {
    const roles = Array.from(new Set([...currentRoles, ...mappedRoles]));
    const nextAccessLevel = tier?.accessLevel || target.accessLevel;
    upsertManagedApiClient({
      ...target,
      roles,
      accessLevel: nextAccessLevel,
      // Remember what to restore, but only the first time this subscription
      // takes over the roles/level.
      subscription: {
        provider: "stripe",
        status: event.status,
        customerId: event.customerId,
        subscriptionId: event.subscriptionId,
        priceId: event.priceId,
        currentPeriodEnd: event.currentPeriodEnd,
        updatedAt: new Date().toISOString(),
        grantedRoles: mappedRoles,
        previousAccessLevel: previous?.previousAccessLevel
          || (tier?.accessLevel && tier.accessLevel !== target.accessLevel ? target.accessLevel : "")
      }
    }, options);
    return { granted: mappedRoles, revoked: [], note: tier ? `tier ${tier.id}` : "" };
  }

  const grantedRoles = Array.isArray(previous?.grantedRoles) ? previous.grantedRoles : [];
  const roles = currentRoles.filter((role) => !grantedRoles.includes(role));
  const restoredAccessLevel = previous?.previousAccessLevel || target.accessLevel;
  upsertManagedApiClient({
    ...target,
    roles,
    accessLevel: restoredAccessLevel || target.accessLevel,
    subscription: {
      provider: "stripe",
      status: event.status || "canceled",
      customerId: event.customerId,
      subscriptionId: event.subscriptionId,
      priceId: event.priceId,
      currentPeriodEnd: event.currentPeriodEnd,
      updatedAt: new Date().toISOString(),
      grantedRoles: [],
      previousAccessLevel: ""
    }
  }, options);
  return { granted: [], revoked: grantedRoles, note: "subscription inactive" };
}

module.exports = {
  ACTIVE_SUBSCRIPTION_STATUSES,
  EVENTS_PATH,
  INACTIVE_SUBSCRIPTION_STATUSES,
  MAX_EVENTS,
  SIGNATURE_TOLERANCE_SECONDS,
  applyStripeEvent,
  listStripeEvents,
  normalizeStripeEvent,
  recordStripeEvent,
  rolesForPrice,
  verifyStripeSignature
};
