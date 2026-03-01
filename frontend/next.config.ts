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
};

export default nextConfig;
