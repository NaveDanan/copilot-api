import { Hono } from "hono"
import { logger } from "hono/logger"

import {
  browserIsolationMiddleware,
  createHostValidationMiddleware,
} from "./lib/network-security"
import {
  createAuthMiddleware,
  getConfiguredAdminApiKeys,
} from "./lib/request-auth"
import { traceIdMiddleware } from "./lib/trace"
import {
  usageViewerContentSecurityPolicy,
  usageViewerCss,
  usageViewerHtml,
} from "./usage-viewer"
import { zstdDecompressionMiddleware } from "./lib/zstd-request"
import { alphaSearchRoutes } from "./routes/alpha-search/route"
import { completionRoutes } from "./routes/chat-completions/route"
import { configRoutes } from "./routes/admin/config/route"
import { tokenRoute } from "./routes/admin/token/route"
import { embeddingRoutes } from "./routes/embeddings/route"
import { imageRoutes } from "./routes/images/route"
import { messageRoutes } from "./routes/messages/route"
import { modelRoutes } from "./routes/models/route"
import { providerAlphaSearchRoutes } from "./routes/provider/alpha-search/route"
import { providerImageRoutes } from "./routes/provider/images/route"
import { providerMessageRoutes } from "./routes/provider/messages/route"
import { providerModelRoutes } from "./routes/provider/models/route"
import { providerResponsesRoutes } from "./routes/provider/responses/route"
import { responsesRoutes } from "./routes/responses/route"
import { tokenUsageRoute } from "./routes/token-usage/route"
import { usageRoute } from "./routes/usage/route"

export const server = new Hono()

server.use(traceIdMiddleware)
server.use(createHostValidationMiddleware())
server.use(browserIsolationMiddleware)
server.use(logger())
server.use(
  "*",
  createAuthMiddleware({
    allowUnauthenticatedPaths: [
      "/",
      "/usage-viewer",
      "/usage-viewer/",
      "/usage-viewer/usage-viewer.css",
    ],
    shouldSkipPath: (path) => path.startsWith("/admin/"),
  }),
)
server.use(
  "/admin/*",
  createAuthMiddleware({
    getApiKeys: getConfiguredAdminApiKeys,
    allowUnauthenticatedPaths: [],
    allowWhenNoApiKeys: false,
  }),
)
server.use(zstdDecompressionMiddleware)

server.get("/", (c) => c.text("Server running"))
server.get("/usage-viewer", (c) => {
  c.header("Content-Security-Policy", usageViewerContentSecurityPolicy)
  c.header("Referrer-Policy", "no-referrer")
  c.header("X-Content-Type-Options", "nosniff")
  c.header("X-Frame-Options", "DENY")
  c.header("Cache-Control", "no-store")
  return c.html(usageViewerHtml)
})
server.get("/usage-viewer/", (c) => c.redirect("/usage-viewer", 301))
server.get("/usage-viewer/usage-viewer.css", (c) => {
  c.header("Content-Type", "text/css; charset=UTF-8")
  c.header("Cache-Control", "no-cache")
  c.header("X-Content-Type-Options", "nosniff")
  return c.body(usageViewerCss)
})

server.route("/chat/completions", completionRoutes)
server.route("/admin/config", configRoutes)
server.route("/models", modelRoutes)
server.route("/embeddings", embeddingRoutes)
server.route("/usage", usageRoute)
server.route("/token-usage", tokenUsageRoute)
server.route("/responses", responsesRoutes)
server.route("/alpha/search", alphaSearchRoutes)
server.route("/images", imageRoutes)

// Compatibility with tools that expect v1/ prefix
server.route("/v1/chat/completions", completionRoutes)
server.route("/v1/models", modelRoutes)
server.route("/v1/embeddings", embeddingRoutes)
server.route("/v1/responses", responsesRoutes)
server.route("/v1/alpha/search", alphaSearchRoutes)
server.route("/v1/images", imageRoutes)

// Anthropic compatible endpoints
server.route("/v1/messages", messageRoutes)

// Sensitive credentials are only available through admin authentication.
server.route("/admin/token", tokenRoute)

// Provider scoped endpoints
server.route("/:provider/v1/messages", providerMessageRoutes)
server.route("/:provider/v1/models", providerModelRoutes)
server.route("/:provider/v1/responses", providerResponsesRoutes)
server.route("/:provider/v1/alpha/search", providerAlphaSearchRoutes)
server.route("/:provider/v1/images", providerImageRoutes)

server.route("/:provider/models", providerModelRoutes)
server.route("/:provider/responses", providerResponsesRoutes)
server.route("/:provider/alpha/search", providerAlphaSearchRoutes)
server.route("/:provider/images", providerImageRoutes)
