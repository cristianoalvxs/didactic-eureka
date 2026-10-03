import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import jwt from '@fastify/jwt';
import rateLimit from '@fastify/rate-limit';
import { Environment, SignedDataVerifier } from '@apple/app-store-server-library';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHmac } from 'node:crypto';
import { promisify } from 'node:util';
import { readFileSync } from 'node:fs';
import { LicenseStore, type Provider, type SubscriptionStatus } from './store.js';

const scrypt = promisify(scryptCallback);
type Env = Record<string, string | undefined>;
type ServerOptions = { env?: Env; store?: LicenseStore; fetch?: typeof fetch };
type JwtUser = { sub: string };
type MpPreapproval = {
  id: string;
  status: string;
  external_reference?: string;
  next_payment_date?: string;
  auto_recurring?: { frequency?: number; frequency_type?: string };
};

function requiredEnv(env: Env, key: string): string {
  const value = env[key]?.trim();
  if (!value) throw new Error(`Missing required environment variable: ${key}`);
  return value;
}

function parsePrice(env: Env, key: string): number {
  const value = Number(env[key]);
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${key} must be a positive BRL amount`);
  return value;
}

function validEmail(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function dateMillis(value?: string): number | null {
  if (!value) return null;
  const result = Date.parse(value);
  return Number.isFinite(result) ? result : null;
}

function verifyMercadoPagoSignature(
  secret: string,
  signature: string | undefined,
  requestId: string | undefined,
  dataId: string | undefined,
): boolean {
  if (!signature || !requestId || !dataId) return false;
  const parts = Object.fromEntries(signature.split(',').map(part => {
    const separator = part.indexOf('=');
    return separator < 0 ? [part, ''] : [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }));
  if (!parts.ts || !parts.v1) return false;
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${parts.ts};`;
  const expected = createHmac('sha256', secret).update(manifest).digest();
  let received: Buffer;
  try { received = Buffer.from(parts.v1, 'hex'); } catch { return false; }
  return received.length === expected.length && timingSafeEqual(received, expected);
}

function mapMercadoPagoStatus(status: string): SubscriptionStatus {
  switch (status) {
    case 'authorized': return 'active';
    case 'pending': return 'pending';
    case 'paused': return 'paused';
    case 'cancelled': return 'cancelled';
    default: return 'expired';
  }
}

function appleVerifier(env: Env): SignedDataVerifier {
  const paths = requiredEnv(env, 'APPLE_ROOT_CERT_PATHS').split(',').map(path => path.trim()).filter(Boolean);
  const certificates = paths.map(path => readFileSync(path));
  if (certificates.length === 0) throw new Error('At least one Apple Root CA certificate is required');
  const bundleId = requiredEnv(env, 'APPLE_BUNDLE_ID');
  const environment = env.APPLE_ENVIRONMENT === 'Sandbox' ? Environment.SANDBOX : Environment.PRODUCTION;
  const appAppleId = env.APPLE_APP_ID ? Number(env.APPLE_APP_ID) : undefined;
  if (environment === Environment.PRODUCTION && !Number.isInteger(appAppleId)) {
    throw new Error('APPLE_APP_ID is required for production verification');
  }
  return new SignedDataVerifier(certificates, true, environment, bundleId, appAppleId);
}

