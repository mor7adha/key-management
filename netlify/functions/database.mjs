import { getStore } from "@netlify/blobs";
import { createHmac, timingSafeEqual } from "node:crypto";

const STORE_NAME = "keycod3-manager";
const DATABASE_KEY = "database";
const TOKEN_LIFETIME = 12 * 60 * 60 * 1000;
const DEFAULT_ADMIN = { id:"u1", workspaceId:"u1", name:"مدير النظام", username:"admin", password:"admin123", role:"admin", active:true };
const WORKSPACE_COLLECTIONS = ["subscriptions", "debts", "payables", "notifications", "activities"];

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
  return { users:[DEFAULT_ADMIN], subscriptions:[], debts:[], payables:[], notifications:[], activities:[], registrationRequests:[], rates:{USD:530,SAR:139.7,YER:1}, currencyNames:{YER:"ريال يمني",USD:"دولار أمريكي",SAR:"ريال سعودي"}, baseCurrency:"YER", workspaceRates:{u1:{USD:530,SAR:139.7,YER:1}}, workspaceSettings:{u1:{baseCurrency:"YER",currencyNames:{YER:"ريال يمني",USD:"دولار أمريكي",SAR:"ريال سعودي"}}}, dismissedNotificationIds:[], dismissedByWorkspace:{u1:[]}, defaultDataRemoved:true };
}

async function readDatabase() {
  return await store().get(DATABASE_KEY, { type:"json" }) || null;
}

function normalizeDatabase(source) {
  const database = source || initialDatabase();
  database.registrationRequests ||= [];
  const independentUsernames = new Set(database.registrationRequests.filter(item => item.status === "approved").map(item => item.username));
  database.users = (database.users || []).map(user => ({
    ...user,
    workspaceId: user.workspaceId || (user.id !== "u1" && independentUsernames.has(user.username) ? user.id : "u1")
  }));
  for (const key of WORKSPACE_COLLECTIONS) {
    database[key] = (database[key] || []).map(item => ({ ...item, ownerId:item.ownerId || "u1" }));
  }
  database.rates ||= { USD:530, SAR:139.7, YER:1 };
  database.workspaceRates ||= { u1:database.rates };
  database.currencyNames ||= { YER:"ريال يمني", USD:"دولار أمريكي", SAR:"ريال سعودي" };
  database.baseCurrency ||= "YER";
  database.workspaceSettings ||= { u1:{ baseCurrency:database.baseCurrency, currencyNames:database.currencyNames } };
  database.dismissedNotificationIds ||= [];
  database.dismissedByWorkspace ||= { u1:database.dismissedNotificationIds };
  return database;
}

function scopedDatabase(database, user) {
  const workspaceId = user.workspaceId || user.id;
  const scoped = { ...database };
  scoped.users = user.id === "u1" ? database.users : database.users.filter(item => item.workspaceId === workspaceId);
  for (const key of WORKSPACE_COLLECTIONS) scoped[key] = database[key].filter(item => item.ownerId === workspaceId);
  scoped.registrationRequests = user.id === "u1" ? database.registrationRequests : [];
  scoped.rates = database.workspaceRates[workspaceId] || { USD:530, SAR:139.7, YER:1 };
  const settings = database.workspaceSettings[workspaceId] || { baseCurrency:"YER", currencyNames:{YER:"ريال يمني",USD:"دولار أمريكي",SAR:"ريال سعودي"} };
  scoped.baseCurrency = settings.baseCurrency;
  scoped.currencyNames = settings.currencyNames;
  scoped.dismissedNotificationIds = database.dismissedByWorkspace[workspaceId] || [];
  delete scoped.workspaceRates;
  delete scoped.workspaceSettings;
  delete scoped.dismissedByWorkspace;
  return scoped;
}

