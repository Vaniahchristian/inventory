import type { NextConfig } from "next"

const nextConfig: NextConfig = {
  turbopack: {
    root: __dirname,
  },
  webpack: (config) => {
    // pdfjs-dist needs canvas as optional
    config.resolve.alias.canvas = false
    return config
  },
}

export default nextConfig
