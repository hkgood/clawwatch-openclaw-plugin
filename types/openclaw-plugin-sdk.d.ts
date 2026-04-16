/**
 * 最小类型桩：真实类型由运行环境中的 `openclaw` 提供。
 * 本包不把 `openclaw` 列入 devDependencies，避免其传递依赖通过 git+ssh 拉取
 *（例如 libsignal-node）导致无 SSH 密钥时 `npm install` 失败。
 */
declare module 'openclaw/plugin-sdk/plugin-entry' {
  export type OpenClawPluginServiceContext = {
    logger: {
      info: (msg: string) => void;
      warn: (msg: string) => void;
      error: (msg: string) => void;
    };
  };

  export type OpenClawPluginApi = {
    id: string;
    name: string;
    description?: string;
    version?: string;
    rootDir?: string;
    pluginConfig?: Record<string, unknown>;
    logger: OpenClawPluginServiceContext['logger'];
    registerService: (service: {
      id: string;
      start: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
      stop?: (ctx: OpenClawPluginServiceContext) => void | Promise<void>;
    }) => void;
  };

  export function definePluginEntry(options: {
    id: string;
    name: string;
    description: string;
    configSchema?: Record<string, unknown>;
    register: (api: OpenClawPluginApi) => void | Promise<void>;
  }): unknown;
}
