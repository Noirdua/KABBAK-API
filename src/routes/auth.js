/* Public trial-account routes. Mounted pre-auth (before requireApiKey) so the
 * signup form works from the connection gate, with its own rate limiter. */
const express = require("express");

const { apiBasePath } = require("../config/service");
const { createHttpError } = require("../lib/http-errors");
const accounts = require("../services/account-service");
const captcha = require("../services/captcha-service");
const mail = require("../services/mail-service");

function buildVerifyLink(request, token) {
  // Admin panel value wins so the public base can be fixed without a restart.
  const runtime = require("../services/runtime-settings").getRuntimeSettingValue("publicApiUrl");
  const configured = String(runtime || process.env.KABBAK_PUBLIC_API_URL || "").trim().replace(/\/+$/, "");
  // Accept either the host (https://api.example.com) or the full base with
  // /api/v1, so operators do not have to remember which one this expects.
  let base = configured || `${request.protocol}://${request.get("host")}`;
  if (!base.endsWith(apiBasePath)) {
    base = `${base}${apiBasePath}`;
  }
  return `${base}/auth/verify?token=${encodeURIComponent(token)}`;
}

function verificationPage({ ok, message }) {
  const title = ok ? "Email verified" : "Verification failed";
  const tone = ok ? "#4ade80" : "#fca5a5";
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} — KABBAK</title>
<style>
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0a0a10; color: #f4f4f5;
         font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; padding: 24px; }
  .card { max-width: 420px; text-align: center; }
  h1 { color: ${tone}; font-size: 22px; margin: 0 0 10px; }
  p { color: #a1a1aa; line-height: 1.6; margin: 0; }
</style></head>
<body><div class="card"><h1>${title}</h1><p>${message}</p></div></body></html>`;
}

function createAuthRoutes() {
  const router = express.Router();

  router.get("/providers", (request, response) => {
    const policy = accounts.getTrialPolicy();
    const emailConfigured = mail.isMailConfigured();
    const devFallback = mail.isDevFallbackEnabled();
    // Signup, verify, and forgot-password all need a way to deliver a code, so
    // they are only offered when email works (or the dev fallback returns it).
    const emailAvailable = emailConfigured || devFallback;
    response.apiSuccess({
      providers: { password: true, google: false, apple: false },
      signupEnabled: accounts.isSignupEnabled() && emailAvailable,
      signupPolicyEnabled: accounts.isSignupEnabled(),
      emailConfigured,
      emailAvailable,
      trialDays: policy.days,
      trialAccessLevel: policy.accessLevel,
      captcha: { enabled: true, choices: 4, ttlSeconds: Math.round(captcha.CHALLENGE_TTL_MS / 1000) },
      emailVerification: {
        required: emailAvailable,
        configured: emailConfigured,
        devFallback
      },
      passwordReset: emailAvailable
    });
  });

  router.post("/challenge", (request, response) => {
    const challenge = captcha.createChallenge();
    response.apiSuccess({
      challengeId: challenge.id,
      prompt: challenge.prompt,
      choices: challenge.choices,
      token: challenge.token,
      expiresAt: challenge.expiresAt
    });
  });

  router.post("/signup", async (request, response, next) => {
    try {
      if (!accounts.isSignupEnabled()) {
        throw createHttpError(403, "signup_disabled", "New trial accounts are not available right now.");
      }
      if (!mail.isMailConfigured() && !mail.isDevFallbackEnabled()) {
        throw createHttpError(
          403,
          "email_not_configured",
          "Email is not configured on this server, so trial signup is unavailable. Ask the operator to set it up in Admin → Server."
        );
      }

      const captchaOk = captcha.verifyChallenge({
        token: request.body?.captchaToken,
        answer: request.body?.captchaAnswer
      });
      if (!captchaOk) {
        throw createHttpError(400, "captcha_failed", "That captcha answer was not correct. Try the new challenge.");
      }

      const result = accounts.signUp({
        username: request.body?.username,
        email: request.body?.email,
        password: request.body?.password
      });

      const token = accounts.createVerificationLinkToken(result.account.id);
      const link = buildVerifyLink(request, token);
      const delivered = await mail.sendMail({
        to: result.email,
        subject: "Verify your KABBAK account",
        text: [
          `Hi ${result.account.username},`,
          "",
          `Your KABBAK verification code is ${result.code}. It expires in 30 minutes.`,
          "",
          `Or open this link to verify: ${link}`,
          "",
          "If you did not create this account, you can ignore this message."
        ].join("\n"),
        html: `<p>Hi <strong>${result.account.username}</strong>,</p>
<p>Your KABBAK verification code is <strong style="font-size:20px;letter-spacing:2px">${result.code}</strong>. It expires in 30 minutes.</p>
<p>Or <a href="${link}">open this link to verify</a>.</p>
<p>If you did not create this account, you can ignore this message.</p>`
      });

      const devFallback = mail.isDevFallbackEnabled();
      response.status(201).apiSuccess({
        account: result.account,
        verificationRequired: true,
        expiresAt: result.expiresAt,
        emailDelivered: delivered.delivered,
        ...(delivered.delivered
          ? {}
          : {
              emailConfigured: mail.isMailConfigured(),
              emailReason: delivered.reason || "send_failed",
              ...(Number.isFinite(delivered.status) ? { emailStatus: delivered.status } : {})
            }),
        ...(devFallback ? { devCode: result.code } : {})
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/login", (request, response, next) => {
    try {
      const result = accounts.login({
        username: request.body?.username,
        password: request.body?.password
      });
      response.apiSuccess(accounts.trialPayload(result));
    } catch (error) {
      next(error);
    }
  });

  router.post("/resend", async (request, response, next) => {
    try {
      if (!mail.isMailConfigured() && !mail.isDevFallbackEnabled()) {
        throw createHttpError(403, "email_not_configured", "Email is not configured on this server, so codes cannot be sent.");
      }
      const result = accounts.resendVerification({ username: request.body?.username });
      const delivered = await mail.sendMail({
        to: result.account.email || "",
        subject: "Your new KABBAK verification code",
        text: `Your new KABBAK verification code is ${result.code}. It expires in 30 minutes.`
      });

      const devFallback = mail.isDevFallbackEnabled();
      response.apiSuccess({
        account: result.account,
        expiresAt: result.expiresAt,
        emailDelivered: delivered.delivered,
        ...(delivered.delivered
          ? {}
          : {
              emailConfigured: mail.isMailConfigured(),
              emailReason: delivered.reason || "send_failed",
              ...(Number.isFinite(delivered.status) ? { emailStatus: delivered.status } : {})
            }),
        ...(devFallback ? { devCode: result.code } : {})
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/forgot", async (request, response, next) => {
    try {
      if (!mail.isMailConfigured() && !mail.isDevFallbackEnabled()) {
        throw createHttpError(403, "email_not_configured", "Email is not configured on this server, so reset codes cannot be sent.");
      }
      const captchaOk = captcha.verifyChallenge({
        token: request.body?.captchaToken,
        answer: request.body?.captchaAnswer
      });
      if (!captchaOk) {
        throw createHttpError(400, "captcha_failed", "That captcha answer was not correct. Try the new challenge.");
      }

      const result = accounts.requestPasswordReset({ identifier: request.body?.identifier });
      const shouldSend = result.found === true && result.throttled !== true;

      if (shouldSend) {
        await mail.sendMail({
          to: result.email,
          subject: "Reset your KABBAK password",
          text: [
            `Your KABBAK password reset code is ${result.code}. It expires in 30 minutes.`,
            "",
            "If you did not request this, you can ignore this message."
          ].join("\n")
        });
      }

      const devFallback = mail.isDevFallbackEnabled();
      response.apiSuccess({
        sent: true,
        ...(shouldSend && devFallback ? { devCode: result.code } : {})
      });
    } catch (error) {
      next(error);
    }
  });

  router.post("/reset", (request, response, next) => {
    try {
      const result = accounts.resetPassword({
        identifier: request.body?.identifier,
        code: request.body?.code,
        password: request.body?.password
      });

      if (result.trial && result.trial.active) {
        response.apiSuccess(accounts.trialPayload(result));
        return;
      }
      response.apiSuccess({ account: result.account, reset: true });
    } catch (error) {
      next(error);
    }
  });

  router.post("/verify", (request, response, next) => {
    try {
      const result = accounts.verifyEmail({
        username: request.body?.username,
        code: request.body?.code
      });
      response.apiSuccess(accounts.trialPayload(result));
    } catch (error) {
      next(error);
    }
  });

  // Email link: verifies the account and shows a small confirmation page.
  router.get("/verify", (request, response) => {
    try {
      accounts.verifyEmailByToken({ token: request.query?.token });
      response.type("html").send(verificationPage({
        ok: true,
        message: "Your email is verified. Return to KABBAK and sign in to start your trial."
      }));
    } catch (error) {
      response.status(error?.status || 400).type("html").send(verificationPage({
        ok: false,
        message: error?.message || "This verification link is not valid."
      }));
    }
  });

  return router;
}

module.exports = {
  createAuthRoutes
};
