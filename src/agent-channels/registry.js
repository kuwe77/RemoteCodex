import TelegramChannelProvider from './providers/telegram-provider.js';

function buildProviderDescriptor(provider) {
  return {
    id: provider.id,
    label: provider.label || provider.id,
    capabilities: provider.capabilities || {},
    configFields: Array.isArray(provider.configFields) ? provider.configFields : []
  };
}

export class AgentChannelRegistry {
  constructor() {
    this.providers = new Map();
  }

  register(provider) {
    if (!provider?.id) {
      throw new Error('Channel provider id is required');
    }
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(providerId) {
    return this.providers.get(String(providerId || '')) || null;
  }

  list() {
    return [...this.providers.values()].map((provider) => buildProviderDescriptor(provider));
  }
}

export function createDefaultAgentChannelRegistry() {
  const registry = new AgentChannelRegistry();
  registry.register(new TelegramChannelProvider());
  return registry;
}

export const agentChannelRegistry = createDefaultAgentChannelRegistry();

export default agentChannelRegistry;
