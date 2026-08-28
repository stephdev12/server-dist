/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as admin from "../admin.js";
import type * as analytics from "../analytics.js";
import type * as auth from "../auth.js";
import type * as automations from "../automations.js";
import type * as broadcasts from "../broadcasts.js";
import type * as catalogs from "../catalogs.js";
import type * as files from "../files.js";
import type * as followups from "../followups.js";
import type * as forms from "../forms.js";
import type * as group_settings from "../group_settings.js";
import type * as http from "../http.js";
import type * as payments from "../payments.js";
import type * as responses from "../responses.js";
import type * as servers from "../servers.js";
import type * as test_otp from "../test_otp.js";
import type * as users from "../users.js";
import type * as whatsapp_meta from "../whatsapp_meta.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  admin: typeof admin;
  analytics: typeof analytics;
  auth: typeof auth;
  automations: typeof automations;
  broadcasts: typeof broadcasts;
  catalogs: typeof catalogs;
  files: typeof files;
  followups: typeof followups;
  forms: typeof forms;
  group_settings: typeof group_settings;
  http: typeof http;
  payments: typeof payments;
  responses: typeof responses;
  servers: typeof servers;
  test_otp: typeof test_otp;
  users: typeof users;
  whatsapp_meta: typeof whatsapp_meta;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
