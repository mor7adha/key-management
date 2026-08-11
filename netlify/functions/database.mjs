import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

const STORE_NAME = "keycod3-manager";
const DATABASE_KEY = "database";
const TOKEN_LIFETIME = 12 * 60 * 60 * 1000;
const DEFAULT_ADMIN = { id:"u1", name:"مدير النظام", username:"admin", password:"admin123", role:"admin", active:true };

function store() {
  return getStore({ name: STORE_NAME, consistency: "strong" });
}

function json(data, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: {
    "content-type":"application/json; charset=utf-8",
    "cache-control":"no-store"
  }});
}

function secret() {
  return process.env.APP_SECRET || process.env.SITE_ID || "keycod3-manager-change-this-secret";
}

function sign(value) {
  return createHmac("sha256", secret()).update(value).digest("base64url");
}

function makeToken(user) {
  const payload = Buffer.from(JSON.stringify({ id:user.id, exp:Date.now()+TOKEN_LIFETIME })).toString("base64url");
  return `${payload}.${sign(payload)}`;
}

function tokenUserId(request) {
  try {
    const token = (request.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const [payload, signature] = token.split(".");
    if (!payload || !signature) return null;
    const expected = sign(payload);
    const a = Buffer.from(signature), b = Buffer.from(expected);
    if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    return parsed.exp > Date.now() ? parsed.id : null;
  } catch { return null; }
}

function initialDatabase() {
  return { users:[DEFAULT_ADMIN], subscriptions:[], debts:[], payables:[], notifications:[], activities:[], registrationRequests:[], rates:{USD:530,SAR:139.7,YER:1}, dismissedNotificationIds:[], defaultDataRemoved:true };
}

async function readDatabase() {
  return await store().get(DATABASE_KEY, { type:"json" }) || null;
}

export default async function handler(request) {
  try {
    if (request.method === "POST") {
      const body = await request.json();
      if (body.action === "login") {
        let database = await readDatabase();
        const initialized = !database;
        if (!database) {
          database = initialDatabase();
          await store().setJSON(DATABASE_KEY, database);
        }
        const user = database.users?.find(item => item.username === body.username && item.password === body.password && item.active);
        if (!user) return json({ error:"اسم المستخدم أو كلمة المرور غير صحيح" }, 401);
        return json({ token:makeToken(user), userId:user.id, database, initialized });
      }
      if (body.action === "register") {
        const database = await readDatabase() || initialDatabase();
        const requestItem = body.request;
        if (!requestItem?.name || !requestItem?.username || !requestItem?.password) return json({ error:"بيانات الطلب غير مكتملة" }, 400);
        const duplicate = database.users.some(u => u.username === requestItem.username) || database.registrationRequests.some(r => r.username === requestItem.username && r.status === "pending");
        if (duplicate) return json({ error:"اسم المستخدم مستخدم أو لديه طلب معلّق" }, 409);
        database.registrationRequests.unshift(requestItem);
        database.notifications.unshift({ id:`registration-${requestItem.id}`, type:"registration", title:"طلب إنشاء حساب جديد", body:`${requestItem.name} يطلب إنشاء الحساب @${requestItem.username}`, date:new Date().toISOString(), read:false });
        await store().setJSON(DATABASE_KEY, database);
        return json({ registered:true });
      }
      return json({ error:"طلب غير صالح" }, 400);
    }

    const database = await readDatabase();
    const userId = tokenUserId(request);
    const user = database?.users?.find(item => item.id === userId && item.active);
    if (!user) return json({ error:"انتهت الجلسة، سجل الدخول من جديد" }, 401);

    if (request.method === "GET") return json({ database, updatedAt:new Date().toISOString() });
    if (request.method === "PUT") {
      const body = await request.json();
      if (!body.database || !Array.isArray(body.database.users)) return json({ error:"بيانات غير صالحة" }, 400);
      if (JSON.stringify(body.database).length > 5_000_000) return json({ error:"حجم البيانات أكبر من الحد المسموح" }, 413);
      await store().setJSON(DATABASE_KEY, body.database);
      return json({ saved:true, updatedAt:new Date().toISOString() });
    }
    return json({ error:"Method not allowed" }, 405);
  } catch (error) {
    console.error("Database function failed", error);
    return json({ error:"تعذر الوصول إلى قاعدة البيانات السحابية" }, 500);
  }
}

export const config = { path:"/api/database" };
