import { getStore } from '@netlify/blobs';
import { randomBytes } from 'node:crypto';

const seed = {
  users: [{ id: 'u1', name: 'مدير النظام', username: 'admin', password: 'admin123', role: 'admin', active: true }],
  subscriptions: [], debts: [], payables: [], notifications: [], activities: [],
  registrationRequests: [], rates: { USD: 530, SAR: 139.7, YER: 1 },
  dismissedNotificationIds: [], defaultDataRemoved: true
};

const json = (body, status = 200) => new Response(JSON.stringify(body), {
  status,
  headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' }
});

const databaseStore = () => getStore({ name: 'keycode-data', consistency: 'strong' });
const sessionStore = () => getStore({ name: 'keycode-sessions', consistency: 'strong' });

async function getDatabase() {
  const store = databaseStore();
  const data = await store.get('database', { type: 'json' });
  if (data) return data;
  await store.setJSON('database', seed);
  return structuredClone(seed);
}

async function authenticate(token, db) {
  if (!token) return null;
  const session = await sessionStore().get(token, { type: 'json' });
  if (!session || new Date(session.expiresAt) <= new Date()) return null;
  return db.users.find(user => user.id === session.userId && user.active) || null;
}

export default async function handler(request) {
  if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
  try {
    const body = await request.json();
    const db = await getDatabase();

    if (body.action === 'login') {
      const user = db.users.find(item => item.username === body.username && item.password === body.password && item.active);
      if (!user) return json({ error: 'بيانات تسجيل الدخول غير صحيحة' }, 401);
      const token = randomBytes(32).toString('hex');
      await sessionStore().setJSON(token, { userId: user.id, expiresAt: new Date(Date.now() + 7 * 86400000).toISOString() });
      return json({ token, userId: user.id, db });
    }

    if (body.action === 'register') {
      const requestData = body.request;
      if (!requestData?.name || !requestData?.username || !requestData?.password) return json({ error: 'بيانات الطلب غير مكتملة' }, 400);
      const exists = db.users.some(user => user.username === requestData.username) ||
        db.registrationRequests.some(item => item.username === requestData.username && item.status === 'pending');
      if (exists) return json({ error: 'اسم المستخدم مستخدم أو لديه طلب معلّق' }, 409);
      db.registrationRequests.unshift(requestData);
      db.notifications.unshift({
        id: `registration-${requestData.id}`, type: 'registration', title: 'طلب إنشاء حساب جديد',
        body: `${requestData.name} يطلب إنشاء الحساب @${requestData.username}`,
        date: new Date().toISOString(), read: false
      });
      await databaseStore().setJSON('database', db);
      return json({ ok: true });
    }

    const user = await authenticate(body.token, db);
    if (!user) return json({ error: 'انتهت جلسة تسجيل الدخول' }, 401);

    if (body.action === 'load') return json({ db, userId: user.id });
    if (body.action === 'save') {
      if (!body.db || typeof body.db !== 'object') return json({ error: 'بيانات غير صالحة' }, 400);
      const actingUser = body.db.users?.find(item => item.id === user.id && item.active);
      if (!actingUser) return json({ error: 'لا يمكن تعطيل الحساب المستخدم' }, 403);
      const nextDatabase = structuredClone(body.db);
      if (user.role !== 'admin') {
        nextDatabase.users = db.users;
        nextDatabase.registrationRequests = db.registrationRequests;
      }
      await databaseStore().setJSON('database', nextDatabase);
      return json({ ok: true });
    }
    if (body.action === 'logout') {
      await sessionStore().delete(body.token);
      return json({ ok: true });
    }
    return json({ error: 'Unknown action' }, 400);
  } catch (error) {
    console.error(error);
    return json({ error: 'تعذر الاتصال بالتخزين السحابي' }, 500);
  }
}
