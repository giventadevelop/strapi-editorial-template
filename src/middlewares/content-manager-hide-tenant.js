 "use strict";

const requestContext = require("../utils/request-context");

const HIDDEN_FIELDS = new Set(["tenant", "views", "isFeatured"]);
const TARGET_UIDS = new Set([
  "api::article.article",
  "api::advertisement-slot.advertisement-slot",
]);

function stripHiddenFromArray(arr) {
  return arr
    .filter((item) => {
      const name = item?.name ?? item?.field;
      return !HIDDEN_FIELDS.has(name);
    })
    .map((item) => {
      if (Array.isArray(item)) return stripHiddenFromArray(item);
      if (item && typeof item === "object") scrubLayouts(item);
      return item;
    });
}

function scrubLayouts(node) {
  if (!node || typeof node !== "object") return;
  for (const key of Object.keys(node)) {
    if (key === "metadatas") continue; // keep metadata intact
    const value = node[key];
    if (Array.isArray(value)) {
      node[key] = stripHiddenFromArray(value);
    } else if (value && typeof value === "object") {
      scrubLayouts(value);
    }
  }
}

function hideFieldsInConfig(config) {
  if (!config || typeof config !== "object") return;
  scrubLayouts(config);
}

module.exports = (_config, _opts) => {
  return async (ctx, next) => {
    await next();

    if (ctx.method !== "GET") return;
    if (!ctx.path.includes("/content-manager/content-types/")) return;
    if (!ctx.path.endsWith("/configuration")) return;

    const ctxStore = requestContext.get();
    const user = ctxStore?.state?.user || ctxStore?.state?.admin;
    if (!user?.id) return;

    const adminUser = await strapi.db.query("admin::user").findOne({
      where: { id: user.id },
      populate: { roles: true },
      select: ["id"],
    });
    const isEditor = (adminUser?.roles || []).some((r) => r.code === "strapi-editor");
    if (!isEditor) return;

    const uid = ctx.params?.contentType || ctx.params?.uid || ctx.params?.model;
    if (uid && !TARGET_UIDS.has(uid)) return;

    if (ctx.body) {
      hideFieldsInConfig(ctx.body);
    }
  };
};
