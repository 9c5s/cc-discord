import { test, expect } from 'bun:test'
import { toEntity } from '../src/discord-entity'

const CH = '22222222222222222'
const THREAD = '44444444444444444'
const DM = '55555555555555555'
const USER = '66666666666666666'

test('toEntity は discord.js のスレッドの parentId を parent_id にし DM の recipientId を recipients にする', () => {
  expect(toEntity({ id: THREAD, type: 11, parentId: CH })).toEqual({ id: THREAD, type: 11, parent_id: CH })
  expect(toEntity({ id: DM, type: 1, parentId: null, recipientId: USER })).toEqual({
    id: DM,
    type: 1,
    parent_id: null,
    recipients: [{ id: USER }],
  })
  expect(toEntity({ id: CH, type: 0 })).toEqual({ id: CH, type: 0, parent_id: null })
})
