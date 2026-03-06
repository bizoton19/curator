export type AppConfig = {
  modelName?: string;
  apiKey?: string;
};

export class ConfigManager {
  private config: AppConfig = {};

  get(): AppConfig {
    return this.config;
  }

  set(next: AppConfig) {
    this.config = { ...this.config, ...next };
  }
}
