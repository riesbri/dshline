/**
 * Commands that belong to this terminal frontend rather than the shared harness.
 *
 * The harness registry is shared by every surface in a process. These commands
 * can therefore be completed beside it without being registered into it.
 * @module dshline/local-commands
 */

/** A value one local command can complete after its name. */
export interface LocalCommandChoice {
  /** Text inserted as the command argument. */
  readonly value: string
  /** Optional explanation shown beside the value. */
  readonly note?: string
  /**
   * Additional text a typed prefix may match without ever being inserted.
   *
   * A value that qualifies its subject — `provider/model`, where the command
   * also accepts a bare `model` — would otherwise stop matching the short
   * spelling a reader actually types. An alias is a visible-domain search
   * domain, not a second candidate: matching one offers the same row, and
   * accepting it inserts the canonical `value`.
   */
  readonly aliases?: readonly string[]
}

/** One command this terminal frontend handles itself. */
export interface LocalCommand {
  /** Name without the leading slash. */
  readonly name: string
  /** Summary shown in the slash-command completion list. */
  readonly description: string
  /**
   * Values available for the command's one-word argument.
   * @returns the currently available values, synchronously or asynchronously.
   */
  complete?(): readonly LocalCommandChoice[] | Promise<readonly LocalCommandChoice[]>
  /**
   * Handle the text after the command name.
   * @param rawInput - exactly what followed the command name in the submitted line.
   * @returns when handling is complete, synchronously or asynchronously.
   */
  execute(rawInput: string): void | Promise<void>
}

/** Finds, completes, and dispatches the terminal's own commands. */
export class LocalCommandRegistry {
  /**
   * @param commands - commands owned by this terminal frontend.
   */
  constructor(private readonly commands: readonly LocalCommand[]) {}

  /**
   * Command summaries suitable for the shared completion list.
   * @returns names and descriptions, in registration order.
   */
  list(): readonly { readonly name: string; readonly description: string }[] {
    return this.commands.map(({ name, description }) => ({ name, description }))
  }

  /**
   * Find one local command.
   * @param name - command name without its leading slash.
   * @returns the command, or undefined when the harness should handle the name.
   */
  get(name: string): LocalCommand | undefined {
    return this.commands.find(command => command.name === name)
  }

  /**
   * Complete one local command's argument.
   * @param name - command name without its leading slash.
   * @returns offered values, or none when the command is not local or has none.
   */
  async arguments(name: string): Promise<readonly LocalCommandChoice[]> {
    const complete = this.get(name)?.complete
    return complete === undefined ? [] : await complete()
  }

  /**
   * Run one local command when this registry owns it.
   * @param name - command name without its leading slash.
   * @param rawInput - exactly what followed the command name in the submitted line.
   * @returns whether this terminal frontend handled the command.
   */
  async execute(name: string, rawInput: string): Promise<boolean> {
    const command = this.get(name)
    if (command === undefined) return false
    await command.execute(rawInput)
    return true
  }
}
