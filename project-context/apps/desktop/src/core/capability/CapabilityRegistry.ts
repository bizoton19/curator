import { Capability } from "./Capability";

export class CapabilityRegistry {
  private items = new Map<string, Capability>();

  register(capability: Capability) {
    this.items.set(capability.id, capability);
  }

  list(): Capability[] {
    return Array.from(this.items.values());
  }

  get(id: string): Capability | undefined {
    return this.items.get(id);
  }
}
