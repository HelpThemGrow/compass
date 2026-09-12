import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // These packages do filesystem/native work (ONNX runtime, zip/XML
  // manipulation) that Next's default bundling for Route Handlers doesn't
  // handle well - keeping them external and resolved via normal Node
  // `require` at runtime avoids bundler-rewrite issues (dynamic requires,
  // native .node bindings, WASM asset loading).
  serverExternalPackages: [
    "@xenova/transformers",
    "onnxruntime-node",
    "jszip",
    "@xmldom/xmldom",
    "xlsx",
    "pdf-parse",
  ],
};

export default nextConfig;
