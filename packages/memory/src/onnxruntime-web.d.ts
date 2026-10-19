/**
 * Minimal ambient declaration for `onnxruntime-web`.
 *
 * The package ships its types at the package root but does not expose them
 * through its `exports` map, so TypeScript (with the workspace's
 * `moduleResolution: bundler`) cannot resolve them. Declaring exactly the
 * surface this package uses keeps the import typed without a `@ts-expect-error`;
 * actual runtime behaviour is covered by the golden-vector and end-to-end tests.
 */
declare module 'onnxruntime-web' {
  export type TensorData = Float32Array | BigInt64Array;

  export class Tensor {
    public constructor(type: 'float32' | 'int64', data: TensorData, dims: readonly number[]);
    public readonly data: TensorData;
    public readonly dims: readonly number[];
  }

  export type SessionRunResult = Record<string, Tensor>;

  export interface Session {
    run(feeds: Record<string, Tensor>): Promise<SessionRunResult>;
  }

  export const InferenceSession: {
    create(
      model: Uint8Array,
      options?: { readonly executionProviders?: readonly string[] },
    ): Promise<Session>;
  };

  export const env: {
    readonly wasm: { numThreads: number; wasmPaths: string };
    logLevel: string;
  };
}
