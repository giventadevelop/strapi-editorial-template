 "use strict";

const requestContext = require("../utils/request-context");

const HIDDEN_FIELDS = new Set(["tenant", "views", "isFeatured"]);
const FLASH_NEWS_ITEM_UID = "api::flash-news-item.flash-news-item";
const TARGET_UIDS = new Set([
  "api::article.article",
  "api::advertisement-slot.advertisement-slot",
  "api::flash-news-item.flash-news-item",
  "api::directory-home.directory-home",
  "api::bishop.bishop",
  "api::diocese.diocese",
  "api::parish.parish",
  "api::church.church",
  "api::priest.priest",
  "api::directory-entry.directory-entry",
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

/** Return true if arr looks like a layout: array of rows, each row array of cells with name/field */
function isLayoutGrid(arr) {
  if (!Array.isArray(arr) || arr.length === 0) return false;
  const first = arr[0];
  if (!Array.isArray(first)) return false;
  const cell = first[0];
  return cell && typeof cell === "object" && ((cell.name !== undefined) || (cell.field !== undefined));
}

/** Move title cell to first position in a layout grid (mutates). */
function moveTitleFirstInLayoutGrid(layouts) {
  if (!Array.isArray(layouts)) return;
  let titleCell = null;
  let foundRi = -1;
  let foundCi = -1;
  for (let ri = 0; ri < layouts.length; ri++) {
    const row = layouts[ri];
    if (!Array.isArray(row)) continue;
    const ci = row.findIndex((c) => (c?.name ?? c?.field) === "title");
    if (ci !== -1) {
      titleCell = row[ci];
      foundRi = ri;
      foundCi = ci;
      break;
    }
  }
  if (!titleCell) return;
  layouts[foundRi].splice(foundCi, 1);
  if (layouts[foundRi].length === 0) layouts.splice(foundRi, 1);
  if (layouts.length === 0) layouts.push([titleCell]);
  else layouts[0].unshift(titleCell);
}

/** Recursively find layout-like arrays in config and move title first (for Flash News Item). */
function moveTitleFirstRecursive(node) {
  if (!node || typeof node !== "object") return;
  if (Array.isArray(node)) {
    if (isLayoutGrid(node)) {
      moveTitleFirstInLayoutGrid(node);
      return;
    }
    for (const item of node) moveTitleFirstRecursive(item);
    return;
  }
  for (const key of Object.keys(node)) {
    moveTitleFirstRecursive(node[key]);
  }
}

function hideFieldsInConfig(config) {
  if (!config || typeof config !== "object") return;
  scrubLayouts(config);
}

function applyFlashNewsItemLayout(config) {
  if (!config || typeof config !== "object") return;
  moveTitleFirstRecursive(config);
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
      if (uid === FLASH_NEWS_ITEM_UID) applyFlashNewsItemLayout(ctx.body);
    }
  };
};