function mergeWorkspace(database, submitted, user) {
  const workspaceId = user.workspaceId || user.id;
  for (const key of WORKSPACE_COLLECTIONS) {
    const preserved = database[key].filter(item => item.ownerId !== workspaceId);
    const owned = (submitted[key] || []).map(item => ({ ...item, ownerId:workspaceId }));
    database[key] = [...preserved, ...owned];
  }
  if (user.id === "u1") {
    const submittedUsers = submitted.users || database.users;
    const submittedIds = new Set(submittedUsers.map(item => item.id));
    const deletedWorkspaces = new Set(database.users.filter(item => item.id !== "u1" && item.workspaceId === item.id && !submittedIds.has(item.id)).map(item => item.workspaceId));
    database.users = submittedUsers.map(item => ({ ...item, workspaceId:item.workspaceId || "u1" }));
    if (deletedWorkspaces.size) {
      for (const key of WORKSPACE_COLLECTIONS) database[key] = database[key].filter(item => !deletedWorkspaces.has(item.ownerId));
      for (const id of deletedWorkspaces) {
        delete database.workspaceRates[id];
        delete database.workspaceSettings[id];
        delete database.dismissedByWorkspace[id];
      }
    }
    database.registrationRequests = submitted.registrationRequests || database.registrationRequests;
  } else if (user.role === "admin") {
    const preservedUsers = database.users.filter(item => item.workspaceId !== workspaceId);
    const workspaceUsers = (submitted.users || []).map(item => ({ ...item, workspaceId }));
    database.users = [...preservedUsers, ...workspaceUsers];
  } else {
    const updatedSelf = (submitted.users || []).find(item => item.id === user.id);
    if (updatedSelf) Object.assign(user, { name:updatedSelf.name, username:updatedSelf.username, password:updatedSelf.password, workspaceId });
  }
  database.workspaceRates[workspaceId] = submitted.rates || database.workspaceRates[workspaceId] || { USD:530, SAR:139.7, YER:1 };
  database.workspaceSettings[workspaceId] = {
    baseCurrency:submitted.baseCurrency || database.workspaceSettings[workspaceId]?.baseCurrency || "YER",
    currencyNames:submitted.currencyNames || database.workspaceSettings[workspaceId]?.currencyNames || { YER:"ريال يمني",USD:"دولار أمريكي",SAR:"ريال سعودي" }
  };
  database.dismissedByWorkspace[workspaceId] = submitted.dismissedNotificationIds || [];
  return database;
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
        database = normalizeDatabase(database);
        const user = database.users?.find(item => item.username === body.username && item.password === body.password && item.active);
        if (!user) return json({ error:"اسم المستخدم أو كلمة المرور غير صحيح" }, 401);
        return json({ token:makeToken(user), userId:user.id, database:scopedDatabase(database, user), initialized });
      }
      if (body.action === "register") {
        const database = normalizeDatabase(await readDatabase() || initialDatabase());
        const requestItem = body.request;
        if (!requestItem?.name || !requestItem?.username || !requestItem?.password) return json({ error:"بيانات الطلب غير مكتملة" }, 400);
        const duplicate = database.users.some(u => u.username === requestItem.username) || database.registrationRequests.some(r => r.username === requestItem.username && r.status === "pending");
        if (duplicate) return json({ error:"اسم المستخدم مستخدم أو لديه طلب معلّق" }, 409);
        database.registrationRequests.unshift(requestItem);
        database.notifications.unshift({ id:`registration-${requestItem.id}`, ownerId:"u1", type:"registration", title:"طلب إنشاء حساب جديد", body:`${requestItem.name} يطلب إنشاء الحساب @${requestItem.username}`, date:new Date().toISOString(), read:false });
        await store().setJSON(DATABASE_KEY, database);
        return json({ registered:true });
      }
      return json({ error:"طلب غير صالح" }, 400);
    }

    const database = normalizeDatabase(await readDatabase());
    const userId = tokenUserId(request);
    const user = database?.users?.find(item => item.id === userId && item.active);
    if (!user) return json({ error:"انتهت الجلسة، سجل الدخول من جديد" }, 401);

    if (request.method === "GET") return json({ database:scopedDatabase(database, user), updatedAt:new Date().toISOString() });
    if (request.method === "PUT") {
      const body = await request.json();
      if (!body.database || !Array.isArray(body.database.users)) return json({ error:"بيانات غير صالحة" }, 400);
      if (JSON.stringify(body.database).length > 5_000_000) return json({ error:"حجم البيانات أكبر من الحد المسموح" }, 413);
      await store().setJSON(DATABASE_KEY, mergeWorkspace(database, body.database, user));
      return json({ saved:true, updatedAt:new Date().toISOString() });
    }
    return json({ error:"Method not allowed" }, 405);
  } catch (error) {
    console.error("Database function failed", error);
    return json({ error:"تعذر الوصول إلى قاعدة البيانات السحابية" }, 500);
  }
}

export const config = { path:"/api/database" };
