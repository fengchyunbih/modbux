import { isConnectionAddressGiven, isReadLengthGiven } from '@shared'
import { deepEqual } from 'fast-equals'
import { useClientZustand } from './client.zustand'
import { ClientZustand } from './client.zustand.types'
import { showMapping, useDataZustand } from './data.zustand'
import { replayTop, useUndoZustand } from './undo.zustand'
import {
  clientFieldReaders,
  clientFieldSteps,
  clientStepKey,
  pushStep
} from './undo.zustand.helpers'
import {
  ClientConfiguration,
  ClientConfigurationStep,
  ClientField,
  ClientFieldStep,
  ClientFieldStepOf,
  ClientFieldValues,
  ClientMappingStep,
  ClientUndoStep,
  UndoOutcome,
  UndoRefusal,
  UndoStack
} from './undo.zustand.types'

/**
 * Each field through the setter a user's edit goes through, so a replay passes
 * the same guards and reaches main the same way. The validity a masked field
 * reports is read off the value, as the field itself reads it.
 */
const clientFieldWriters: {
  [Field in ClientField]: (value: ClientFieldValues[Field]) => Promise<boolean>
} = {
  name: async (value) => {
    useClientZustand.getState().setName(value)
    return true
  },
  protocol: (value) => useClientZustand.getState().setProtocol(value),
  unitId: (value) => useClientZustand.getState().setUnitId(String(value)),
  host: (value) => useClientZustand.getState().setHost(value, isConnectionAddressGiven(value)),
  port: (value) => useClientZustand.getState().setPort(String(value)),
  com: (value) => useClientZustand.getState().setCom(value, isConnectionAddressGiven(value)),
  baudRate: (value) => useClientZustand.getState().setBaudRate(value),
  parity: (value) => useClientZustand.getState().setParity(value),
  dataBits: (value) => useClientZustand.getState().setDataBits(value),
  stopBits: (value) => useClientZustand.getState().setStopBits(value),
  address: (value) => useClientZustand.getState().setAddress(String(value)),
  length: (value) => useClientZustand.getState().setLength(String(value), isReadLengthGiven(value)),
  type: (value) => useClientZustand.getState().setType(value),
  pollRate: (value) => useClientZustand.getState().setPollRate(value),
  timeout: (value) => useClientZustand.getState().setTimeout(value),
  byteOrder: (value) => useClientZustand.getState().setByteOrder(value),
  advancedMode: (value) => useClientZustand.getState().setAdvancedMode(value),
  show64BitValues: (value) => useClientZustand.getState().setShow64BitValues(value),
  addressBase: (value) => useClientZustand.getState().setAddressBase(value)
}

/**
 * The fields a connect opens with, which their setters refuse while a
 * connection stands. Named here so the refusal can say so.
 */
const CONNECTION_FIELDS: ReadonlySet<ClientField> = new Set<ClientField>([
  'protocol',
  'host',
  'port',
  'com',
  'baudRate',
  'parity',
  'dataBits',
  'stopBits'
])

const isDisconnected = (): boolean =>
  useDataZustand.getState().clientState.connectState === 'disconnected'

/**
 * Writes a step's value, and answers the step that would write back what was
 * there, or undefined when the store does not hold the value afterwards.
 *
 * The store is what is asked, not the setter's answer: an invalid host, COM
 * port or length is kept in the store and never sent, and its setter answers
 * `false` for that, but the step it came from is put back all the same.
 */
const replayField = async <Field extends ClientField>(
  step: ClientFieldStepOf<Field>
): Promise<ClientFieldStep | UndoRefusal | undefined> => {
  if (CONNECTION_FIELDS.has(step.field) && !isDisconnected()) return 'refused-connected'
  const read = clientFieldReaders[step.field]
  const replaced = clientFieldSteps[step.field](read(useClientZustand.getState()))
  await clientFieldWriters[step.field](step.value)
  return read(useClientZustand.getState()) === step.value ? replaced : undefined
}

/** Shows the register type the entry belongs to first, so the change is on screen. */
const replayMapping = async (step: ClientMappingStep): Promise<ClientMappingStep | undefined> => {
  const client = useClientZustand.getState()
  if (client.registerConfig.type !== step.type && !(await client.setType(step.type))) {
    return undefined
  }

  const replaced: ClientMappingStep = {
    ...step,
    value: useClientZustand.getState().registerMapping[step.type][step.register]
  }
  useClientZustand.getState().setMappingEntry(step.type, step.register, step.value)
  return replaced
}

const currentConfiguration = (): ClientConfiguration => {
  const { name, connectionConfig, registerConfig, registerMapping } = useClientZustand.getState()
  return { name, connectionConfig, registerConfig, registerMapping }
}

/**
 * The fields a configuration sets through their setters, in the order they
 * are written. The byte order is the last of them, so it goes in right before
 * the mapping, as it did when it was the only one.
 */
