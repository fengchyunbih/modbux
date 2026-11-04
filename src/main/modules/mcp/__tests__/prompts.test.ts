/* eslint-disable @typescript-eslint/explicit-function-return-type */
import { describe, expect, it } from 'vitest'
import { ENCODING_RESOURCE_URI } from '../resources'
import { connectInMemory, fakeContext } from './fakeContext'

const TABLE = 'Address;Name;Type;Scale\n40001;Voltage;uint16;0.1'

/** The tools every prompt may name, as the other tool groups register them. */
const KNOWN_TOOLS = [
  'client_get_config',
  'client_set_connection',
  'client_apply_point_table',
  'client_connect',
  'client_disconnect',
  'client_read_points',
  'client_write',
  'server_list',
  'server_create',
  'server_delete',
  'server_apply_point_table',
  'server_set_values',
  'server_get_values',
  'server_export_config',
  'server_import_config',
  'client_export_config',
  'client_import_config',
  'project_export',
  'project_import'
]

const promptText = async (name: string, pointTable = TABLE): Promise<string> => {
  const client = await connectInMemory(fakeContext())
  const { messages } = await client.getPrompt({ name, arguments: { pointTable } })
  const [message] = messages
  if (message?.content.type !== 'text') throw new Error('the prompt has no text message')
  expect(message.role).toBe('user')
  return message.content.text
}

describe('the prompts', () => {
  it('lists three prompts that each take the point table', async () => {
    const client = await connectInMemory(fakeContext())

    const { prompts } = await client.listPrompts()

    expect(prompts.map((prompt) => prompt.name)).toEqual([
      'point_table_to_client',
      'point_table_to_simulator',
      'closed_loop_test'
    ])
    for (const prompt of prompts) {
      expect(prompt.arguments).toEqual([
        expect.objectContaining({ name: 'pointTable', required: true })
      ])
    }
  })

  it('refuses a prompt without a point table', async () => {
    const client = await connectInMemory(fakeContext())

    await expect(client.getPrompt({ name: 'closed_loop_test', arguments: {} })).rejects.toThrow()
  })

  it('carries the point table into every prompt', async () => {
    for (const name of ['point_table_to_client', 'point_table_to_simulator', 'closed_loop_test']) {
      expect(await promptText(name, '40007;Pressure;float')).toContain('40007;Pressure;float')
    }
  })

  it('point_table_to_client names its tools in the order of the workflow', async () => {
    const text = await promptText('point_table_to_client')

    const order = [
      'client_get_config',
      'client_set_connection',
      'client_apply_point_table',
      'client_connect',
      'client_read_points'
    ].map((tool) => text.indexOf(tool))
    expect(order.every((at) => at >= 0)).toBe(true)
    expect(order).toEqual([...order].sort((a, b) => a - b))
    expect(text).toContain('dryRun: true')
    expect(text).toContain(ENCODING_RESOURCE_URI)
    for (const order of ['ABCD', 'CDAB', 'BADC', 'DCBA']) expect(text).toContain(order)
  })

  it('point_table_to_simulator dry-runs before it applies, and offers fixed values and generators', async () => {
    const text = await promptText('point_table_to_simulator')

    for (const tool of ['server_list', 'server_create', 'server_apply_point_table']) {
      expect(text).toContain(tool)
    }
    expect(text.indexOf('dryRun: true')).toBeLessThan(text.indexOf('without dryRun'))
    expect(text).toContain('fixed value')
    expect(text).toContain('generator')
  })

  it('closed_loop_test points the client at 127.0.0.1 and compares with server_get_values', async () => {
    const text = await promptText('closed_loop_test')

    for (const tool of [
      'server_create',
      'server_apply_point_table',
      'client_set_connection',
      'client_apply_point_table',
      'client_connect',
      'client_read_points',
      'server_get_values'
    ]) {
      expect(text).toContain(tool)
    }
    expect(text).toContain('127.0.0.1')
    expect(text.indexOf('client_read_points')).toBeLessThan(text.indexOf('server_get_values'))
  })

  it('names only tools of the agreed surface', async () => {
    for (const name of ['point_table_to_client', 'point_table_to_simulator', 'closed_loop_test']) {
      const text = await promptText(name)
      const named = text.match(/\b(?:client|server|project)_[a-z_]+/g) ?? []
      expect(named.length).toBeGreaterThan(0)
      for (const tool of named) expect(KNOWN_TOOLS).toContain(tool)
    }
  })
})
