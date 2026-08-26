import { expect, mock, test } from "bun:test"

import {
  ANTHROPIC_TOKEN_COUNT_PRIVACY_WARNING,
  warnAnthropicTokenCountDisclosure,
} from "~/routes/messages/count-tokens-handler"

test("warns that Anthropic token counting sends the complete request", () => {
  const logger = {
    warn: mock(() => {}),
  }

  warnAnthropicTokenCountDisclosure(logger)

  expect(logger.warn).toHaveBeenCalledWith(
    ANTHROPIC_TOKEN_COUNT_PRIVACY_WARNING,
  )
  expect(ANTHROPIC_TOKEN_COUNT_PRIVACY_WARNING).toContain(
    "complete system prompt, messages, and tool schemas",
  )
})
