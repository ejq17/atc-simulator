/** Contracts shared by the neural TTS provider, its synthesiser backends and the Settings form. */

export interface PcmAudio {
  samples: Float32Array;
  sampleRate: number;
}

export interface SynthesisRequest {
  text: string;
  /** Engine voice: a Kokoro voice id such as `am_michael`, or a Piper speaker number as a string. */
  voice: string;
  /** Speaking speed multiplier handed to the model (1 = the voice's natural pace). */
  speed: number;
}

export type NeuralPhase = 'idle' | 'downloading' | 'loading' | 'ready' | 'error';

export interface NeuralProgress {
  phase: NeuralPhase;
  /** 0..100 across all model files seen so far (best effort). */
  percent: number;
  message: string;
  /** Device the loaded model runs on, once known. */
  device?: 'wasm' | 'webgpu';
  error?: Error;
}

/** A text-to-PCM engine. The real one runs Kokoro in a worker; tests pass a mock. */
export interface NeuralSynth {
  /** Start (or join) the model download/initialisation. Resolves when ready, rejects on failure. */
  ensureLoaded(): Promise<void>;
  isReady(): boolean;
  /** Which voice family is loaded ('kokoro' on WebGPU, 'piper' on WebAssembly); speaker choice depends on it. Absent = 'kokoro'. */
  getEngine?(): 'kokoro' | 'piper' | null;
  synthesize(req: SynthesisRequest): Promise<PcmAudio>;
  getProgress(): NeuralProgress;
  /** Replays the current state, returns an unsubscribe function. */
  onProgress(listener: (p: NeuralProgress) => void): () => void;
  /** Release the worker and the loaded model. */
  dispose(): void;
}
