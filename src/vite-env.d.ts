/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_FREE_MULTI_REF_V2_ENABLED?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
