/** @type {import('next').NextConfig} */
// Two backends sit behind same-origin rewrites:
//   /api/*      -> your own data (finance.db), default http://localhost:8000
//   /demo-api/* -> test data mode (demo.db),   default http://localhost:8001
// A public portfolio build should set NEXT_PUBLIC_TEST_ONLY=1, which also
// drops the /api rewrite so real data can't be reached through it.
const nextConfig = {
  reactStrictMode: true,
  async rewrites() {
    const own = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000";
    const demo = process.env.NEXT_PUBLIC_DEMO_API_URL || "http://localhost:8001";
    const testOnly = process.env.NEXT_PUBLIC_TEST_ONLY === "1";
    const rules = [
      { source: "/demo-api/:path*", destination: `${demo}/api/:path*` },
    ];
    if (!testOnly) {
      rules.push({ source: "/api/:path*", destination: `${own}/api/:path*` });
    }
    return rules;
  },
};

module.exports = nextConfig;
