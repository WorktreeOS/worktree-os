// Configure Monaco workers before any monaco-editor module is imported.
// The basic file editor only needs the main-thread Monarch tokenizer for
// syntax highlighting; advanced language-server features are not used here,
// so a no-op stub worker is enough to satisfy MonacoEnvironment without
// shipping the per-language worker bundles.
declare global {
  interface Window {
    MonacoEnvironment?: {
      getWorker?: (workerId: string, label: string) => Worker;
      getWorkerUrl?: (workerId: string, label: string) => string;
    };
  }
}

if (typeof self !== "undefined" && !self.MonacoEnvironment) {
  const workerSource = "self.onmessage = () => {};";
  const workerUrl = URL.createObjectURL(
    new Blob([workerSource], { type: "application/javascript" }),
  );
  self.MonacoEnvironment = {
    getWorker: () => new Worker(workerUrl),
  };
}

export {};
