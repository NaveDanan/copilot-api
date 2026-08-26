import { Hono } from "hono"

import { state } from "~/lib/state"

export const tokenRoute = new Hono()

tokenRoute.get("/", (c) => {
  c.header("Cache-Control", "no-store")
  c.header("Pragma", "no-cache")
  return c.json({
    token: state.copilotToken,
  })
})
