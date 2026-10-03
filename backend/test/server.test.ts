import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { afterEach, test } from 'node:test';
import { buildServer } from '../src/server.js';
import { LicenseStore } from '../src/store.js';

const openApps: Array<{ close: () => Promise<void>; store: LicenseStore }> = [];
const baseEnv = {
  JWT_SECRET: 'test-secret-that-is-at-least-32-bytes-long',
  DATABASE_PATH: ':memory:',
  MP_ACCESS_TOKEN: 'test-mp-token',
  MP_WEBHOOK_SECRET: 'test-mp-webhook-secret',
  PUBLIC_BASE_URL: 'https://licenses.example.test',
  MP_MONTHLY_PRICE_BRL: '10.00',
  MP_ANNUAL_PRICE_BRL: '100.00',
};

async function createApp(fetcher?: typeof fetch) {
  const store = new LicenseStore(':memory:');
  const app = buildServer({ env: baseEnv, store, fetch: fetcher });
  await app.ready();
  openApps.push({ close: () => app.close(), store });
  return { app, store };
}

afterEach(async () => {
  await Promise.all(openApps.splice(0).map(item => item.close()));
});

test('register starts with one free session and login returns the same account', async () => {
  const { app } = await createApp();
  const registration = await app.inject({
    method: 'POST',
    url: '/v1/auth/register',
    payload: { email: 'beta@example.com', password: 'long-enough-password' },
  });
  assert.equal(registration.statusCode, 201);
  const created = registration.json();
  assert.equal(created.entitlement.tier, 'free');
  assert.equal(created.entitlement.maxSlots, 1);
  assert.ok(created.user.appAccountToken);

  const login = await app.inject({
    method: 'POST',
    url: '/v1/auth/login',
    payload: { email: 'BETA@example.com', password: 'long-enough-password' },
  });
  assert.equal(login.statusCode, 200);
  assert.equal(login.json().user.id, created.user.id);
});

test('registration rejects short passwords and duplicate emails', async () => {
  const { app } = await createApp();
  const weak = await app.inject({ method: 'POST', url: '/v1/auth/register', payload: { email: 'a@example.com', password: 'short' } });
  assert.equal(weak.statusCode, 400);
  const payload = { email: 'a@example.com', password: 'long-enough-password' };
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/register', payload })).statusCode, 201);
  assert.equal((await app.inject({ method: 'POST', url: '/v1/auth/register', payload })).statusCode, 409);
});

test('verified Mercado Pago webhook upgrades account only after remote subscription lookup', async () => {
  const remoteSubscription = {
    id: 'mp-sub-456',
    status: 'authorized',
    external_reference: '',
    auto_recurring: { frequency: 1, frequency_type: 'months' },
  };
  const fetcher: typeof fetch = async () => new Response(JSON.stringify(remoteSubscription), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
  const { app } = await createApp(fetcher);
  const registration = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email: 'subscriber@example.com', password: 'long-enough-password' },
  });
  const { token, user, entitlement } = registration.json();
  assert.equal(entitlement.maxSlots, 1);
  remoteSubscription.external_reference = user.id;

  const dataId = remoteSubscription.id;
  const requestId = randomBytes(8).toString('hex');
  const timestamp = String(Math.floor(Date.now() / 1000));
  const manifest = `id:${dataId.toLowerCase()};request-id:${requestId};ts:${timestamp};`;
  const signature = createHmac('sha256', baseEnv.MP_WEBHOOK_SECRET).update(manifest).digest('hex');
  const webhook = await app.inject({
    method: 'POST',
    url: `/v1/webhooks/mercadopago?data.id=${dataId}`,
    headers: { 'x-request-id': requestId, 'x-signature': `ts=${timestamp},v1=${signature}` },
    payload: { id: 8001, type: 'subscription_preapproval', action: 'updated', data: { id: dataId } },
  });
  assert.equal(webhook.statusCode, 200);

  const me = await app.inject({ method: 'GET', url: '/v1/me', headers: { authorization: `Bearer ${token}` } });
  assert.equal(me.statusCode, 200);
  assert.equal(me.json().entitlement.tier, 'pro');
  assert.equal(me.json().entitlement.maxSlots, 4);
});

test('unsigned Mercado Pago webhook is rejected and invalid Apple setup fails closed', async () => {
  const { app } = await createApp();
  const rejected = await app.inject({
    method: 'POST', url: '/v1/webhooks/mercadopago?data.id=forged',
    payload: { type: 'subscription_preapproval', data: { id: 'forged' } },
  });
  assert.equal(rejected.statusCode, 401);

  const registration = await app.inject({
    method: 'POST', url: '/v1/auth/register',
    payload: { email: 'apple@example.com', password: 'long-enough-password' },
  });
  const response = await app.inject({
    method: 'POST', url: '/v1/apple/transaction',
    headers: { authorization: `Bearer ${registration.json().token}` },
    payload: { signedTransaction: 'not-a-real-jws' },
  });
  assert.equal(response.statusCode, 503);
});
