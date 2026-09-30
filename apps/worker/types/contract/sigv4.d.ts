// Type-check stand-in for packages/shared/src/sigv4.ts (A-shared), exactly the BUILD-CONTRACT.md
// section 11 API. tsconfig `paths` lists the real file first, so once it exists this stub is never
// resolved and the real signatures check the worker's calls. Delete this file after the merge.

export type SigV4Credentials = {
  endpoint: string;
  region: string;
  accessKeyId: string;
  secretAccessKey: string;
};

export declare function presignPut(
  input: SigV4Credentials & { bucket: string; key: string; expiresSeconds: number; now?: Date },
): { url: string; expiresAt: Date | string };

export declare function signRequest(
  input: SigV4Credentials & {
    method: 'GET' | 'HEAD' | 'PUT' | 'DELETE';
    bucket: string;
    key: string;
    query?: Record<string, string>;
    headers?: Record<string, string>;
    body?: Uint8Array;
    now?: Date;
  },
): { url: string; headers: Record<string, string> };
