/** @type {import('next').NextConfig} */
const nextConfig = {
  transpilePackages: ["@prediction-market-scanner/core", "@prediction-market-scanner/db"]
};

export default nextConfig;
