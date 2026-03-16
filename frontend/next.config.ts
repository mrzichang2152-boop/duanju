import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  /* config options here */
  reactCompiler: true,
  images: {
    remotePatterns: [
      {
        protocol: "https",
        hostname: "**.volces.com",
      },
      {
        protocol: "https",
        hostname: "ark-content-generation.volces.com",
      },
      {
        protocol: "https",
        hostname: "p16-ard-sg.volces.com",
      },
      {
        protocol: "https",
        hostname: "p16-flow-sign-sg.volces.com",
      },
      {
        protocol: "https",
        hostname: "p16-flow-image-sg.volces.com",
      },
    ],
    dangerouslyAllowSVG: true,
  },
  async rewrites() {
    return [
      {
        source: "/static/:path*",
        destination: "http://localhost:8002/static/:path*",
      },
      {
        source: "/api/:path*",
        destination: "http://localhost:8002/api/:path*",
      },
    ];
  },
};

export default nextConfig;
