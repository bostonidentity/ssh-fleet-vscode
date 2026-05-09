export type {
  AuthConfig,
  ServerConfig,
  TaskConfig,
  WarnPattern,
  AutoBackupConfig,
  DestCheckConfig,
  SafetyConfig,
  SettingsConfig,
  AppConfig
} from './schema.js';

export type ConnectionState = 'idle' | 'connecting' | 'connected' | 'error';

export interface ServerStatus {
  state: ConnectionState;
  errorMessage?: string;
  connectedAt?: number;
}