function appleProductCode(env: Env, productId: string): string | null {
  const monthly = (env.APPLE_MONTHLY_PRODUCT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  const annual = (env.APPLE_ANNUAL_PRODUCT_IDS ?? '').split(',').map(value => value.trim()).filter(Boolean);
  if (monthly.includes(productId)) return 'pro_monthly';
  if (annual.includes(productId)) return 'pro_annual';
  return null;
}

function entitlementForApplePayload(payload: {
  productId?: string;
  bundleId?: string;
  appAccountToken?: string;
  originalTransactionId?: string;
  expiresDate?: number;
  revocationDate?: number;
}, env: Env, expectedToken?: string): { externalId: string; userToken: string; planCode: string; status: SubscriptionStatus; expiresAt: number | null } | null {
  const productId = payload.productId;
  const planCode = productId ? appleProductCode(env, productId) : null;
  const userToken = payload.appAccountToken?.toLowerCase();
  const expiresAt = typeof payload.expiresDate === 'number' ? payload.expiresDate : null;
  if (payload.bundleId !== env.APPLE_BUNDLE_ID || !planCode || !userToken || !payload.originalTransactionId) return null;
  if (expectedToken && userToken !== expectedToken.toLowerCase()) return null;
  const active = !payload.revocationDate && (expiresAt === null || expiresAt > Date.now());
  return {
    externalId: payload.originalTransactionId,
    userToken,
    planCode,
    status: active ? 'active' : payload.revocationDate ? 'refunded' : 'expired',
    expiresAt,
  };
}

export function buildServer(options: ServerOptions = {}): FastifyInstance {
  const env = options.env ?? process.env;
  const jwtSecret = requiredEnv(env, 'JWT_SECRET');
  if (Buffer.byteLength(jwtSecret) < 32) throw new Error('JWT_SECRET must contain at least 32 bytes');
  const store = options.store ?? new LicenseStore(env.DATABASE_PATH ?? './data/licenses.sqlite');
  const requestFetch = options.fetch ?? fetch;
  const app = Fastify({ logger: true, bodyLimit: 32 * 1024 });
  app.register(jwt, { secret: jwtSecret, sign: { expiresIn: '14d' } });
  app.register(rateLimit, { max: 120, timeWindow: '1 minute' });

  const authenticate = async (request: FastifyRequest, reply: FastifyReply) => {
    try { await request.jwtVerify(); }
    catch { return reply.code(401).send({ error: 'authentication_required' }); }
  };

  app.get('/health', async () => ({ status: 'ok' }));

  app.post<{ Body: { email?: unknown; password?: unknown } }>('/v1/auth/register', {
    config: { rateLimit: { max: 5, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = request.body?.password;
    if (!validEmail(email) || typeof password !== 'string' || password.length < 10 || password.length > 128) {
      return reply.code(400).send({ error: 'invalid_input', message: 'Informe um e-mail válido e uma senha de 10 a 128 caracteres.' });
    }
    const salt = randomBytes(16).toString('hex');
    const passwordHash = (await scrypt(password, salt, 64)) as Buffer;
    try {
      const user = store.createUser(email, salt, passwordHash.toString('hex'));
      const token = app.jwt.sign({ sub: user.id });
      return reply.code(201).send({ token, user: { id: user.id, email: user.email, appAccountToken: user.appAccountToken }, entitlement: store.entitlement(user.id) });
    } catch (error) {
      if (error instanceof Error && error.message.includes('UNIQUE')) return reply.code(409).send({ error: 'email_already_registered' });
      throw error;
    }
  });

  app.post<{ Body: { email?: unknown; password?: unknown } }>('/v1/auth/login', {
    config: { rateLimit: { max: 8, timeWindow: '1 minute' } },
  }, async (request, reply) => {
    const email = typeof request.body?.email === 'string' ? request.body.email.trim().toLowerCase() : '';
    const password = request.body?.password;
    if (!validEmail(email) || typeof password !== 'string') return reply.code(401).send({ error: 'invalid_credentials' });
    const user = store.findUserByEmail(email);
    const salt = user?.passwordSalt ?? '00000000000000000000000000000000';
    const expectedHash = user?.passwordHash ?? Buffer.alloc(64).toString('hex');
    const actualHash = (await scrypt(password, salt, 64)) as Buffer;
    const expected = Buffer.from(expectedHash, 'hex');
    if (!user || expected.length !== actualHash.length || !timingSafeEqual(expected, actualHash)) {
      return reply.code(401).send({ error: 'invalid_credentials' });
    }
    return { token: app.jwt.sign({ sub: user.id }), user: { id: user.id, email: user.email, appAccountToken: user.appAccountToken }, entitlement: store.entitlement(user.id) };
  });

  app.get('/v1/me', { preHandler: authenticate }, async (request: any, reply) => {
    const user = store.findUserById(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'account_not_found' });
    return { user: { id: user.id, email: user.email, appAccountToken: user.appAccountToken }, entitlement: store.entitlement(user.id) };
  });

  app.post<{ Body: { plan?: unknown } }>('/v1/billing/mercadopago/checkout', { preHandler: authenticate }, async (request: any, reply) => {
    const user = store.findUserById(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'account_not_found' });
    const plan = request.body?.plan;
    if (plan !== 'monthly' && plan !== 'annual') return reply.code(400).send({ error: 'invalid_plan' });
    const accessToken = env.MP_ACCESS_TOKEN;
    const baseUrl = env.PUBLIC_BASE_URL;
    if (!accessToken || !baseUrl || !env.MP_WEBHOOK_SECRET) return reply.code(503).send({ error: 'mercadopago_not_configured' });
    const price = parsePrice(env, plan === 'monthly' ? 'MP_MONTHLY_PRICE_BRL' : 'MP_ANNUAL_PRICE_BRL');
    const frequency = plan === 'monthly' ? 1 : 12;
    const response = await requestFetch('https://api.mercadopago.com/preapproval', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${accessToken}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': randomBytes(16).toString('hex'),
      },
      body: JSON.stringify({
        reason: 'Acesso Pro - quatro sessões',
        external_reference: user.id,
        payer_email: user.email,
        back_url: `${baseUrl.replace(/\/$/, '')}/billing/return`,
        auto_recurring: { frequency, frequency_type: 'months', transaction_amount: price, currency_id: 'BRL' },
        status: 'pending',
        notification_url: `${baseUrl.replace(/\/$/, '')}/v1/webhooks/mercadopago`,
      }),
    });
    const data = await response.json() as { id?: string; init_point?: string; message?: string };
    if (!response.ok || !data.id || !data.init_point) {
      request.log.error({ status: response.status, message: data.message }, 'Mercado Pago subscription creation failed');
      return reply.code(502).send({ error: 'checkout_creation_failed' });
    }
    store.upsertSubscription({ provider: 'mercadopago', externalId: data.id, userId: user.id, status: 'pending', planCode: `pro_${plan}`, expiresAt: null });
    return { checkoutUrl: data.init_point, subscriptionId: data.id, plan: `pro_${plan}`, amountBrl: price };
  });

  app.post<{ Querystring: { 'data.id'?: string; id?: string }; Body: { id?: string | number; date_created?: string; type?: string; action?: string; data?: { id?: string } } }>(
    '/v1/webhooks/mercadopago', async (request, reply) => {
      const dataId = request.query['data.id'] ?? request.query.id ?? request.body?.data?.id;
      const signatureHeader = request.headers['x-signature'];
      const requestId = request.headers['x-request-id'];
      const signatureValue = Array.isArray(signatureHeader) ? signatureHeader[0] : signatureHeader;
      const requestIdValue = Array.isArray(requestId) ? requestId[0] : requestId;
      if (!verifyMercadoPagoSignature(env.MP_WEBHOOK_SECRET ?? '', signatureValue, requestIdValue, dataId)) {
        return reply.code(401).send({ error: 'invalid_webhook_signature' });
      }
      if (request.body?.type !== 'subscription_preapproval' || !dataId) return reply.code(200).send({ received: true, ignored: true });
      const eventId = String(request.body.id ?? `${request.body.action ?? 'updated'}:${dataId}:${request.body.date_created ?? Date.now()}`);
      if (store.hasWebhookEvent('mercadopago', eventId)) return reply.code(200).send({ received: true, duplicate: true });
      if (!env.MP_ACCESS_TOKEN) return reply.code(503).send({ error: 'mercadopago_not_configured' });
      const response = await requestFetch(`https://api.mercadopago.com/preapproval/${encodeURIComponent(dataId)}`, {
        headers: { Authorization: `Bearer ${env.MP_ACCESS_TOKEN}` },
      });
      if (!response.ok) return reply.code(502).send({ error: 'subscription_verification_failed' });
      const subscription = await response.json() as MpPreapproval;
      const user = subscription.external_reference ? store.findUserById(subscription.external_reference) : undefined;
      if (!user || subscription.id !== dataId) return reply.code(200).send({ received: true, ignored: true });
      const status = mapMercadoPagoStatus(subscription.status);
      const expiresAt = status === 'cancelled' ? dateMillis(subscription.next_payment_date) : null;
      const plan = subscription.auto_recurring?.frequency_type === 'months' && subscription.auto_recurring.frequency === 12 ? 'pro_annual' : 'pro_monthly';
      store.upsertSubscription({ provider: 'mercadopago', externalId: subscription.id, userId: user.id, status, planCode: plan, expiresAt });
      store.recordWebhookEvent('mercadopago', eventId);
      return reply.code(200).send({ received: true });
    },
  );

  app.post<{ Body: { signedTransaction?: unknown } }>('/v1/apple/transaction', { preHandler: authenticate }, async (request: any, reply) => {
    const user = store.findUserById(request.user.sub);
    if (!user) return reply.code(401).send({ error: 'account_not_found' });
    if (typeof request.body?.signedTransaction !== 'string') return reply.code(400).send({ error: 'signed_transaction_required' });
    let verifier: SignedDataVerifier;
    try { verifier = appleVerifier(env); }
    catch { return reply.code(503).send({ error: 'apple_purchase_verification_not_configured' }); }
    try {
      const transaction = await verifier.verifyAndDecodeTransaction(request.body.signedTransaction);
      const verified = entitlementForApplePayload(transaction, env, user.appAccountToken);
      if (!verified) return reply.code(400).send({ error: 'transaction_not_for_this_account_or_product' });
      store.upsertSubscription({ provider: 'apple', externalId: verified.externalId, userId: user.id, status: verified.status, planCode: verified.planCode, expiresAt: verified.expiresAt });
      return { entitlement: store.entitlement(user.id) };
    } catch {
      return reply.code(400).send({ error: 'invalid_signed_transaction' });
    }
  });

  app.post<{ Body: { signedPayload?: unknown } }>('/v1/webhooks/apple', async (request, reply) => {
    if (typeof request.body?.signedPayload !== 'string') return reply.code(400).send({ error: 'signed_payload_required' });
    let verifier: SignedDataVerifier;
    try { verifier = appleVerifier(env); }
    catch { return reply.code(503).send({ error: 'apple_notifications_not_configured' }); }
    try {
      const notification = await verifier.verifyAndDecodeNotification(request.body.signedPayload);
      const eventId = notification.notificationUUID;
      if (!eventId) return reply.code(400).send({ error: 'notification_id_missing' });
      if (store.hasWebhookEvent('apple', eventId)) return reply.code(200).send({ received: true, duplicate: true });
      const signedTransaction = notification.data?.signedTransactionInfo;
      if (signedTransaction) {
        const transaction = await verifier.verifyAndDecodeTransaction(signedTransaction);
        const verified = entitlementForApplePayload(transaction, env);
        if (verified) {
          const user = store.findUserByAppAccountToken(verified.userToken);
          if (user) {
            const revoked = notification.notificationType === 'REFUND' || notification.notificationType === 'REVOKE';
            const status: SubscriptionStatus = revoked ? 'refunded' : verified.status;
            store.upsertSubscription({ provider: 'apple', externalId: verified.externalId, userId: user.id, status, planCode: verified.planCode, expiresAt: verified.expiresAt });
          }
        }
      }
      store.recordWebhookEvent('apple', eventId);
      return reply.code(200).send({ received: true });
    } catch (error) {
      request.log.warn({ error }, 'Rejected Apple server notification');
      return reply.code(400).send({ error: 'invalid_signed_payload' });
    }
  });

  app.addHook('onClose', async () => {
    if (!options.store) store.close();
  });
  return app;
}
