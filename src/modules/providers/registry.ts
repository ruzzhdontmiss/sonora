import { ProviderType } from "@prisma/client";
import { MusicProviderAdapter } from "./contracts/adapter.interface";
import { ProviderCapabilities } from "./contracts/types";
import { UnsupportedOperationError } from "@/modules/common/errors";

class ProviderAdapterRegistry {
  private adapters = new Map<ProviderType, MusicProviderAdapter>();

  /**
   * Registers a provider adapter.
   */
  public register(adapter: MusicProviderAdapter): void {
    this.adapters.set(adapter.provider, adapter);
  }

  /**
   * Retrieves an adapter by provider type.
   * Throws UnsupportedOperationError if no adapter is registered for this provider.
   */
  public get(provider: ProviderType): MusicProviderAdapter {
    const adapter = this.adapters.get(provider);
    if (!adapter) {
      throw new UnsupportedOperationError(
        provider,
        "ADAPTER_LOOKUP",
        `No adapter registered for provider ${provider}.`
      );
    }
    return adapter;
  }

  /**
   * Checks whether an adapter is registered.
   */
  public has(provider: ProviderType): boolean {
    return this.adapters.has(provider);
  }

  /**
   * Asserts that a provider adapter is registered and supports a specific capability.
   * Fails fast with typed UnsupportedOperationError if unsupported.
   */
  public assertCapability(
    provider: ProviderType,
    capability: keyof ProviderCapabilities
  ): MusicProviderAdapter {
    const adapter = this.get(provider);
    const capabilities = adapter.getCapabilities();

    if (!capabilities[capability]) {
      throw new UnsupportedOperationError(
        provider,
        String(capability),
        `Provider ${provider} does not support capability ${String(capability)}.`
      );
    }

    return adapter;
  }
}

export const providerRegistry = new ProviderAdapterRegistry();

