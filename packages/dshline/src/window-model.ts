/** Window defaults and the currently attached Agent's native model authority. */
import type { Model, ModelSelection } from '@deepseek-ai/dsh-agent'

/** Keep launch defaults across attachments without owning a Session's route. */
export class WindowModel implements Model {
  private attached: { readonly model: Model } | undefined

  /**
   * @param fallback - launch default until an Agent is attached.
   */
  constructor(private fallback: Readonly<ModelSelection> | undefined) {}

  /** @returns the attached Agent's choice, or the launch default before attachment. */
  current(): Readonly<ModelSelection> | undefined {
    return this.attached === undefined
      ? this.fallback === undefined ? undefined : { ...this.fallback }
      : this.attached.model.current()
  }

  /**
   * Record an attached Session's choice through Harness before changing defaults.
   * @param selection - complete choice for future steps.
   */
  select(selection: Readonly<ModelSelection>): void {
    this.attached?.model.select(selection)
    this.fallback = { ...selection }
  }

  /**
   * Bind one unpublished Agent's model until its scope is released.
   * @param model - native Agent model authority.
   * @returns an identity-guarded release for that attachment only.
   */
  bind(model: Model): () => void {
    const binding = { model }
    this.attached = binding
    return () => { if (this.attached === binding) this.attached = undefined }
  }
}
