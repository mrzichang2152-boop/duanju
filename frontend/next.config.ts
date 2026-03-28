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
      {
        protocol: "https",
        hostname: "openpt.wuyinkeji.com",
      },
      {
        protocol: "https",
        hostname: "**.myqcloud.com",
      },
      {
        protocol: "http",
        hostname: "**.myqcloud.com",
      },
    ],
    dangerouslyAllowSVG: true,
  },
  async rewrites() {
    const backendUrl =
      process.env.BACKEND_URL ||
      (process.env.NODE_ENV === "development" ? "http://localhost:8003" : "http://backend:8000");
    return [
      {
        source: "/static/:path*",
        destination: `${backendUrl}/static/:path*`,
      },
      {
        source: "/api/:path*",
        destination: `${backendUrl}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
