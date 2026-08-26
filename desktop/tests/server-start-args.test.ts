import { expect, test } from 'bun:test'

import { buildServerStartArgs } from '../electron/server-start-args'

test('does not place credentials in desktop server process arguments', () => {
  expect(buildServerStartArgs(4141)).toEqual(['start', '--port', '4141'])
  expect(buildServerStartArgs(4141, true)).toEqual([
    'start',
    '--port',
    '4141',
    '--strict-security',
  ])
})