const CONFIGURATION_FIELDS: readonly Exclude<ClientField, 'name'>[] = [
  'protocol',
  'host',
  'port',
  'com',
  'baudRate',
  'parity',
  'dataBits',
  'stopBits',
  'unitId',
  'address',
  'length',
  'type',
  'pollRate',
  'timeout',
  'advancedMode',
  'show64BitValues',
  'addressBase',
  'byteOrder'
]

/** Writes one field to what `source` holds, and answers whether the store holds it after. */
const writeFieldFrom = async <Field extends ClientField>(
  field: Field,
  source: ClientZustand
): Promise<boolean> => {
  const value = clientFieldReaders[field](source)
  await clientFieldWriters[field](value)
  return clientFieldReaders[field](useClientZustand.getState()) === value
}

/**
 * Makes the client hold `target`, as a whole or not at all.
 *
 * Each field that differs goes through its own setter, so it passes the same
 * guards and reaches main the same way an edit does. A connection field that
 * differs while a connection stands is refused before anything is written,
 * because its setter would refuse it after the others had gone in. When main
 * refuses a field or the mapping, the fields already written are put back, so
 * a refusal leaves the client as it was. It still costs read configuration,
 * which `replaceRegisterMapping` turns off before it asks.
 */
export const writeClientConfiguration = async (
  target: ClientConfiguration
): Promise<'done' | 'refused' | 'refused-connected'> => {
  const before = useClientZustand.getState()
  const targetState: ClientZustand = {
    ...before,
    connectionConfig: target.connectionConfig,
    registerConfig: target.registerConfig
  }
  const changed = CONFIGURATION_FIELDS.filter(
    (field) => clientFieldReaders[field](targetState) !== clientFieldReaders[field](before)
  )
  if (!isDisconnected() && changed.some((field) => CONNECTION_FIELDS.has(field))) {
    return 'refused-connected'
  }

  const written: ClientField[] = []
  const putBack = async (): Promise<'refused'> => {
    for (const field of written.reverse()) await writeFieldFrom(field, before)
    return 'refused'
  }

  for (const field of changed) {
    written.push(field)
    if (!(await writeFieldFrom(field, targetState))) return putBack()
  }
  if (!(await useClientZustand.getState().replaceRegisterMapping(target.registerMapping))) {
    return putBack()
  }
  useClientZustand.getState().setName(target.name)
  showMapping()
  return 'done'
}

/** Puts back what Load or Clear Config replaced, as a whole or not at all. */
const replayConfiguration = async (
  step: ClientConfigurationStep
): Promise<ClientConfigurationStep | UndoRefusal | undefined> => {
  const replaced: ClientConfigurationStep = { kind: 'configuration', value: currentConfiguration() }
  const outcome = await writeClientConfiguration(step.value)
  if (outcome === 'refused-connected') return outcome
  return outcome === 'done' ? replaced : undefined
}

const replay = (step: ClientUndoStep): Promise<ClientUndoStep | UndoRefusal | undefined> => {
  switch (step.kind) {
    case 'field':
      return replayField(step)
    case 'mapping':
      return replayMapping(step)
    case 'configuration':
      return replayConfiguration(step)
  }
}

const clientStack = {
  read: (): UndoStack<ClientUndoStep> => useUndoZustand.getState().client,
  write: (stack: UndoStack<ClientUndoStep>): void => useUndoZustand.getState().setClient(stack)
}

const move = (direction: 'undo' | 'redo'): Promise<UndoOutcome> =>
  replayTop(clientStack, direction, replay)

export const undoClient = (): Promise<UndoOutcome> => move('undo')
export const redoClient = (): Promise<UndoOutcome> => move('redo')

/**
 * Runs an action that replaces the configuration, and records it as one step.
 *
 * Load writes the name, the connection and register config and the mapping,
 * and Clear Config the name and the mapping. Each setter would record its own
 * step; quiet while the action runs, they record none, and the step recorded
 * after carries all of them as they were. That step goes on the stack directly rather than through
 * `recordClient`, which would drop it while an undo that started first is
 * still quiet.
 */
export const asOneClientStep = async (action: () => Promise<void>): Promise<void> => {
  const before = currentConfiguration()
  const undo = useUndoZustand.getState()
  undo.beginQuiet()
  try {
    await action()
  } finally {
    // In the `finally`, because a Load that throws after the name and the byte
    // order went in has still changed them.
    undo.endQuiet()
    // By content, because Clear Config hands over a new empty mapping every
    // time, and one that was empty already is no step.
    if (!deepEqual(currentConfiguration(), before)) {
      const step: ClientConfigurationStep = { kind: 'configuration', value: before }
      undo.setClient(pushStep(useUndoZustand.getState().client, step, clientStepKey(step)))
    }
  }
}
