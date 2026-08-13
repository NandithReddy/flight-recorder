/**
 * In-memory tracing, for asserting that the recorder emits real OTel spans.
 *
 * Production never calls this: the host application registers its own provider
 * and our spans flow there. Without any provider registered the OTel API is a
 * no-op, which is exactly what we want by default — instrumentation that costs
 * nothing until somebody collects it.
 */

import { NodeTracerProvider } from "@opentelemetry/sdk-trace-node";
import {
  InMemorySpanExporter,
  SimpleSpanProcessor,
  type ReadableSpan,
} from "@opentelemetry/sdk-trace-base";
import type { Tracer } from "@opentelemetry/api";
import { TRACER_NAME, TRACER_VERSION } from "./conventions.ts";

export interface CapturedTracing {
  tracer: Tracer;
  spans(): ReadableSpan[];
  reset(): void;
  shutdown(): Promise<void>;
}

export function captureTracing(): CapturedTracing {
  const exporter = new InMemorySpanExporter();
  const provider = new NodeTracerProvider({
    spanProcessors: [new SimpleSpanProcessor(exporter)],
  });

  return {
    tracer: provider.getTracer(TRACER_NAME, TRACER_VERSION),
    spans: () => exporter.getFinishedSpans(),
    reset: () => exporter.reset(),
    shutdown: async () => {
      await provider.shutdown();
    },
  };
}
