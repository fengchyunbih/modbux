import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'

/** What a successful import carries, whichever file it read. */
interface ImportNotesInput {
  migrated: boolean
  fromVersion: number
  wasMixedEndianness?: boolean
  futureVersion?: { fields: string[]; savedByNewerVersion: boolean }
}

/** The things an agent should hear about an import that went through. */
export const importNotes = (result: ImportNotesInput): string[] => {
  const notes: string[] = []
  if (result.migrated) notes.push(`The file was version ${result.fromVersion} and was migrated.`)
  if (result.wasMixedEndianness) {
    notes.push('The file had mixed byte order settings. Verify the byte order.')
  }
  const { futureVersion } = result
  if (futureVersion?.savedByNewerVersion) {
    notes.push('The file was saved by a newer version of Modbux.')
  }
  if (futureVersion && futureVersion.fields.length > 0) {
    notes.push(`These fields could not be read and were reset: ${futureVersion.fields.join(', ')}.`)
  }
  return notes
}

/** A text result holding `text` as it is, for a tool that answers a file. */
export const fileResult = (text: string): CallToolResult => ({
  content: [{ type: 'text', text }]
})
