import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import crypto from 'node:crypto';
import { createClient } from '@supabase/supabase-js';

const required = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'CASHFREE_APP_ID', 'CASHFREE_SECRET_KEY'];
for (const key of required) if (!process.env[key]) throw new Error(`Missing required environment variable: ${key}`);
const app = express();
app.disable('x-powered-by');
app.use(helmet());
const allowedOrigins = (process.env.ALLOWED_ORIGINS || '').split(',').map(x => x.trim()).filter(Boolean);
app.use(cors({ origin: (origin, cb) => (!origin || allowedOrigins.length === 0 || allowedOrigins.includes(origin)) ? cb(null, true) : cb(new Error('Origin not allowed')) }));
app.use('/api/cashfree/webhook', express.raw({ type: 'application/json', limit: '256kb' }));
app.use(express.json({ limit: '32kb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false }));
const db = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY, { auth: { persistSession: false, autoRefreshToken: false } });
const production = process.env.CASHFREE_ENV === 'PRODUCTION';
const cfBase = production ? 'https://api.cashfree.com/pg' : 'https://sandbox.cashfree.com/pg';
const cfVersion = process.env.CASHFREE_API_VERSION || '2025-01-01';
const plans = {
  gold: { name: 'Gold', amount: Number(process.env.MI_GOLD_AMOUNT ?? 599) },
  silver: { name: 'Silver', amount: Number(process.env.MI_SILVER_AMOUNT ?? 199) },
  junior: { name: 'Junior', amount: Number(process.env.MI_JUNIOR_AMOUNT ?? 399) },
  blue: { name: 'Blue', amount: Number(process.env.MI_BLUE_AMOUNT ?? 49) },
};
const cfHeaders = () => ({ 'Content-Type': 'application/json', 'x-client-id': process.env.CASHFREE_APP_ID, 'x-client-secret': process.env.CASHFREE_SECRET_KEY, 'x-api-version': cfVersion });
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const safeEqual = (a, b) => { const aa = Buffer.from(String(a)); const bb = Buffer.from(String(b)); return aa.length === bb.length && crypto.timingSafeEqual(aa, bb); };
const fail = (res, status, message) => res.status(status).json({ message });
function parseDob(value) {
  const s = String(value || '').trim();
  let m = /^(\d{2})-(\d{2})-(\d{4})$/.exec(s);
  if (m) return `${m[3]}-${m[2]}-${m[1]}`;
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  throw new Error('Date of birth must be DD-MM-YYYY');
}
function validateCustomer(body, planId) {
  if (body.consentAccepted !== true) throw new Error('Please accept the membership terms and privacy policy.');
  const c = body.customer || body;
  const name = String(c.name || '').trim(), email = String(c.email || '').trim().toLowerCase();
  const phone = String(c.phone || '').replace(/\s/g, '');
  if (!name || !email || !phone || !c.address || !c.city || !c.state || !c.pinCode) throw new Error('Please complete all required customer fields.');
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) throw new Error('Invalid email address.');
  if (!/^[6-9]\d{9}$/.test(phone)) throw new Error('Enter a valid 10-digit Indian mobile number.');
  if (!/^[1-9]\d{5}$/.test(String(c.pinCode))) throw new Error('Enter a valid PIN code.');
  const guardianName = String(c.guardianName || '').trim();
  const guardianPhone = String(c.guardianPhone || '').trim();
  if (planId === 'junior' && (!guardianName || !/^[6-9]\d{9}$/.test(guardianPhone))) throw new Error('Valid parent/guardian details are required for Junior membership.');
  return { name, email, phone, dob: parseDob(c.dateOfBirth || c.dob), gender: c.gender || null, address: String(c.address).trim(), city: String(c.city).trim(), state: String(c.state).trim(), pin: String(c.pinCode), guardianName: guardianName || null, guardianPhone: guardianPhone || null };
}
async function upsertCustomer(c) {
  const { data: byEmail, error: emailError } = await db.from('customer_profiles').select('id').eq('email', c.email).maybeSingle();
  if (emailError) throw emailError;
  const { data: byPhone, error: phoneError } = byEmail ? { data: null, error: null } : await db.from('customer_profiles').select('id').eq('mobile_number', c.phone).maybeSingle();
  if (phoneError) throw phoneError;
  const existing = byEmail || byPhone;
  const row = { full_name: c.name, email: c.email, mobile_number: c.phone, date_of_birth: c.dob, gender: c.gender, address: c.address, city: c.city, state: c.state, pincode: c.pin };
  if (existing) {
    const { data, error } = await db.from('customer_profiles').update(row).eq('id', existing.id).select('id').single();
    if (error) throw error;
    return data.id;
  }
  const { data, error } = await db.from('customer_profiles').insert(row).select('id').single();
  if (error) throw error;
  return data.id;
}
async function cashfreeOrder(orderId) {
  const r = await fetch(`${cfBase}/orders/${encodeURIComponent(orderId)}`, { headers: cfHeaders() });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.message || `Cashfree order lookup failed (${r.status})`);
  return data;
}
async function activatePaidOrder(orderId, paymentReference = null) {
  const order = await cashfreeOrder(orderId);
  if (order.order_status !== 'PAID') return { paid: false, status: order.order_status || 'PENDING' };
  const { data: enrollment, error } = await db.from('membership_enrollments').select('id,membership_id,payment_status').eq('cashfree_order_id', orderId).maybeSingle();
  if (error) throw error;
  if (!enrollment) throw new Error('Enrollment for this Cashfree order was not found.');
  if (enrollment.payment_status === 'PAID') return { paid: true, membershipId: enrollment.membership_id, alreadyVerified: true };
  const membershipId = `MI-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
  const { data: updated, error: updateError } = await db.from('membership_enrollments').update({ payment_status: 'PAID', membership_status: 'ACTIVE', membership_id: membershipId, payment_reference: paymentReference || order.cf_order_id || orderId }).eq('id', enrollment.id).eq('payment_status', 'PENDING').select('membership_id').maybeSingle();
  if (updateError) throw updateError;
  if (updated) return { paid: true, membershipId: updated.membership_id, alreadyVerified: false };
  const { data: latest, error: latestError } = await db.from('membership_enrollments').select('membership_id,payment_status').eq('id', enrollment.id).single();
  if (latestError) throw latestError;
  return { paid: latest.payment_status === 'PAID', membershipId: latest.membership_id, alreadyVerified: true };
}
app.get('/health', (_req, res) => res.json({ ok: true, service: 'mi-membership-api' }));

app.post('/api/membership/create-order', async (req, res) => {
  try {
    const planId = String(req.body.planId || '').toLowerCase();
    const plan = plans[planId];
    if (!plan || !Number.isSafeInteger(plan.amount) || plan.amount < 0) return fail(res, 400, 'Unknown or invalid membership plan.');
    const c = validateCustomer(req.body, planId);
    const customerId = await upsertCustomer(c);
    const accessToken = crypto.randomBytes(32).toString('hex');
    const accessTokenHash = sha(accessToken);
    const customerType = planId === 'junior' ? 'JUNIOR' : 'ADULT';
    if (plan.amount === 0) {
      const membershipId = `MI-${new Date().getFullYear()}-${crypto.randomBytes(4).toString('hex').toUpperCase()}`;
      const { error } = await db.from('membership_enrollments').insert({ customer_id: customerId, membership_plan: planId, customer_type: customerType, guardian_name: c.guardianName, guardian_mobile: c.guardianPhone, payment_status: 'NOT_REQUIRED', membership_status: 'ACTIVE', membership_id: membershipId, amount_inr: 0, access_token_hash: accessTokenHash, consent_at: new Date().toISOString(), consent_version: String(process.env.MEMBERSHIP_CONSENT_VERSION || 'membership-terms-v1') });
      if (error) throw error;
      return res.json({ free: true, membershipId, membershipAccessToken: accessToken, status: 'ACTIVE' });
    }
    const orderId = `mim_${crypto.randomUUID().replaceAll('-', '').slice(0, 24)}`;
    const customerGatewayId = `mi_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`;
    const returnUrl = process.env.PUBLIC_APP_RETURN_URL;
    if (!returnUrl || !/^https:\/\//.test(returnUrl)) throw new Error('Configure PUBLIC_APP_RETURN_URL as an HTTPS URL.');
    const payload = { order_id: orderId, order_amount: plan.amount, order_currency: 'INR', customer_details: { customer_id: customerGatewayId, customer_name: c.name, customer_email: c.email, customer_phone: c.phone }, order_meta: { return_url: `${returnUrl}${returnUrl.includes('?') ? '&' : '?'}order_id=${orderId}` }, order_note: `MI ${plan.name} membership` };
    const cf = await fetch(`${cfBase}/orders`, { method: 'POST', headers: cfHeaders(), body: JSON.stringify(payload) });
    const result = await cf.json().catch(() => ({}));
    if (!cf.ok) return fail(res, 502, result.message || 'Cashfree could not create the payment order.');
    const { error: insertError } = await db.from('membership_enrollments').insert({ customer_id: customerId, membership_plan: planId, customer_type: customerType, guardian_name: c.guardianName, guardian_mobile: c.guardianPhone, cashfree_order_id: orderId, amount_inr: plan.amount, access_token_hash: accessTokenHash, consent_at: new Date().toISOString(), consent_version: String(process.env.MEMBERSHIP_CONSENT_VERSION || 'membership-terms-v1'), payment_status: 'PENDING', membership_status: 'PENDING' });
    if (insertError) throw insertError;
    res.json({ orderId, paymentSessionId: result.payment_session_id, membershipAccessToken: accessToken, amount: plan.amount, currency: 'INR' });
  } catch (e) { console.error('create-order:', e); fail(res, 400, e.message || 'Unable to create membership order.'); }
});

app.post('/api/membership/verify-order', async (req, res) => {
  try {
    const orderId = String(req.body.orderId || ''), token = String(req.body.membershipAccessToken || '');
    if (!/^mim_[a-f0-9]{24}$/.test(orderId) || token.length < 32) return fail(res, 400, 'Invalid verification request.');
    const { data: row, error } = await db.from('membership_enrollments').select('id,access_token_hash').eq('cashfree_order_id', orderId).maybeSingle();
    if (error || !row || !safeEqual(row.access_token_hash, sha(token))) return fail(res, 404, 'Order not found or access denied.');
    const result = await activatePaidOrder(orderId);
    if (!result.paid) return res.json({ status: result.status, message: 'Cashfree has not confirmed payment yet. Please check again shortly.' });
    res.json({ status: 'PAID', membershipId: result.membershipId, message: result.alreadyVerified ? 'Payment was already verified.' : 'Payment verified by Cashfree; membership activated.' });
  } catch (e) { console.error('verify-order:', e); fail(res, 502, 'Could not verify payment. Please retry in a moment.'); }
});

app.post('/api/membership/my-membership', async (req, res) => {
  try {
    const membershipId = String(req.body.membershipId || req.body.customerId || ''), token = String(req.body.membershipAccessToken || '');
    if (!membershipId || token.length < 32) return fail(res, 400, 'Membership ID and access token are required.');
    const { data: row, error } = await db.from('membership_enrollments').select('id,customer_id,membership_plan,membership_id,membership_status,payment_status,amount_inr,created_at,access_token_hash').eq('membership_id', membershipId).maybeSingle();
    if (error || !row || !safeEqual(row.access_token_hash, sha(token))) return fail(res, 404, 'Membership not found or access denied.');
    const { data: customer, error: customerError } = await db.from('customer_profiles').select('full_name,email,mobile_number').eq('id', row.customer_id).single();
    if (customerError) throw customerError;
    res.json({ membershipId: row.membership_id, customerName: customer.full_name, planName: plans[row.membership_plan]?.name || row.membership_plan, status: row.membership_status, paymentStatus: row.payment_status, validUntil: 'As per published membership terms', amount: row.amount_inr });
  } catch (e) { console.error('my-membership:', e); fail(res, 500, 'Unable to retrieve membership.'); }
});

app.post('/api/cashfree/webhook', async (req, res) => {
  try {
    const timestamp = req.header('x-webhook-timestamp'), signature = req.header('x-webhook-signature');
    if (!timestamp || !signature || !Buffer.isBuffer(req.body)) return res.sendStatus(400);
    const expected = crypto.createHmac('sha256', process.env.CASHFREE_SECRET_KEY).update(timestamp + req.body.toString('utf8')).digest('base64');
    if (!safeEqual(signature, expected)) return res.sendStatus(401);
    const event = JSON.parse(req.body.toString('utf8'));
    const orderId = event?.data?.order?.order_id;
    const paymentStatus = event?.data?.payment?.payment_status;
    if (orderId && paymentStatus === 'SUCCESS') {
      // Re-fetch order status from Cashfree; webhook payload alone never activates membership.
      await activatePaidOrder(orderId, event?.data?.payment?.cf_payment_id ? String(event.data.payment.cf_payment_id) : null);
    } else if (orderId && ['FAILED', 'USER_DROPPED'].includes(paymentStatus)) {
      // A failed payment attempt does not necessarily close the Cashfree order;
      // keep the enrollment pending so the customer can retry checkout safely.
      // Final failure/expiry can be reconciled from Cashfree order status later.
      await cashfreeOrder(orderId);
    }
    res.sendStatus(200);
  } catch (e) { console.error('cashfree-webhook:', e); res.sendStatus(500); }
});

const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`MI membership API listening on ${port} (${production ? 'PRODUCTION' : 'SANDBOX'})`));
